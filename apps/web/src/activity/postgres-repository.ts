import {
  acknowledgementBlockReason, type ActivityJobState, type ActivityListInput, type ActivityMutationResult,
  type ActivityPage, type ActivityRecord, type ActivityRepository, type AuthenticatedActivityScope,
} from './contracts.js';

export type SqlRow = Record<string, unknown>;
export type SqlQueryResult<Row extends SqlRow = SqlRow> = Readonly<{ rows: readonly Row[] }>;
/** Minimal database port; the application supplies its PostgreSQL driver. */
export interface SqlClient {
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

type Cursor = Readonly<{ createdAt: string; id: string }>;
const encodeCursor = (activity: ActivityRecord): string => encodeURIComponent(`${activity.createdAt}|${activity.id}`);
const decodeCursor = (cursor: string): Cursor | null => {
  const [createdAt, id, extra] = decodeURIComponent(cursor).split('|');
  return createdAt && id && extra === undefined ? { createdAt, id } : null;
};
const timestamp = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const json = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
const array = (value: unknown): readonly SqlRow[] => Array.isArray(json(value)) ? json(value) as readonly SqlRow[] : [];

const projection = `
  SELECT COALESCE(ca.id,a.id) AS id, COALESCE(ca.account_id,a.account_id) AS account_id, COALESCE(ca.source_message_id,a.message_id) AS message_id,
    CASE ca.state WHEN 'open' THEN 'new' WHEN 'waiting_for_answer' THEN 'waiting_question'
      WHEN 'resolved' THEN 'handled' WHEN 'attention_required' THEN 'failed' WHEN 'acknowledged' THEN 'acknowledged'
      ELSE a.state::text END AS state,
    COALESCE(ca.revision,a.version) AS version, COALESCE(ca.created_at,a.created_at) AS created_at,
    COALESCE(ca.updated_at,a.updated_at) AS updated_at,
    COALESCE(m.subject,m.preview,CASE WHEN ca.kind='interactive_request' THEN 'Interactive request' ELSE 'Agent activity' END) AS title,
    COALESCE(ac.display_name, ac.email) AS account_label,
    COALESCE(m.sender->>'name', m.sender->>'address', m.subject, m.preview, CASE WHEN ca.kind='interactive_request' THEN 'Interactive request' ELSE 'Agent activity' END) AS message_label,
    q.id AS question_id, q.version AS question_version, q.prompt AS question_prompt, q.state AS question_state,
    a.last_error_code AS failure_code, COALESCE(failure_audit.metadata->>'message', a.last_error_code) AS failure_message,
    CASE WHEN j.state IN ('pending', 'running') THEN true ELSE false END AS retrying,
    j.state AS job_state,
    COALESCE(timeline.events, '[]'::jsonb) AS timeline
  FROM app.agent_activities ca
  FULL JOIN app.activities a ON a.id=ca.id AND a.account_id=ca.account_id
  LEFT JOIN app.messages m ON m.id=COALESCE(ca.source_message_id,a.message_id) AND m.account_id=COALESCE(ca.account_id,a.account_id)
  JOIN app.accounts ac ON ac.id=COALESCE(ca.account_id,a.account_id)
  LEFT JOIN LATERAL (
    SELECT id, version, prompt, state FROM app.questions WHERE activity_id=COALESCE(ca.id,a.id) ORDER BY created_at DESC, id DESC LIMIT 1
  ) q ON true
  LEFT JOIN LATERAL (
    SELECT state FROM app.agent_jobs WHERE activity_id=COALESCE(ca.id,a.id) ORDER BY updated_at DESC, id DESC LIMIT 1
  ) j ON true
  LEFT JOIN LATERAL (
    SELECT metadata FROM app.audits WHERE activity_id = a.id AND event = 'activity.failed' ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) failure_audit ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', event_id, 'at', event_at, 'label', label, 'detail', detail) ORDER BY event_at, event_id) AS events
    FROM (
      SELECT ev.id::text AS event_id,ev.occurred_at AS event_at,'agent.' || (ev.detail->>'type') AS label,
        COALESCE(ev.detail->>'reason',ev.detail->>'reasonCode',ev.detail->>'errorCode',ev.detail->>'summary') AS detail
      FROM app.agent_activity_events ev WHERE ev.activity_id=ca.id
      UNION ALL
      SELECT au.id::text,au.occurred_at,au.event,au.metadata->>'detail' FROM app.audits au WHERE au.activity_id=a.id AND ca.id IS NULL
      UNION ALL
      SELECT d.id::text,d.created_at,'decision.' || d.state::text,d.rationale FROM app.decisions d WHERE d.activity_id=a.id AND ca.id IS NULL
    ) events
  ) timeline ON true`;

function mapActivity(row: SqlRow): ActivityRecord {
  const value = (key: string): unknown => row[key];
  const questionState = value('question_state');
  const failureCode = value('failure_code');
  const jobState = value('job_state');
  return {
    id: text(value('id')), accountId: text(value('account_id')), messageId: value('message_id') == null ? null : text(value('message_id')), state: text(value('state')) as ActivityRecord['state'],
    version: Number(value('version')), createdAt: timestamp(value('created_at')), updatedAt: timestamp(value('updated_at')),
    title: text(value('title')), accountLabel: text(value('account_label')), messageLabel: text(value('message_label')),
    ...(questionState ? { question: { id: text(value('question_id')), version: Number(value('question_version')), prompt: text(value('question_prompt')), state: text(questionState) as 'open' | 'answered' | 'cancelled' } } : {}),
    ...(failureCode ? { failure: { code: text(failureCode), message: text(value('failure_message')), retrying: value('retrying') === true || value('retrying') === 'true' } } : {}),
    ...(jobState ? { jobState: text(jobState) as ActivityJobState } : {}),
    timeline: array(value('timeline')).map((event) => ({ id: text(event['id']), at: timestamp(event['at']), label: text(event['label']), ...(event['detail'] == null ? {} : { detail: text(event['detail']) }) })),
  };
}

const effectiveState = `CASE ca.state WHEN 'open' THEN 'new' WHEN 'waiting_for_answer' THEN 'waiting_question' WHEN 'resolved' THEN 'handled' WHEN 'attention_required' THEN 'failed' WHEN 'acknowledged' THEN 'acknowledged' ELSE a.state::text END`;
const activityAccount=`COALESCE(ca.account_id,a.account_id)`;
const activityCreated=`COALESCE(ca.created_at,a.created_at)`;
const activityId=`COALESCE(ca.id,a.id)`;
const scopeWhere = (accountsParameter:number,subjectParameter:number):string => `${activityAccount}=ANY($${String(accountsParameter)}::uuid[]) AND ((ca.id IS NOT NULL AND ca.user_id=$${String(subjectParameter)}::uuid) OR (ca.id IS NULL AND ac.user_id=$${String(subjectParameter)}::uuid))`;
const filterWhere = (filter: ActivityListInput['filter']): string => {
  if (filter === 'new') return `${effectiveState} IN ('new','handled')`;
  if (filter === 'questions') return `${effectiveState} = 'waiting_question'`;
  if (filter === 'failed') return `${effectiveState} = 'failed'`;
  return `${effectiveState} = 'acknowledged'`;
};
const escapedSearch = (search: string): string => search.replace(/[\\%_]/g, '\\$&');

/** PostgreSQL implementation of the account-scoped ActivityRepository port. */
export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly sql: SqlClient) {}

  async list(scope: AuthenticatedActivityScope, input: ActivityListInput): Promise<ActivityPage> {
    const counts = await this.sql.query<{ new_count: unknown; questions_count: unknown; failed_count: unknown; history_count: unknown }>(`
      SELECT COUNT(*) FILTER (WHERE ${effectiveState} IN ('new','handled')) AS new_count,
        COUNT(*) FILTER (WHERE ${effectiveState}='waiting_question') AS questions_count,
        COUNT(*) FILTER (WHERE ${effectiveState}='failed') AS failed_count,
        COUNT(*) FILTER (WHERE ${effectiveState}='acknowledged') AS history_count
      FROM app.agent_activities ca FULL JOIN app.activities a ON a.id=ca.id AND a.account_id=ca.account_id JOIN app.accounts ac ON ac.id=COALESCE(ca.account_id,a.account_id) WHERE ${scopeWhere(1,2)}`, [scope.accountIds,scope.subjectId]);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const values: unknown[] = [scope.accountIds,scope.subjectId];
    const where = [scopeWhere(1,2), filterWhere(input.filter)];
    if (input.accountId) { values.push(input.accountId); where.push(`${activityAccount}=$${String(values.length)}::uuid`); }
    if (input.search) { values.push(`%${escapedSearch(input.search.slice(0, 120))}%`); where.push(`concat_ws(' ', m.subject, m.preview, ac.display_name, ac.email) ILIKE $${String(values.length)} ESCAPE '\\'`); }
    if (cursor) { values.push(cursor.createdAt, cursor.id); where.push(`(${activityCreated},${activityId})<($${String(values.length - 1)}::timestamptz,$${String(values.length)}::uuid)`); }
    values.push(input.limit + 1);
    const result = await this.sql.query(`${projection} WHERE ${where.join(' AND ')} ORDER BY COALESCE(ca.created_at,a.created_at) DESC,COALESCE(ca.id,a.id) DESC LIMIT $${String(values.length)}`, values);
    const items = result.rows.slice(0, input.limit).map(mapActivity);
    const finalItem = items.at(-1);
    const count = counts.rows[0] ?? { new_count: 0, questions_count: 0, failed_count: 0, history_count: 0 };
    return {
      items, nextCursor: result.rows.length > input.limit && finalItem ? encodeCursor(finalItem) : null,
      counts: { new: Number(count.new_count ?? 0), questions: Number(count.questions_count ?? 0), failed: Number(count.failed_count ?? 0), history: Number(count.history_count ?? 0) },
    };
  }

  async forMessage(scope: AuthenticatedActivityScope, messageId: string): Promise<readonly ActivityRecord[]> { const result=await this.sql.query(`${projection} WHERE COALESCE(ca.source_message_id,a.message_id)=$1::uuid AND ${scopeWhere(2,3)} ORDER BY ${activityCreated} DESC,${activityId} DESC`,[messageId,scope.accountIds,scope.subjectId]);return result.rows.map(mapActivity); }

  async get(scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityRecord | null> {
    const result = await this.sql.query(`${projection} WHERE COALESCE(ca.id,a.id)=$1::uuid AND ${scopeWhere(2,3)}`, [activityId,scope.accountIds,scope.subjectId]);
    if (!result.rows[0]) return null;
    const runs=await this.sql.query(`SELECT id,sequence,state,outcome,manager_kind,mode,assignment_revision,grant_revision,safety_revision,created_at,started_at,completed_at
      FROM app.agent_runs WHERE activity_id=$1::uuid AND user_id=$2::uuid AND account_id=ANY($3::uuid[]) ORDER BY sequence`,[activityId,scope.subjectId,scope.accountIds]);
    const actions=await this.sql.query(`SELECT a.id,a.run_id,a.kind,a.state,a.assignment_revision,a.grant_revision,a.safety_revision,a.authorization_revision,a.attempt,
        v.verifier,v.observed_at,v.provider_mutation_id FROM app.agent_authorized_actions a LEFT JOIN app.agent_action_verifications v ON v.action_id=a.id AND v.user_id=a.user_id AND v.account_id=a.account_id
      WHERE a.activity_id=$1::uuid AND a.user_id=$2::uuid AND a.account_id=ANY($3::uuid[]) ORDER BY a.authorized_at,a.id`,[activityId,scope.subjectId,scope.accountIds]);
    return {...mapActivity(result.rows[0]),runs:runs.rows.map(row=>({id:text(row['id']),sequence:Number(row['sequence']),state:text(row['state']) as 'created'|'running'|'completed',outcome:row['outcome']==null?null:text(row['outcome']),managerKind:text(row['manager_kind']),mode:text(row['mode']) as 'automatic'|'interactive',assignmentRevision:Number(row['assignment_revision']),grantRevision:Number(row['grant_revision']),safetyRevision:Number(row['safety_revision']),createdAt:timestamp(row['created_at']),startedAt:row['started_at']==null?null:timestamp(row['started_at']),completedAt:row['completed_at']==null?null:timestamp(row['completed_at'])})),actions:actions.rows.map(row=>({id:text(row['id']),runId:text(row['run_id']),kind:text(row['kind']),state:text(row['state']),assignmentRevision:Number(row['assignment_revision']),grantRevision:Number(row['grant_revision']),safetyRevision:Number(row['safety_revision']),authorizationRevision:Number(row['authorization_revision']),attempt:Number(row['attempt']),verification:row['verifier']==null?null:{verifier:text(row['verifier']),observedAt:timestamp(row['observed_at']),providerMutationId:row['provider_mutation_id']==null?null:text(row['provider_mutation_id'])}}))};
  }

  async requestRetry(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult> {
    return this.sql.transaction(async (sql) => {
      const current = await this.lock(sql, scope, activityId);
      if (!current) return { kind: 'not_found' };
      if (Number(current['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(current['version']) };
      if (current['state'] !== 'failed' || !current['failure_code'] || current['retrying'] === true || current['retrying'] === 'true') return { kind: 'blocked', reason: 'Only a failed item that is not already retrying can be retried.' };
      const update = await sql.query<{ version: unknown }>(`UPDATE app.activities SET state = 'new', version = version + 1, updated_at = now() WHERE id = $1::uuid AND account_id = ANY($2::uuid[]) AND version = $3 RETURNING version`, [activityId, scope.accountIds, expectedVersion]);
      if (!update.rows[0]) return this.mutationRace(sql, scope, activityId);
      const version = Number(update.rows[0]['version']);
      await sql.query(`INSERT INTO app.agent_jobs (activity_id, idempotency_key, state, attempt, available_at, last_error_code, queue_job_id, created_at, updated_at)
        VALUES ($1::uuid, $2, 'pending', 0, now(), NULL, NULL, now(), now())
        ON CONFLICT (activity_id) DO UPDATE SET state = 'pending', attempt = app.agent_jobs.attempt + 1, available_at = now(), last_error_code = NULL, queue_job_id = NULL, updated_at = now()`, [activityId, `activity-retry:${activityId}:${String(version)}`]);
      await this.audit(sql, scope, activityId, 'activity.retry_requested', { version });
      return { kind: 'updated', activity: await this.required(sql, scope, activityId) };
    });
  }

  async acknowledge(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult> {
    return this.sql.transaction(async (sql) => {
      const current = await this.lock(sql, scope, activityId);
      if (!current) return { kind: 'not_found' };
      if (Number(current['version']) !== expectedVersion) return { kind: 'conflict', currentVersion: Number(current['version']) };
      const activity = mapActivity({ ...current, id: activityId, account_id: current['account_id'], message_id: current['message_id'], created_at: current['created_at'], updated_at: current['updated_at'], title: '', account_label: '', message_label: '', timeline: [] });
      const reason = acknowledgementBlockReason(activity);
      if (reason) return { kind: 'blocked', reason };
      const canonical = current['canonical_id'] !== null && current['canonical_id'] !== undefined;
      const update = canonical
        ? await sql.query<{ version: unknown }>(`UPDATE app.agent_activities SET state='acknowledged',revision=revision+1,updated_at=now()
            WHERE id=$1::uuid AND account_id=ANY($2::uuid[]) AND revision=$3 AND state='resolved' RETURNING revision AS version`,[activityId,scope.accountIds,expectedVersion])
        : await sql.query<{ version: unknown }>(`UPDATE app.activities SET state='acknowledged',acknowledged_at=now(),version=version+1,updated_at=now()
            WHERE id=$1::uuid AND account_id=ANY($2::uuid[]) AND version=$3 AND state='handled' RETURNING version`,[activityId,scope.accountIds,expectedVersion]);
      if (!update.rows[0]) return this.mutationRace(sql, scope, activityId);
      if (canonical) await sql.query(`UPDATE app.activities SET state='acknowledged',acknowledged_at=now(),version=version+1,updated_at=now() WHERE id=$1::uuid AND account_id=ANY($2::uuid[])`,[activityId,scope.accountIds]);
      if (current['legacy_id']) await this.audit(sql,scope,activityId,'activity.acknowledged',{version:Number(update.rows[0]['version'])});
      else await sql.query(`INSERT INTO app.audits(actor_type,actor_id,account_id,event,correlation_id,metadata)
        VALUES('user',$1,$2::uuid,'activity.acknowledged',$3,$4::jsonb)`,[scope.subjectId,current['account_id'],`activity:${activityId}`,JSON.stringify({canonicalActivityId:activityId,version:Number(update.rows[0]['version'])})]);
      return { kind: 'updated', activity: await this.required(sql, scope, activityId) };
    });
  }

  private async lock(sql: SqlClient, scope: AuthenticatedActivityScope, activityId: string): Promise<SqlRow | null> {
    await sql.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[activityId]);
    const result = await sql.query(`SELECT COALESCE(ca.id,a.id) AS id,a.id AS legacy_id,ca.id AS canonical_id,COALESCE(ca.account_id,a.account_id) AS account_id,COALESCE(ca.source_message_id,a.message_id) AS message_id,${effectiveState} AS state,
      COALESCE(ca.revision,a.version) AS version,COALESCE(ca.created_at,a.created_at) AS created_at,
      COALESCE(ca.updated_at,a.updated_at) AS updated_at,a.last_error_code AS failure_code,
      EXISTS (SELECT 1 FROM app.questions q WHERE q.activity_id=COALESCE(ca.id,a.id) AND q.state = 'open') AS open_question,
      EXISTS (SELECT 1 FROM app.agent_jobs j WHERE j.activity_id=COALESCE(ca.id,a.id) AND j.state IN ('pending', 'running')) AS retrying
      FROM app.agent_activities ca FULL JOIN app.activities a ON a.id=ca.id AND a.account_id=ca.account_id JOIN app.accounts ac ON ac.id=COALESCE(ca.account_id,a.account_id) WHERE COALESCE(ca.id,a.id)=$1::uuid AND ${scopeWhere(2,3)}`, [activityId, scope.accountIds,scope.subjectId]);
    const row = result.rows[0];
    return row ? { ...row, question_state: row['open_question'] === true || row['open_question'] === 'true' ? 'open' : null, job_state: row['retrying'] === true || row['retrying'] === 'true' ? 'pending' : null } : null;
  }
  private async required(sql: SqlClient, scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityRecord> {
    const result = await sql.query(`${projection} WHERE COALESCE(ca.id,a.id)=$1::uuid AND ${scopeWhere(2,3)}`, [activityId, scope.accountIds,scope.subjectId]);
    if (!result.rows[0]) throw new Error('Updated activity disappeared during its transaction.');
    return mapActivity(result.rows[0]);
  }
  private async mutationRace(sql: SqlClient, scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityMutationResult> {
    const current = await this.lock(sql, scope, activityId);
    return current ? { kind: 'conflict', currentVersion: Number(current['version']) } : { kind: 'not_found' };
  }
  private audit(sql: SqlClient, scope: AuthenticatedActivityScope, activityId: string, event: string, metadata: Record<string, unknown>): Promise<SqlQueryResult> {
    return sql.query(`INSERT INTO app.audits (actor_type, actor_id, account_id, activity_id, event, correlation_id, metadata) VALUES ('user', $1, (SELECT account_id FROM app.activities WHERE id = $2::uuid), $2::uuid, $3, $4, $5::jsonb)`, [scope.subjectId, activityId, event, `activity:${activityId}`, JSON.stringify(metadata)]);
  }
}
