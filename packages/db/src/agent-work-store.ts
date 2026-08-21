import {
  agentActionSchema,
  agentActivityEventSchema,
  agentActivitySchema,
  agentRunSchema,
  completeAgentRun,
  finishAgentAction,
  providerVerificationSchema,
  recordAgentActionProviderReport,
  startAgentAction,
  startAgentRun,
  transitionAgentActivity,
  validateAgentActionRetry,
  validateAgentRunContinuation,
  verifyAgentAction,
  type AgentAction,
  type AgentActivity,
  type AgentActivityEvent,
  type AgentActivityState,
  type AgentRun,
  type AgentRunOutcome,
  type ProviderVerification,
} from '@hypermail/contracts';
import type { SqlClient } from './postgres-client.js';

type ManagerRow = {
  manager_kind: string;
  manager_connection_id: string | null;
  manager_legacy_source_id: string | null;
};
type ActivityRow = {
  id: string; user_id: string; account_id: string; kind: string; source_message_id: string | null;
  correlation_id: string; causation_id: string | null; state: string; revision: number;
  created_at: Date | string; updated_at: Date | string;
};
type RunRow = ManagerRow & {
  id: string; activity_id: string; user_id: string; account_id: string; sequence: number;
  manager_lifecycle_revision: number | null; assignment_id: string; assignment_revision: number;
  grant_id: string; grant_revision: number; safety_revision: number; mode: string;
  trigger: unknown; input_digest: string; correlation_id: string; causation_id: string | null;
  state: string; outcome: string | null; error_code: string | null;
  created_at: Date | string; started_at: Date | string | null; completed_at: Date | string | null;
};
type ActionRow = ManagerRow & {
  id: string; activity_id: string; run_id: string; user_id: string; account_id: string;
  correlation_id: string; causation_id: string; manager_lifecycle_revision: number | null; mode: string;
  assignment_id: string; assignment_revision: number; grant_id: string; grant_revision: number;
  safety_revision: number; kind: string; target: unknown; authorization_revision: number;
  idempotency_key: string; attempt: number; retry_of_action_id: string | null; state: string;
  error_code: string | null; authorized_at: Date | string; started_at: Date | string | null;
  provider_reported_at: Date | string | null; completed_at: Date | string | null;
  verification_verifier?: string | null; verification_provider_mutation_id?: string | null;
  verification_evidence_digest?: string | null; verification_observed_at?: Date | string | null;
};
type SequenceRow = { sequence: number };

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const nullableIso = (value: Date | string | null | undefined): string | null => value == null ? null : iso(value);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const activityCreationPayload = (activity: AgentActivity) => ({ id: activity.id, userId: activity.userId,
  mailboxId: activity.mailboxId, kind: activity.kind, sourceMessageId: activity.sourceMessageId,
  correlationId: activity.correlationId, causationId: activity.causationId, createdAt: activity.createdAt });
const runCreationPayload = (run: AgentRun) => ({ id: run.id, activityId: run.activityId, userId: run.userId,
  mailboxId: run.mailboxId, sequence: run.sequence, manager: run.manager,
  managerLifecycleRevision: run.managerLifecycleRevision, assignmentId: run.assignmentId,
  assignmentRevision: run.assignmentRevision, grantId: run.grantId, grantRevision: run.grantRevision,
  safetyRevision: run.safetyRevision, mode: run.mode, trigger: run.trigger, inputDigest: run.inputDigest,
  correlationId: run.correlationId, causationId: run.causationId, createdAt: run.createdAt });
const actionAuthorizationPayload = (action: AgentAction) => ({ id: action.id, activityId: action.activityId,
  runId: action.runId, userId: action.userId, mailboxId: action.mailboxId, correlationId: action.correlationId,
  causationId: action.causationId, manager: action.manager, managerLifecycleRevision: action.managerLifecycleRevision,
  mode: action.mode, assignmentId: action.assignmentId, assignmentRevision: action.assignmentRevision,
  grantId: action.grantId, grantRevision: action.grantRevision, safetyRevision: action.safetyRevision,
  kind: action.kind, target: action.target, authorizationRevision: action.authorizationRevision,
  idempotencyKey: action.idempotencyKey, attempt: action.attempt, retryOfActionId: action.retryOfActionId,
  authorizedAt: action.authorizedAt });
const requireRow = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) throw new Error(message);
  return row;
};
const managerValues = (manager: AgentRun['manager']): readonly [string, string | null, string | null] => manager.kind === 'agent_connection'
  ? [manager.kind, manager.connectionId, null]
  : manager.kind === 'legacy_mastra' ? [manager.kind, null, manager.legacySourceId] : [manager.kind, null, null];
const managerFrom = (row: ManagerRow): AgentRun['manager'] => row.manager_kind === 'agent_connection'
  ? { kind: 'agent_connection', connectionId: String(row.manager_connection_id) }
  : row.manager_kind === 'legacy_mastra'
    ? { kind: 'legacy_mastra', legacySourceId: String(row.manager_legacy_source_id) }
    : { kind: 'mastra' };
const activityFrom = (row: ActivityRow): AgentActivity => agentActivitySchema.parse({
  id: row.id, userId: row.user_id, mailboxId: row.account_id, kind: row.kind,
  sourceMessageId: row.source_message_id, correlationId: row.correlation_id, causationId: row.causation_id,
  state: row.state, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const runFrom = (row: RunRow): AgentRun => agentRunSchema.parse({
  id: row.id, activityId: row.activity_id, userId: row.user_id, mailboxId: row.account_id,
  sequence: row.sequence, manager: managerFrom(row), managerLifecycleRevision: row.manager_lifecycle_revision,
  assignmentId: row.assignment_id, assignmentRevision: row.assignment_revision, grantId: row.grant_id,
  grantRevision: row.grant_revision, safetyRevision: row.safety_revision, mode: row.mode, trigger: row.trigger,
  inputDigest: row.input_digest, correlationId: row.correlation_id, causationId: row.causation_id,
  state: row.state, outcome: row.outcome, errorCode: row.error_code, createdAt: iso(row.created_at),
  startedAt: nullableIso(row.started_at), completedAt: nullableIso(row.completed_at),
});
const verificationFrom = (row: ActionRow): ProviderVerification | null => row.verification_verifier == null ? null : providerVerificationSchema.parse({
  actionId: row.id, mailboxId: row.account_id, verifier: row.verification_verifier,
  providerMutationId: row.verification_provider_mutation_id ?? undefined, evidenceDigest: row.verification_evidence_digest,
  observedAt: nullableIso(row.verification_observed_at),
});
const actionFrom = (row: ActionRow): AgentAction => agentActionSchema.parse({
  id: row.id, activityId: row.activity_id, runId: row.run_id, userId: row.user_id, mailboxId: row.account_id,
  correlationId: row.correlation_id, causationId: row.causation_id, manager: managerFrom(row),
  managerLifecycleRevision: row.manager_lifecycle_revision, mode: row.mode, assignmentId: row.assignment_id,
  assignmentRevision: row.assignment_revision, grantId: row.grant_id, grantRevision: row.grant_revision,
  safetyRevision: row.safety_revision, kind: row.kind, target: row.target,
  authorizationRevision: row.authorization_revision, idempotencyKey: row.idempotency_key, attempt: row.attempt,
  retryOfActionId: row.retry_of_action_id, state: row.state, errorCode: row.error_code,
  authorizedAt: iso(row.authorized_at), startedAt: nullableIso(row.started_at),
  providerReportedAt: nullableIso(row.provider_reported_at), completedAt: nullableIso(row.completed_at),
  verification: verificationFrom(row),
});
const actionSelect = `select a.*, v.verifier as verification_verifier,
  v.provider_mutation_id as verification_provider_mutation_id,
  v.evidence_digest as verification_evidence_digest, v.observed_at as verification_observed_at
  from app.agent_authorized_actions a left join app.agent_action_verifications v on v.action_id=a.id`;

/** Canonical, tenant-scoped transactional persistence for Agent work history. */
export class AgentWorkStore {
  constructor(private readonly sql: SqlClient) {}

  async createActivity(value: AgentActivity): Promise<AgentActivity> {
    const supplied = agentActivitySchema.parse(value);
    if (supplied.state !== 'open' || supplied.revision !== 1) throw new Error('A new Activity must be open at revision 1.');
    return this.sql.transaction(async (sql) => {
      const inserted = await sql.query<ActivityRow>(`insert into app.agent_activities
        (id,user_id,account_id,kind,source_message_id,correlation_id,causation_id,state,revision,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz)
        on conflict(user_id,account_id,correlation_id) do nothing returning *`,
      [supplied.id, supplied.userId, supplied.mailboxId, supplied.kind, supplied.sourceMessageId,
        supplied.correlationId, supplied.causationId, supplied.state, supplied.revision, supplied.createdAt, supplied.updatedAt]);
      const row = inserted.rows[0] ?? (await sql.query<ActivityRow>(
        `select * from app.agent_activities where user_id=$1 and account_id=$2 and correlation_id=$3 for update`,
        [supplied.userId, supplied.mailboxId, supplied.correlationId],
      )).rows[0];
      const actual = activityFrom(requireRow(row, 'Activity idempotency conflict disappeared.'));
      if (!same(activityCreationPayload(actual), activityCreationPayload(supplied))) throw new Error('Activity idempotency key conflicts with a different payload.');
      return actual;
    });
  }

  async transitionActivity(userId: string, mailboxId: string, activityId: string, expectedRevision: number, to: AgentActivityState, at: string): Promise<AgentActivity> {
    return this.sql.transaction(async (sql) => {
      const found = await sql.query<ActivityRow>(`select * from app.agent_activities where id=$1 and user_id=$2 and account_id=$3 for update`, [activityId, userId, mailboxId]);
      const current = activityFrom(requireRow(found.rows[0], 'Activity not found in tenant.'));
      if (current.revision !== expectedRevision) throw new Error('Stale Activity revision.');
      const next = transitionAgentActivity(current, to, at);
      const updated = await sql.query<ActivityRow>(`update app.agent_activities set state=$5,revision=$4+1,updated_at=$6::timestamptz
        where id=$1 and user_id=$2 and account_id=$3 and revision=$4 returning *`,
      [activityId, userId, mailboxId, expectedRevision, next.state, next.updatedAt]);
      return activityFrom(requireRow(updated.rows[0], 'Stale Activity revision.'));
    });
  }

  async createRun(value: AgentRun): Promise<AgentRun> { return this.sql.transaction((sql) => this.insertRun(sql, value)); }

  async createContinuation(priorRunId: string, value: AgentRun): Promise<AgentRun> {
    return this.sql.transaction(async (sql) => {
      const supplied = agentRunSchema.parse(value);
      const parent = await sql.query<ActivityRow>(`select * from app.agent_activities where id=$1 and user_id=$2 and account_id=$3 for update`, [supplied.activityId, supplied.userId, supplied.mailboxId]);
      requireRow(parent.rows[0], 'Activity not found in tenant.');
      const priorResult = await sql.query<RunRow>(`select * from app.agent_runs where id=$1 and user_id=$2 and account_id=$3 for update`, [priorRunId, supplied.userId, supplied.mailboxId]);
      const prior = runFrom(requireRow(priorResult.rows[0], 'Prior Run not found in tenant.'));
      validateAgentRunContinuation(prior, supplied);
      return this.insertRunAfterParentLock(sql, supplied);
    });
  }

  private async insertRun(sql: SqlClient, value: AgentRun): Promise<AgentRun> {
    const supplied = agentRunSchema.parse(value);
    if (supplied.state !== 'created') throw new Error('A new Run must be created, not already executed.');
    const parent = await sql.query<ActivityRow>(`select * from app.agent_activities where id=$1 and user_id=$2 and account_id=$3 for update`, [supplied.activityId, supplied.userId, supplied.mailboxId]);
    requireRow(parent.rows[0], 'Activity not found in tenant.');
    return this.insertRunAfterParentLock(sql, supplied);
  }

  private async insertRunAfterParentLock(sql: SqlClient, supplied: AgentRun): Promise<AgentRun> {
    const existing = await sql.query<RunRow>(`select * from app.agent_runs where id=$1 and user_id=$2 and account_id=$3 for update`, [supplied.id, supplied.userId, supplied.mailboxId]);
    if (existing.rows[0] !== undefined) {
      const actual = runFrom(existing.rows[0]);
      if (!same(runCreationPayload(actual), runCreationPayload(supplied))) throw new Error('Run idempotency identity conflicts with a different payload.');
      return actual;
    }
    const nextResult = await sql.query<SequenceRow>(`select coalesce(max(sequence),0)::integer+1 as sequence from app.agent_runs where activity_id=$1`, [supplied.activityId]);
    const next = requireRow(nextResult.rows[0], 'Could not allocate Run sequence.').sequence;
    if (supplied.sequence !== next) throw new Error(`Run sequence must be ${String(next)}.`);
    const manager = managerValues(supplied.manager);
    const inserted = await sql.query<RunRow>(`insert into app.agent_runs
      (id,activity_id,user_id,account_id,sequence,manager_kind,manager_connection_id,manager_legacy_source_id,manager_lifecycle_revision,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,causation_id,state,outcome,error_code,created_at,started_at,completed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23::timestamptz,$24::timestamptz,$25::timestamptz) returning *`,
    [supplied.id, supplied.activityId, supplied.userId, supplied.mailboxId, supplied.sequence, ...manager,
      supplied.managerLifecycleRevision, supplied.assignmentId, supplied.assignmentRevision, supplied.grantId,
      supplied.grantRevision, supplied.safetyRevision, supplied.mode, supplied.trigger, supplied.inputDigest,
      supplied.correlationId, supplied.causationId, supplied.state, supplied.outcome, supplied.errorCode,
      supplied.createdAt, supplied.startedAt, supplied.completedAt]);
    return runFrom(requireRow(inserted.rows[0], 'Run insert returned no row.'));
  }

  async startRun(userId: string, mailboxId: string, runId: string, at: string): Promise<AgentRun> {
    return this.updateRun(userId, mailboxId, runId, (run) => startAgentRun(run, at),
      `state='running',started_at=$4::timestamptz`, 'created', [at]);
  }
  async completeRun(userId: string, mailboxId: string, runId: string, outcome: AgentRunOutcome, at: string, errorCode: string | null = null): Promise<AgentRun> {
    return this.updateRun(userId, mailboxId, runId, (run) => completeAgentRun(run, outcome, at, errorCode),
      `state='completed',outcome=$4,error_code=$5,completed_at=$6::timestamptz`, 'running', [outcome, errorCode, at]);
  }
  private async updateRun(userId: string, mailboxId: string, id: string, evolve: (run: AgentRun) => AgentRun, set: string, expected: string, values: readonly unknown[]): Promise<AgentRun> {
    return this.sql.transaction(async (sql) => {
      const found = await sql.query<RunRow>(`select * from app.agent_runs where id=$1 and user_id=$2 and account_id=$3 for update`, [id, userId, mailboxId]);
      evolve(runFrom(requireRow(found.rows[0], 'Run not found in tenant.')));
      const updated = await sql.query<RunRow>(`update app.agent_runs set ${set} where id=$1 and user_id=$2 and account_id=$3 and state='${expected}' returning *`, [id, userId, mailboxId, ...values]);
      return runFrom(requireRow(updated.rows[0], 'Stale Run state.'));
    });
  }

  async authorizeAction(value: AgentAction): Promise<AgentAction> {
    const supplied = agentActionSchema.parse(value);
    if (supplied.state !== 'authorized') throw new Error('A new Action must only be authorized, not reported as executed.');
    return this.sql.transaction((sql) => this.insertAction(sql, supplied));
  }

  async retryAction(priorActionId: string, value: AgentAction): Promise<AgentAction> {
    const supplied = agentActionSchema.parse(value);
    return this.sql.transaction(async (sql) => {
      const prior = await this.getAction(sql, supplied.userId, supplied.mailboxId, priorActionId, true);
      validateAgentActionRetry(prior, supplied);
      return this.insertAction(sql, supplied);
    });
  }

  private async insertAction(sql: SqlClient, supplied: AgentAction): Promise<AgentAction> {
    const runResult = await sql.query<RunRow>(`select * from app.agent_runs where id=$1 and user_id=$2 and account_id=$3 for update`, [supplied.runId, supplied.userId, supplied.mailboxId]);
    const run = runFrom(requireRow(runResult.rows[0], 'Run not found in tenant.'));
    const sameFence = run.activityId === supplied.activityId && same(run.manager, supplied.manager)
      && run.managerLifecycleRevision === supplied.managerLifecycleRevision && run.mode === supplied.mode
      && run.assignmentId === supplied.assignmentId && run.assignmentRevision === supplied.assignmentRevision
      && run.grantId === supplied.grantId && run.grantRevision === supplied.grantRevision
      && run.safetyRevision === supplied.safetyRevision;
    if (!sameFence) throw new Error('Action authorization does not match its frozen Run authority.');
    const existing = await sql.query<ActionRow>(`${actionSelect} where a.user_id=$1 and a.account_id=$2 and a.idempotency_key=$3 for update of a`, [supplied.userId, supplied.mailboxId, supplied.idempotencyKey]);
    if (existing.rows[0] !== undefined) {
      const actual = actionFrom(existing.rows[0]);
      if (!same(actionAuthorizationPayload(actual), actionAuthorizationPayload(supplied))) throw new Error('Action idempotency key conflicts with a different payload.');
      return actual;
    }
    const manager = managerValues(supplied.manager);
    const inserted = await sql.query<ActionRow>(`insert into app.agent_authorized_actions
      (id,activity_id,run_id,user_id,account_id,correlation_id,causation_id,manager_kind,manager_connection_id,manager_legacy_source_id,manager_lifecycle_revision,mode,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,kind,target,authorization_revision,idempotency_key,attempt,retry_of_action_id,state,error_code,authorized_at,started_at,provider_reported_at,completed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26::timestamptz,$27::timestamptz,$28::timestamptz,$29::timestamptz) returning *`,
    [supplied.id, supplied.activityId, supplied.runId, supplied.userId, supplied.mailboxId, supplied.correlationId,
      supplied.causationId, ...manager, supplied.managerLifecycleRevision, supplied.mode, supplied.assignmentId,
      supplied.assignmentRevision, supplied.grantId, supplied.grantRevision, supplied.safetyRevision, supplied.kind,
      supplied.target, supplied.authorizationRevision, supplied.idempotencyKey, supplied.attempt,
      supplied.retryOfActionId, supplied.state, supplied.errorCode, supplied.authorizedAt, supplied.startedAt,
      supplied.providerReportedAt, supplied.completedAt]);
    return actionFrom(requireRow(inserted.rows[0], 'Action insert returned no row.'));
  }

  async startAction(userId: string, mailboxId: string, id: string, at: string): Promise<AgentAction> {
    return this.updateAction(userId, mailboxId, id, (action) => startAgentAction(action, at),
      `state='executing',started_at=$4::timestamptz`, ['authorized'], [at]);
  }
  async reportAction(userId: string, mailboxId: string, id: string, at: string): Promise<AgentAction> {
    return this.updateAction(userId, mailboxId, id, (action) => recordAgentActionProviderReport(action, at),
      `state='verifying',provider_reported_at=$4::timestamptz`, ['executing'], [at]);
  }

  /** Provider readback and its owner-facing event commit atomically; a connector report alone cannot verify. */
  async verifyAction(userId: string, mailboxId: string, id: string, proof: ProviderVerification, event: AgentActivityEvent): Promise<AgentAction> {
    const evidence = providerVerificationSchema.parse(proof);
    const suppliedEvent = agentActivityEventSchema.parse(event);
    if (evidence.actionId !== id || evidence.mailboxId !== mailboxId) throw new Error('Verification evidence identifies a different Action or Mailbox.');
    if (suppliedEvent.userId !== userId || suppliedEvent.mailboxId !== mailboxId
      || suppliedEvent.detail.type !== 'action_verified' || suppliedEvent.detail.actionId !== id) {
      throw new Error('Verification Event must identify the verified Action and tenant.');
    }
    const eventRunId = suppliedEvent.detail.runId;
    return this.sql.transaction(async (sql) => {
      const currentWithoutLock = await this.getAction(sql, userId, mailboxId, id);
      if (suppliedEvent.activityId !== currentWithoutLock.activityId || eventRunId !== currentWithoutLock.runId) {
        throw new Error('Verification Event must identify the Action Activity and Run.');
      }
      const parent = await sql.query<ActivityRow>(`select * from app.agent_activities where id=$1 and user_id=$2 and account_id=$3 for update`, [suppliedEvent.activityId, userId, mailboxId]);
      requireRow(parent.rows[0], 'Activity not found in tenant.');
      const current = await this.getAction(sql, userId, mailboxId, id, true);
      verifyAgentAction(current, evidence);
      await sql.query(`insert into app.agent_action_verifications(action_id,user_id,account_id,verifier,provider_mutation_id,evidence_digest,observed_at)
        values($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [evidence.actionId, userId, mailboxId, evidence.verifier, evidence.providerMutationId ?? null, evidence.evidenceDigest, evidence.observedAt]);
      const updated = await sql.query<ActionRow>(`update app.agent_authorized_actions set state='verified',completed_at=$4::timestamptz
        where id=$1 and user_id=$2 and account_id=$3 and state='verifying' returning *`, [id, userId, mailboxId, evidence.observedAt]);
      requireRow(updated.rows[0], 'Stale Action state.');
      await this.appendEventAfterParentLock(sql, suppliedEvent);
      return this.getAction(sql, userId, mailboxId, id);
    });
  }

  async failAction(userId: string, mailboxId: string, id: string, outcome: 'failed' | 'unverifiable' | 'cancelled', at: string, errorCode: string | null = null): Promise<AgentAction> {
    return this.updateAction(userId, mailboxId, id, (action) => finishAgentAction(action, outcome, at, errorCode),
      `state=$4,error_code=$5,completed_at=$6::timestamptz`, ['authorized', 'executing', 'verifying'], [outcome, errorCode, at]);
  }

  private async getAction(sql: SqlClient, userId: string, mailboxId: string, id: string, lock = false): Promise<AgentAction> {
    const result = await sql.query<ActionRow>(`${actionSelect} where a.id=$1 and a.user_id=$2 and a.account_id=$3${lock ? ' for update of a' : ''}`, [id, userId, mailboxId]);
    return actionFrom(requireRow(result.rows[0], 'Action not found in tenant.'));
  }

  private async updateAction(userId: string, mailboxId: string, id: string, evolve: (action: AgentAction) => AgentAction, set: string, states: readonly string[], values: readonly unknown[]): Promise<AgentAction> {
    return this.sql.transaction(async (sql) => {
      const current = await this.getAction(sql, userId, mailboxId, id, true);
      evolve(current);
      const updated = await sql.query<ActionRow>(`update app.agent_authorized_actions a set ${set}
        where id=$1 and user_id=$2 and account_id=$3 and state = any($${String(values.length + 4)}::app.agent_action_state[]) returning a.*`,
      [id, userId, mailboxId, ...values, states]);
      return actionFrom(requireRow(updated.rows[0], 'Stale Action state.'));
    });
  }

  async appendEvent(value: AgentActivityEvent): Promise<AgentActivityEvent> {
    const supplied = agentActivityEventSchema.parse(value);
    return this.sql.transaction(async (sql) => {
      const parent = await sql.query<ActivityRow>(`select * from app.agent_activities where id=$1 and user_id=$2 and account_id=$3 for update`, [supplied.activityId, supplied.userId, supplied.mailboxId]);
      requireRow(parent.rows[0], 'Activity not found in tenant.');
      return this.appendEventAfterParentLock(sql, supplied);
    });
  }

  private async appendEventAfterParentLock(sql: SqlClient, supplied: AgentActivityEvent): Promise<AgentActivityEvent> {
    const last = await sql.query<{ sequence: number; occurred_at: Date | string }>(`select sequence,occurred_at from app.agent_activity_events where activity_id=$1 order by sequence desc limit 1`, [supplied.activityId]);
    const previous = last.rows[0];
    const next = (previous?.sequence ?? 0) + 1;
    if (supplied.sequence !== next) throw new Error(`Activity Event sequence must be ${String(next)}.`);
    if (previous !== undefined && Date.parse(supplied.occurredAt) < Date.parse(iso(previous.occurred_at))) throw new Error('Activity Event chronology is invalid.');
    await sql.query(`insert into app.agent_activity_events(id,activity_id,user_id,account_id,sequence,correlation_id,causation_id,occurred_at,detail)
      values($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb)`,
    [supplied.id, supplied.activityId, supplied.userId, supplied.mailboxId, supplied.sequence,
      supplied.correlationId, supplied.causationId, supplied.occurredAt, supplied.detail]);
    return supplied;
  }
}
