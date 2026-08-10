import type { SqlClient, SqlRow } from '../activity/postgres-repository.js';
import type {
  AgentAction, AgentDashboard, AgentQuestion, AgentRepository, AgentScope, AnswerResult, AutonomyResult, AutonomyScope,
  AutonomyState, RetryResult,
} from './contracts.js';

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const healthMessage = (row: SqlRow): string => {
  const reason = text(row['reason_code']) || text(row['last_error_code']);
  if (reason === 'provider_auth_failed') return 'Mailbox authentication expired. Reconnect this mailbox in More → Settings.';
  if (reason === 'provider_rate_limited') return 'The mail provider is rate limiting requests. Hypermail will retry automatically.';
  if (reason === 'provider_unavailable') return 'The mail provider is temporarily unavailable. Hypermail will retry automatically.';
  return text(row['detail']) || reason || 'Account connection needs attention.';
};
const scoped = (column: string, parameter: number): string => `${column} = ANY($${String(parameter)}::uuid[])`;
const accountVersion = (row: SqlRow): number => {
  const value = row['updated_at'];
  const milliseconds = value instanceof Date ? value.getTime() : new Date(text(value)).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Account update timestamp is invalid.');
  return Math.max(1, Math.floor(milliseconds));
};
const auditAnswer = (row: SqlRow): string | undefined => {
  const metadata = row['metadata'];
  if (metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>)['answer'] === 'string') return (metadata as Record<string, string>)['answer'];
  if (typeof metadata !== 'string') return undefined;
  try { const parsed: unknown = JSON.parse(metadata); return parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['answer'] === 'string' ? (parsed as Record<string, string>)['answer'] : undefined; } catch { return undefined; }
};
class AutonomyUpdateConflict extends Error { constructor(readonly version: number) { super('Autonomy update conflicted.'); } }
const question = (row: SqlRow): AgentQuestion => ({
  id: text(row['id']), accountId: text(row['account_id']), version: Number(row['version']), prompt: text(row['prompt']), state: text(row['state']) as AgentQuestion['state'],
});
const action = (row: SqlRow): AgentAction => {
  const state = text(row['state']);
  const verification = text(row['verification_state']);
  const status = state === 'succeeded' ? 'completed' : state === 'planned' || state === 'executing' ? 'proposed' : verification === 'pending' ? 'blocked' : 'failed';
  const recoverable = text(row['kind']) === 'recoverable_trash' && state === 'succeeded';
  return {
    id: text(row['id']), accountId: text(row['account_id']), version: Number(row['version']),
    title: text(row['kind']).replaceAll('_', ' '), reason: text(row['rationale']), status,
    ...(row['outcome'] == null ? {} : { outcome: text(row['outcome']) }),
    ...(row['verification_state'] == null ? {} : { verification: verification === 'verified' ? 'Verified.' : verification.replaceAll('_', ' ') }),
    recoverable, ...(recoverable ? { reversalHref: `/activity/${text(row['activity_id'])}/reversal` } : {}),
    ...(row['question_id'] == null ? {} : { questionId: text(row['question_id']) }),
  };
};

/** Injected, account-scoped PostgreSQL implementation for the Agent dashboard. */
export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly sql: SqlClient) {}

  async dashboard(scope: AgentScope): Promise<AgentDashboard> {
    const [actionRows, questionRows, alertRows, accountRows] = await Promise.all([
      this.sql.query(`SELECT ac.id, ac.activity_id, a.account_id, a.version, ac.kind, ac.state, d.rationale,
          q.id AS question_id, v.state AS verification_state,
          COALESCE(ac.error_code, receipt.metadata->>'message') AS outcome
        FROM app.actions ac
        JOIN app.activities a ON a.id = ac.activity_id
        JOIN app.decisions d ON d.id = ac.decision_id
        LEFT JOIN LATERAL (SELECT q.id FROM app.questions q WHERE q.activity_id = a.id AND q.state = 'open' ORDER BY q.created_at DESC LIMIT 1) q ON true
        LEFT JOIN LATERAL (SELECT state FROM app.action_verifications WHERE action_id = ac.id ORDER BY attempt DESC LIMIT 1) v ON true
        LEFT JOIN LATERAL (SELECT metadata FROM app.audits WHERE activity_id = a.id AND event LIKE 'policy.action_%' ORDER BY occurred_at DESC LIMIT 1) receipt ON true
        WHERE ${scoped('a.account_id', 1)} ORDER BY ac.created_at DESC, ac.id DESC`, [scope.accountIds]),
      this.sql.query(`SELECT q.id, a.account_id, a.version, q.prompt, q.state
        FROM app.questions q JOIN app.activities a ON a.id = q.activity_id
        WHERE ${scoped('a.account_id', 1)} AND q.state IN ('open', 'answered') ORDER BY q.created_at DESC, q.id DESC`, [scope.accountIds]),
      this.sql.query(`SELECT ah.account_id, ah.state AS health_state, ah.detail, ah.reason_code, ps.consecutive_failures, ps.last_error_code,
          ac.autonomy_paused_at
        FROM app.accounts ac
        LEFT JOIN app.account_health ah ON ah.account_id = ac.id
        LEFT JOIN app.poll_states ps ON ps.account_id = ac.id
        WHERE ${scoped('ac.id', 1)}`, [scope.accountIds]),
      this.sql.query(`SELECT id, autonomy_paused_at, updated_at FROM app.accounts WHERE ${scoped('id', 1)} ORDER BY id`, [scope.accountIds]),
    ]);
    const alerts = alertRows.rows.flatMap((row) => {
      const accountId = text(row['account_id']);
      const items: AgentDashboard['alerts'][number][] = [];
      if (row['health_state'] && row['health_state'] !== 'healthy' && row['health_state'] !== 'paused') items.push({ id: `health:${accountId}`, kind: 'account_health', accountId, message: healthMessage(row) });
      if (Number(row['consecutive_failures']) > 0) items.push({ id: `poll:${accountId}`, kind: 'poll_failure', accountId, message: `Polling is retrying${row['last_error_code'] ? ` (${text(row['last_error_code'])})` : ''}; previous results remain visible.` });
      if (row['autonomy_paused_at'] || row['health_state'] === 'paused') items.push({ id: `pause:${accountId}`, kind: 'safety_pause', accountId, message: 'Safety pause is active.' });
      return items;
    });
    const accounts = Object.fromEntries(accountRows.rows.map((row) => [text(row['id']), { state: row['autonomy_paused_at'] ? 'paused' : 'running', version: accountVersion(row) }] as const));
    const allPaused = accountRows.rows.length > 0 && accountRows.rows.every((row) => Boolean(row['autonomy_paused_at']));
    const globalVersion = Math.max(1, ...accountRows.rows.map(accountVersion));
    return { actions: actionRows.rows.map(action), questions: questionRows.rows.map(question), alerts, autonomy: { global: { state: allPaused ? 'paused' : 'running', version: globalVersion }, accounts } }; 
  }

  async answerQuestion(scope: AgentScope, questionId: string, answerText: string, expectedVersion: number, idempotencyKey: string): Promise<AnswerResult> {
    return this.sql.transaction(async (sql) => {
      const current = await sql.query(`SELECT q.id, q.activity_id, q.prompt, q.state, a.account_id, a.version
        FROM app.questions q JOIN app.activities a ON a.id = q.activity_id
        WHERE q.id = $1::uuid AND ${scoped('a.account_id', 2)} FOR UPDATE`, [questionId, scope.accountIds]);
      const row = current.rows[0];
      if (!row) return { kind: 'not_found' };
      const replay = await sql.query(`SELECT id, metadata FROM app.audits WHERE activity_id = $1::uuid AND event = 'agent.question_answered' AND correlation_id = $2 FOR UPDATE`, [text(row['activity_id']), this.answerCorrelation(questionId, idempotencyKey)]);
      if (replay.rows[0]) {
        if (auditAnswer(replay.rows[0]) !== answerText) return { kind: 'conflict', currentVersion: Number(row['version']) };
        return { kind: 'duplicate', question: question(row) };
      }
      if (Number(row['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(row['version']) };
      if (row['state'] !== 'open') return { kind: 'conflict', currentVersion: Number(row['version']) };
      const updated = await sql.query(`UPDATE app.questions SET state = 'answered', answer = $1, answered_at = now(), updated_at = now() WHERE id = $2::uuid AND state = 'open' RETURNING id`, [answerText, questionId]);
      if (!updated.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const activity = await sql.query(`UPDATE app.activities SET state = 'new', version = version + 1, updated_at = now() WHERE id = $1::uuid AND ${scoped('account_id', 2)} AND version = $3 RETURNING version`, [text(row['activity_id']), scope.accountIds, expectedVersion]);
      if (!activity.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const version = Number(activity.rows[0]['version']);
      await sql.query(`INSERT INTO app.agent_jobs (activity_id, idempotency_key, state, attempt, available_at, created_at, updated_at) VALUES ($1::uuid, $2, 'pending', 0, now(), now(), now()) ON CONFLICT (activity_id) DO UPDATE SET state = 'pending', available_at = now(), updated_at = now()`, [text(row['activity_id']), `question-answer:${questionId}:${String(version)}`]);
      await this.audit(sql, scope, text(row['activity_id']), text(row['account_id']), 'agent.question_answered', this.answerCorrelation(questionId, idempotencyKey), { questionId, idempotencyKey, answer: answerText });
      return { kind: 'answered', question: { ...question(row), state: 'answered', version } };
    });
  }

  async retryAction(scope: AgentScope, actionId: string, expectedVersion: number): Promise<RetryResult> {
    return this.sql.transaction(async (sql) => {
      const found = await sql.query(`SELECT ac.id, ac.activity_id, ac.account_id, a.version, ac.kind, ac.state, d.rationale,
          EXISTS (SELECT 1 FROM app.questions q WHERE q.activity_id = a.id AND q.state = 'open') AS open_question
        FROM app.actions ac JOIN app.activities a ON a.id = ac.activity_id JOIN app.decisions d ON d.id = ac.decision_id
        WHERE ac.id = $1::uuid AND ${scoped('a.account_id', 2)} FOR UPDATE`, [actionId, scope.accountIds]);
      const row = found.rows[0];
      if (!row) return { kind: 'not_found' };
      if (Number(row['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(row['version']) };
      if (row['open_question'] === true || row['open_question'] === 'true') return { kind: 'blocked', reason: 'Answer the open question before retrying this action.' };
      if (!['failed', 'unverifiable', 'incorrect'].includes(text(row['state']))) return { kind: 'blocked', reason: 'Only a failed, unverifiable, or incorrect action can be retried.' };
      const updated = await sql.query(`UPDATE app.activities SET state = 'new', version = version + 1, updated_at = now() WHERE id = $1::uuid AND ${scoped('account_id', 2)} AND version = $3 RETURNING version`, [text(row['activity_id']), scope.accountIds, expectedVersion]);
      if (!updated.rows[0]) return { kind: 'conflict', currentVersion: Number(row['version']) };
      const version = Number(updated.rows[0]['version']);
      await sql.query(`INSERT INTO app.agent_jobs (activity_id, idempotency_key, state, attempt, available_at, last_error_code, queue_job_id, created_at, updated_at) VALUES ($1::uuid, $2, 'pending', 0, now(), NULL, NULL, now(), now()) ON CONFLICT (activity_id) DO UPDATE SET state = 'pending', attempt = app.agent_jobs.attempt + 1, available_at = now(), last_error_code = NULL, queue_job_id = NULL, updated_at = now()`, [text(row['activity_id']), `agent-action-retry:${actionId}:${String(version)}`]);
      await this.audit(sql, scope, text(row['activity_id']), text(row['account_id']), 'agent.action_retry_requested', `agent-action-retry:${actionId}:${String(version)}`, { actionId, version });
      return { kind: 'queued', action: action({ ...row, version, verification_state: null }) };
    });
  }

  async setAutonomy(scope: AgentScope, target: AutonomyScope, state: AutonomyState, expectedVersion: number): Promise<AutonomyResult> {
    try {
      return await this.sql.transaction(async (sql) => {
        const ids = target.kind === 'global' ? scope.accountIds : [target.accountId];
        const locked = await sql.query(`SELECT id, updated_at FROM app.accounts WHERE ${scoped('id', 1)} FOR UPDATE`, [ids]);
        if (locked.rows.length !== ids.length) return { kind: 'not_found' };
        const version = Math.max(...locked.rows.map(accountVersion));
        if (version !== expectedVersion) return { kind: 'conflict', currentVersion: version };
        const updated = await sql.query(`UPDATE app.accounts SET autonomy_paused_at = CASE WHEN $1::boolean THEN now() ELSE NULL END, autonomy_pause_reason = CASE WHEN $1::boolean THEN 'user' ELSE NULL END, updated_at = now() WHERE ${scoped('id', 2)} AND floor(extract(epoch FROM updated_at) * 1000)::bigint = $3::bigint RETURNING id`, [state === 'paused', ids, expectedVersion]);
        if (updated.rows.length !== ids.length) throw new AutonomyUpdateConflict(version);
        for (const row of locked.rows) await this.audit(sql, scope, '', text(row['id']), state === 'paused' ? 'agent.autonomy_paused' : 'agent.autonomy_resumed', `agent-autonomy:${target.kind}:${text(row['id'])}:${String(expectedVersion)}`, { target: target.kind, state });
        return { kind: 'updated', state };
      });
    } catch (error) {
      if (error instanceof AutonomyUpdateConflict) return { kind: 'conflict', currentVersion: error.version };
      throw error;
    }
  }

  private answerCorrelation(questionId: string, idempotencyKey: string): string { return `agent-question-answer:${questionId}:${idempotencyKey}`; }
  private audit(sql: SqlClient, scope: AgentScope, activityId: string, accountId: string, event: string, correlationId: string, metadata: Record<string, unknown>): Promise<unknown> {
    return sql.query(`INSERT INTO app.audits (actor_type, actor_id, account_id, activity_id, event, correlation_id, metadata) VALUES ('user', $1, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6::jsonb)`, [scope.subjectId, accountId, activityId, event, correlationId, JSON.stringify(metadata)]);
  }
}
