import { z } from 'zod';

/** The complete, intentionally small capability surface available to policy code. */
export const policyActionKindSchema = z.enum([
  'archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread', 'draft_create', 'draft_edit',
]);
export type PolicyActionKind = z.infer<typeof policyActionKindSchema>;

const id = z.uuid();
const messageTarget = z.strictObject({ accountId: id, messageId: id });
const moveTarget = messageTarget.extend({ destinationFolderId: id });
const draftTarget = z.strictObject({ accountId: id, draftId: id });
export const policyTargetSchema = z.union([messageTarget, moveTarget, draftTarget]);
/** Preconditions are provider facts, not executable instructions. */
export const policyPreconditionSchema = z.record(z.string().min(1).max(80), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).superRefine((value, ctx) => {
  if (Object.keys(value).length > 20) ctx.addIssue({ code: 'custom', message: 'Too many precondition fields.' });
});
export const policyActionInputSchema = z.strictObject({
  activityId: id,
  decisionId: id,
  idempotencyKey: z.string().min(16).max(200),
  kind: policyActionKindSchema,
  target: policyTargetSchema,
  precondition: policyPreconditionSchema,
}).superRefine((input, ctx) => {
  const target = input.target;
  const isDraft = input.kind === 'draft_create' || input.kind === 'draft_edit';
  if (input.kind === 'move' && !('destinationFolderId' in target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'move requires an existing destinationFolderId.' });
  if (isDraft && !('draftId' in target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'draft actions require draftId.' });
  if (!isDraft && !('messageId' in target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'mailbox actions require messageId.' });
});
export type PolicyActionInput = z.infer<typeof policyActionInputSchema>;

export type MutationRequest<Target> = Readonly<{ target: Target; idempotencyKey: string }>;
/** A retry is safe only when the transport explicitly proves no mutation was applied. */
export type ProviderMutationError = Error & Readonly<{ retryable?: boolean; definitelyNotApplied?: boolean }>;
export type MutationCapability = Readonly<{
  archive(request: MutationRequest<z.infer<typeof messageTarget>>): Promise<ProviderReceipt>;
  recoverableTrash(request: MutationRequest<z.infer<typeof messageTarget>>): Promise<ProviderReceipt>;
  move(request: MutationRequest<z.infer<typeof moveTarget>>): Promise<ProviderReceipt>;
  markRead(request: MutationRequest<z.infer<typeof messageTarget>>): Promise<ProviderReceipt>;
  markUnread(request: MutationRequest<z.infer<typeof messageTarget>>): Promise<ProviderReceipt>;
  draftCreate(request: MutationRequest<z.infer<typeof draftTarget>>): Promise<ProviderReceipt>;
  draftEdit(request: MutationRequest<z.infer<typeof draftTarget>>): Promise<ProviderReceipt>;
}>;
/** Private transport: do not add send, deletion, admin, or folder-management methods. */
export interface PrivateMutationTransport extends MutationCapability {
  read?(target: z.infer<typeof policyTargetSchema>, kind?: PolicyActionKind): Promise<Readonly<Record<string, unknown>> | null>;
  list?(target: z.infer<typeof policyTargetSchema>): Promise<readonly Readonly<Record<string, unknown>>[]>;
}
export type ProviderReceipt = Readonly<Record<string, unknown>>;

export type ActionOutcome = 'succeeded' | 'failed' | 'unverifiable' | 'incorrect';
export type Claim = Readonly<{ actionId: string; accountId: string; outcome?: ActionOutcome; run: boolean; recover?: boolean }>;
export type Completion = Readonly<{ outcome: ActionOutcome; receipt?: ProviderReceipt; observed: Readonly<Record<string, unknown>>; errorCode?: string }>;

/** Persistence is deliberately a narrow policy-owned port, injected by the application. */
export interface PolicyPersistence {
  claim(input: PolicyActionInput, isGloballyPaused: () => boolean): Promise<Claim>;
  claimImmediatelyBeforeMutation(actionId: string, accountId: string, isGloballyPaused: () => boolean): Promise<'run' | 'paused' | 'finished'>;
  complete(actionId: string, accountId: string, completion: Completion, safety: PolicySafetyConfig): Promise<ActionOutcome>;
}
export type PolicySafetyConfig = Readonly<{ maxIncorrectRate: number; windowMs: number }>;
export type PolicyExecutorOptions = Readonly<{
  persistence: PolicyPersistence;
  transport: PrivateMutationTransport;
  /** Must read the authoritative global pause flag; it is sampled inside each claim. */
  isGloballyPaused: () => boolean;
  maxAttempts?: number;
  safety?: Partial<PolicySafetyConfig>;
}>;

const safetyKinds = new Set<PolicyActionKind>(['archive', 'recoverable_trash', 'move']);
const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const matches = (actual: Readonly<Record<string, unknown>> | null, expected: Readonly<Record<string, unknown>>): boolean => actual !== null && Object.entries(expected).every(([key, value]) => actual[key] === value);
/**
 * Canonical provider facts used to verify each mutation. Receipts are evidence of a
 * confirmed call, not provider-specific verification contracts: archive => folderRole
 * archive; recoverable trash => folderRole trash; move => destination folderId; read
 * mutations => isRead; draft mutations => draftId.
 */
const verificationProjection = (input: PolicyActionInput): Readonly<Record<string, unknown>> => {
  switch (input.kind) {
    case 'archive': return { folderRole: 'archive' };
    case 'recoverable_trash': return { folderRole: 'trash' };
    case 'move':
      if ('destinationFolderId' in input.target) return { folderId: input.target.destinationFolderId };
      throw new Error('POLICY_INVALID_TARGET');
    case 'mark_read': return { isRead: true };
    case 'mark_unread': return { isRead: false };
    case 'draft_create':
    case 'draft_edit':
      if ('draftId' in input.target) return { draftId: input.target.draftId };
      throw new Error('POLICY_INVALID_TARGET');
  }
};

/** The sole autonomous mailbox mutation path. It never holds a DB transaction during provider I/O. */
export class PolicyExecutor {
  private readonly maxAttempts: number;
  private readonly safety: PolicySafetyConfig;
  constructor(private readonly options: PolicyExecutorOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) throw new Error('maxAttempts must be an integer from 1 to 10.');
    this.safety = { maxIncorrectRate: options.safety?.maxIncorrectRate ?? 0.01, windowMs: options.safety?.windowMs ?? 3_600_000 };
    if (this.safety.maxIncorrectRate <= 0 || this.safety.maxIncorrectRate > 1 || this.safety.windowMs < 1) throw new Error('Invalid safety configuration.');
  }

  async execute(raw: unknown): Promise<Readonly<{ actionId: string; outcome: ActionOutcome | 'paused' }>> {
    const input = policyActionInputSchema.parse(raw);
    const claim = await this.options.persistence.claim(input, this.options.isGloballyPaused);
    if (claim.outcome) return { actionId: claim.actionId, outcome: claim.outcome };
    if (!claim.run) return { actionId: claim.actionId, outcome: 'paused' };

    // An interrupted executing action is uncertain: verify and terminally persist it, never mutate again.
    if (claim.recover) return this.finish(claim, await this.verify(input, undefined, false));
    // Provider preconditions are checked before claiming the external call. They are never prompt text.
    if (Object.keys(input.precondition).length && this.options.transport.read) {
      const current = await this.options.transport.read(input.target, input.kind);
      if (!matches(current, input.precondition)) return this.finish(claim, { outcome: 'failed', observed: record(current), errorCode: 'PRECONDITION_MISMATCH' });
    }
    // This is the last operation before provider I/O and atomically checks global + account pause.
    const ready = await this.options.persistence.claimImmediatelyBeforeMutation(claim.actionId, claim.accountId, this.options.isGloballyPaused);
    if (ready === 'paused') return { actionId: claim.actionId, outcome: 'paused' };
    if (ready === 'finished') throw new Error('POLICY_ACTION_NOT_READY');

    let receipt: ProviderReceipt | undefined;
    let failure: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        receipt = await this.callTransport(input);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (!this.isSafeRetry(error) || attempt === this.maxAttempts) break;
      }
    }
    if (failure || !receipt) {
      // An ambiguous provider failure could already have mutated remote state.
      return this.finish(claim, await this.verify(input, undefined, false));
    }

    return this.finish(claim, await this.verify(input, receipt, true));
  }

  private isSafeRetry(error: unknown): error is ProviderMutationError {
    const candidate = error as ProviderMutationError;
    return error instanceof Error && candidate.retryable === true && candidate.definitelyNotApplied === true;
  }
  private async callTransport(input: PolicyActionInput): Promise<ProviderReceipt> {
    const request = { target: input.target, idempotencyKey: input.idempotencyKey };
    if (input.kind === 'move' && 'destinationFolderId' in input.target) return this.options.transport.move(request as MutationRequest<z.infer<typeof moveTarget>>);
    if (input.kind === 'archive' && 'messageId' in input.target) return this.options.transport.archive(request as MutationRequest<z.infer<typeof messageTarget>>);
    if (input.kind === 'recoverable_trash' && 'messageId' in input.target) return this.options.transport.recoverableTrash(request as MutationRequest<z.infer<typeof messageTarget>>);
    if (input.kind === 'mark_read' && 'messageId' in input.target) return this.options.transport.markRead(request as MutationRequest<z.infer<typeof messageTarget>>);
    if (input.kind === 'mark_unread' && 'messageId' in input.target) return this.options.transport.markUnread(request as MutationRequest<z.infer<typeof messageTarget>>);
    if (input.kind === 'draft_create' && 'draftId' in input.target) return this.options.transport.draftCreate(request as MutationRequest<z.infer<typeof draftTarget>>);
    if (input.kind === 'draft_edit' && 'draftId' in input.target) return this.options.transport.draftEdit(request as MutationRequest<z.infer<typeof draftTarget>>);
    throw new Error('POLICY_INVALID_TARGET');
  }
  private async verify(input: PolicyActionInput, receipt: ProviderReceipt | undefined, providerConfirmed: boolean): Promise<Completion> {
    const completion = (outcome: ActionOutcome, observed: Readonly<Record<string, unknown>>, errorCode?: string): Completion => ({
      outcome,
      ...(receipt ? { receipt } : {}),
      observed,
      ...(errorCode ? { errorCode } : {}),
    });
    if (!this.options.transport.read && !this.options.transport.list) return completion('unverifiable', {}, 'PROVIDER_CANNOT_VERIFY');
    try {
      let observed: Readonly<Record<string, unknown>> | null;
      if (this.options.transport.read) observed = await this.options.transport.read(input.target, input.kind);
      else if (this.options.transport.list) observed = (await this.options.transport.list(input.target))[0] ?? null;
      else observed = null;
      const expected = verificationProjection(input);
      if (observed === null || !Object.keys(expected).every(key => Object.hasOwn(observed, key))) {
        return completion('unverifiable', record(observed), 'VERIFICATION_INSUFFICIENT');
      }
      if (matches(observed, expected)) return completion('succeeded', observed);
      // A failed/interrupting call is ambiguous. Only a confirmed provider call can make a mismatch incorrect.
      return providerConfirmed
        ? completion('incorrect', observed)
        : completion('unverifiable', observed, 'AMBIGUOUS_EXECUTION');
    } catch { return completion('unverifiable', {}, 'VERIFICATION_UNAVAILABLE'); }
  }
  private async finish(claim: Claim, completion: Completion): Promise<Readonly<{ actionId: string; outcome: ActionOutcome }>> {
    const outcome = await this.options.persistence.complete(claim.actionId, claim.accountId, completion, this.safety);
    return { actionId: claim.actionId, outcome };
  }
}

export type SqlRow = Record<string, unknown>;
export interface PolicySqlClient { query(text: string, values?: readonly unknown[]): Promise<Readonly<{ rows: readonly SqlRow[] }>>; transaction<T>(work: (sql: PolicySqlClient) => Promise<T>): Promise<T>; }
const bool = (value: unknown) => value === true || value === 'true';
const asText = (value: unknown) => String(value);
const jsonObject = (value: unknown): Record<string, unknown> => typeof value === 'string' ? record(JSON.parse(value)) : record(value);
const canonical = (value: unknown): string => value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);

/** PostgreSQL adapter touching only the existing policy-related application tables. */
export class PostgresPolicyPersistence implements PolicyPersistence {
  constructor(private readonly sql: PolicySqlClient) {}
  async claim(input: PolicyActionInput, isGloballyPaused: () => boolean): Promise<Claim> {
    return this.sql.transaction(async sql => {
      const accountId = input.target.accountId;
      const account = await sql.query(`SELECT id, autonomy_paused_at FROM app.accounts WHERE id = $1::uuid FOR UPDATE`, [accountId]);
      if (!account.rows[0]) throw new Error('POLICY_ACCOUNT_NOT_FOUND');
      const existing = await sql.query(`SELECT id, state, activity_id, decision_id, kind, target, precondition FROM app.actions WHERE idempotency_key = $1 FOR UPDATE`, [input.idempotencyKey]);
      if (existing.rows[0]) {
        const current = existing.rows[0];
        if (asText(current['activity_id']) !== input.activityId || asText(current['decision_id']) !== input.decisionId || asText(current['kind']) !== input.kind || canonical(jsonObject(current['target'])) !== canonical(input.target) || canonical(jsonObject(current['precondition'])) !== canonical(input.precondition)) throw new Error('POLICY_IDEMPOTENCY_CONFLICT');
        const state = asText(current['state']);
        const outcome = state === 'succeeded' || state === 'failed' || state === 'unverifiable' || state === 'incorrect' ? state : undefined;
        return { actionId: asText(existing.rows[0]['id']), accountId, run: state === 'planned' || state === 'executing', recover: state === 'executing', ...(outcome ? { outcome } : {}) };
      }
      const inserted = await sql.query(`INSERT INTO app.actions (activity_id, decision_id, kind, state, idempotency_key, target, precondition, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3, 'planned', $4, $5::jsonb, $6::jsonb, now(), now()) RETURNING id`, [input.activityId, input.decisionId, input.kind, input.idempotencyKey, JSON.stringify(input.target), JSON.stringify(input.precondition)]);
      const insertedAction = inserted.rows[0];
      if (!insertedAction) throw new Error('POLICY_ACTION_INSERT_FAILED');
      const actionId = asText(insertedAction['id']);
      await this.audit(sql, accountId, input.activityId, actionId, 'policy.action_claimed', { kind: input.kind });
      return { actionId, accountId, run: !isGloballyPaused() && !account.rows[0]['autonomy_paused_at'] };
    });
  }
  async claimImmediatelyBeforeMutation(actionId: string, accountId: string, isGloballyPaused: () => boolean): Promise<'run' | 'paused' | 'finished'> {
    return this.sql.transaction(async sql => {
      const account = await sql.query(`SELECT autonomy_paused_at FROM app.accounts WHERE id = $1::uuid FOR UPDATE`, [accountId]);
      const action = await sql.query(`SELECT state FROM app.actions WHERE id = $1::uuid FOR UPDATE`, [actionId]);
      if (!action.rows[0] || asText(action.rows[0]['state']) !== 'planned') return 'finished';
      if (isGloballyPaused() || bool(account.rows[0]?.['autonomy_paused_at'])) return 'paused';
      await sql.query(`UPDATE app.actions SET state = 'executing', started_at = now(), updated_at = now() WHERE id = $1::uuid AND state = 'planned'`, [actionId]);
      return 'run';
    });
  }
  async complete(actionId: string, accountId: string, completion: Completion, safety: PolicySafetyConfig): Promise<ActionOutcome> {
    return this.sql.transaction(async sql => {
      // Preconditions can fail while planned; every other completion must close an executing action.
      const transitioned = await sql.query(`UPDATE app.actions SET state = $2::app.action_state, provider_receipt = $3::jsonb, error_code = $4, finished_at = now(), updated_at = now() WHERE id = $1::uuid AND (state = 'executing' OR (state = 'planned' AND $2 = 'failed' AND $4 = 'PRECONDITION_MISMATCH')) RETURNING state, activity_id, kind`, [actionId, completion.outcome, JSON.stringify(completion.receipt ?? {}), completion.errorCode ?? null]);
      const row = transitioned.rows[0];
      if (!row) {
        const existing = await sql.query(`SELECT state FROM app.actions WHERE id = $1::uuid FOR UPDATE`, [actionId]);
        const state = asText(existing.rows[0]?.['state']);
        if (state === 'succeeded' || state === 'failed' || state === 'unverifiable' || state === 'incorrect') return state;
        throw new Error('POLICY_ACTION_NOT_COMPLETABLE');
      }
      const attempt = await sql.query(`SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM app.action_verifications WHERE action_id = $1::uuid`, [actionId]);
      await sql.query(`INSERT INTO app.action_verifications (action_id, attempt, state, observed, error_code) VALUES ($1::uuid, $2, $3, $4::jsonb, $5)`, [actionId, Number(attempt.rows[0]?.['attempt'] ?? 1), completion.outcome === 'succeeded' ? 'verified' : completion.outcome === 'unverifiable' ? 'unverifiable' : 'failed', JSON.stringify(completion.observed), completion.errorCode ?? null]);
      if (safetyKinds.has(asText(row['kind']) as PolicyActionKind) && (completion.outcome === 'succeeded' || completion.outcome === 'incorrect')) {
        const window = new Date(Math.floor(Date.now() / safety.windowMs) * safety.windowMs).toISOString();
        const safetyRow = await sql.query(`INSERT INTO app.safety_windows (account_id, window_started_at, verified_mutations, incorrect_mutations, updated_at) VALUES ($1::uuid, $2::timestamptz, 1, $3, now()) ON CONFLICT (account_id, window_started_at) DO UPDATE SET verified_mutations = app.safety_windows.verified_mutations + 1, incorrect_mutations = app.safety_windows.incorrect_mutations + $3, updated_at = now() RETURNING verified_mutations, incorrect_mutations`, [accountId, window, completion.outcome === 'incorrect' ? 1 : 0]);
        const stats = safetyRow.rows[0];
        if (stats && Number(stats['incorrect_mutations']) / Number(stats['verified_mutations']) >= safety.maxIncorrectRate) {
          await sql.query(`UPDATE app.accounts SET autonomy_paused_at = now(), autonomy_pause_reason = 'SAFETY_INCORRECT_RATE', updated_at = now() WHERE id = $1::uuid AND autonomy_paused_at IS NULL`, [accountId]);
          await this.audit(sql, accountId, asText(row['activity_id']), actionId, 'policy.safety_paused', { verified: Number(stats['verified_mutations']), incorrect: Number(stats['incorrect_mutations']), threshold: safety.maxIncorrectRate, window });
          // Arrivals already own a notification per activity. Create a deterministic synthetic message/activity for this account/window.
          const systemMessage = await sql.query(`INSERT INTO app.messages (account_id, provider_message_id, sender, recipients, subject, preview, received_at, is_read, is_baseline, has_attachments, created_at, updated_at) VALUES ($1::uuid, $2, $3::jsonb, '[]'::jsonb, 'Autonomous mailbox mutations paused', 'Safety monitor paused autonomous mutations after incorrect verification.', now(), false, false, false, now(), now()) ON CONFLICT (account_id, provider_message_id) DO UPDATE SET updated_at = now() RETURNING id`, [accountId, `hypermail:safety:${window}` , JSON.stringify({ address: 'safety@hypermail.system', name: 'Hypermail safety monitor' })]);
          const systemMessageId = systemMessage.rows[0] && asText(systemMessage.rows[0]['id']);
          if (!systemMessageId) throw new Error('POLICY_SAFETY_MESSAGE_INSERT_FAILED');
          const safetyActivity = await sql.query(`INSERT INTO app.activities (message_id, account_id, state, last_error_code, created_at, updated_at) VALUES ($1::uuid, $2::uuid, 'failed', 'SAFETY_INCORRECT_RATE', now(), now()) ON CONFLICT (message_id) DO UPDATE SET updated_at = now() RETURNING id`, [systemMessageId, accountId]);
          const safetyActivityId = safetyActivity.rows[0] && asText(safetyActivity.rows[0]['id']);
          if (!safetyActivityId) throw new Error('POLICY_SAFETY_ACTIVITY_INSERT_FAILED');
          await sql.query(`INSERT INTO app.logical_notifications (activity_id, state, sender_label, subject, status_label, created_at, updated_at) VALUES ($1::uuid, 'pending', 'Hypermail safety monitor', 'Autonomous mailbox mutations paused', 'Safety pause', now(), now()) ON CONFLICT (activity_id) DO NOTHING`, [safetyActivityId]);
        }
      }
      await this.audit(sql, accountId, asText(row['activity_id']), actionId, `policy.action_${completion.outcome}`, { errorCode: completion.errorCode ?? null });
      return completion.outcome;
    });
  }
  private audit(sql: PolicySqlClient, accountId: string, activityId: string | null, actionId: string, event: string, metadata: Record<string, unknown>) {
    return sql.query(`INSERT INTO app.audits (actor_type, account_id, activity_id, event, correlation_id, metadata) VALUES ('policy', $1::uuid, $2::uuid, $3, $4, $5::jsonb)`, [accountId, activityId, event, `action:${actionId}`, JSON.stringify(metadata)]);
  }
}
