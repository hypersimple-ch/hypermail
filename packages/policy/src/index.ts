import { createHash } from 'node:crypto';
import { enqueueMailboxMemoryEventInTransaction, type SqlClient as MemorySqlClient } from '@hypermail/db';
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
  actionId: id,
  runId: id,
  userId: id,
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
  reportProvider(actionId: string, accountId: string, receipt: ProviderReceipt): Promise<void>;
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
    if (ready === 'finished') {
      const afterFence = await this.options.persistence.claim(input, this.options.isGloballyPaused);
      if (afterFence.outcome) return { actionId: afterFence.actionId, outcome: afterFence.outcome };
      throw new Error('POLICY_ACTION_NOT_READY');
    }

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

    // A connector report is durable progress, never success. Hypermail readback alone decides verification.
    await this.options.persistence.reportProvider(claim.actionId, claim.accountId, receipt);
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
const mailboxMemorySql = (sql: PolicySqlClient): Pick<MemorySqlClient, 'query'> => ({
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required by the shared SqlClient contract.
  query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) =>
    ({ rows: [...(await sql.query(statement, values)).rows] as Row[] }),
});
const bool = (value: unknown) => value === true || value === 'true';
const asText = (value: unknown) => String(value);
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(asText(value)).toISOString();
const jsonObject = (value: unknown): Record<string, unknown> => typeof value === 'string' ? record(JSON.parse(value)) : record(value);
const canonical = (value: unknown): string => value && typeof value === 'object' && !Array.isArray(value) ? `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);


const canonicalDigest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
/** Canonical PostgreSQL adapter. It never creates Actions: authorization is a planner concern. */
export class PostgresPolicyPersistence implements PolicyPersistence {
  constructor(private readonly sql: PolicySqlClient) {}

  async claim(input: PolicyActionInput, isGloballyPaused: () => boolean): Promise<Claim> {
    return this.sql.transaction(async sql => {
      const result = await sql.query(`SELECT a.*, ac.autonomy_paused_at,ac.state AS account_state
        FROM app.agent_authorized_actions a JOIN app.accounts ac ON ac.id=a.account_id
        WHERE a.id=$1::uuid AND a.user_id=$2::uuid AND a.account_id=$3::uuid FOR UPDATE OF a,ac`,
      [input.actionId,input.userId,input.target.accountId]);
      const row=result.rows[0];
      if (!row) throw new Error('POLICY_ACTION_NOT_FOUND');
      if (asText(row['activity_id'])!==input.activityId || asText(row['run_id'])!==input.runId
        || asText(row['kind'])!==input.kind || asText(row['idempotency_key'])!==input.idempotencyKey
        || canonical(jsonObject(row['target']))!==canonical(this.canonicalTarget(input.target))) throw new Error('POLICY_IDEMPOTENCY_CONFLICT');
      const state=asText(row['state']);
      const outcome: ActionOutcome|undefined = state==='verified' ? 'succeeded'
        : state==='failed' ? 'failed' : state==='unverifiable' ? 'unverifiable' : undefined;
      if (outcome) return { actionId: input.actionId, accountId: input.target.accountId, outcome, run:false };
      if (state==='cancelled') return { actionId: input.actionId, accountId: input.target.accountId, outcome:'failed', run:false };
      const active = ['ready','degraded'].includes(asText(row['account_state']));
      return { actionId:input.actionId, accountId:input.target.accountId,
        run: active && (state==='executing' || state==='verifying' || (state==='authorized' && !isGloballyPaused() && !bool(row['autonomy_paused_at']))),
        recover: active && (state==='executing' || state==='verifying') };
    });
  }

  async claimImmediatelyBeforeMutation(actionId:string, accountId:string, isGloballyPaused:()=>boolean):Promise<'run'|'paused'|'finished'> {
    return this.sql.transaction(async sql => {
      const result=await sql.query(`SELECT a.state,a.user_id,a.run_id,a.kind,a.mode,a.assignment_id,a.assignment_revision,
          a.grant_id,a.grant_revision,a.safety_revision,ac.autonomy_paused_at,ac.state AS account_state,
          ma.id AS current_assignment_id,ma.revision AS current_assignment_revision,
          g.id AS current_grant_id,g.revision AS current_grant_revision,g.state AS grant_state,
          g.capabilities AS grant_capabilities,g.invocation_modes AS grant_modes,
          s.revision AS current_safety_revision,s.capabilities AS safety_capabilities,s.invocation_modes AS safety_modes
        FROM app.agent_authorized_actions a JOIN app.accounts ac ON ac.id=a.account_id
        LEFT JOIN app.mailbox_manager_assignments ma ON ma.user_id=a.user_id AND ma.account_id=a.account_id
        LEFT JOIN app.agent_capability_grants g ON g.user_id=a.user_id AND g.account_id=a.account_id
          AND g.manager_kind::text=a.manager_kind::text AND g.agent_connection_id IS NOT DISTINCT FROM a.manager_connection_id
        LEFT JOIN app.agent_safety_ceiling s ON s.singleton=true
        WHERE a.id=$1::uuid AND a.account_id=$2::uuid FOR UPDATE OF a,ac`,[actionId,accountId]);
      const row=result.rows[0];
      if (!row || asText(row['state'])!=='authorized') return 'finished';
      const capability=this.capability(asText(row['kind']));
      if (isGloballyPaused() || bool(row['autonomy_paused_at'])) return 'paused';
      const allowed=['ready','degraded'].includes(asText(row['account_state']))
        && asText(row['current_assignment_id'])===asText(row['assignment_id'])
        && Number(row['current_assignment_revision'])===Number(row['assignment_revision'])
        && asText(row['current_grant_id'])===asText(row['grant_id'])
        && Number(row['current_grant_revision'])===Number(row['grant_revision']) && asText(row['grant_state'])==='active'
        && Number(row['current_safety_revision'])===Number(row['safety_revision'])
        && this.array(row['grant_capabilities']).includes(capability) && this.array(row['safety_capabilities']).includes(capability)
        && this.array(row['grant_modes']).includes(asText(row['mode'])) && this.array(row['safety_modes']).includes(asText(row['mode']));
      if (!allowed) {
        const cancelled=await sql.query(`UPDATE app.agent_authorized_actions SET state='cancelled',completed_at=now()
          WHERE id=$1::uuid AND state='authorized' RETURNING activity_id,user_id,account_id,run_id,correlation_id`,[actionId]);
        const denied=cancelled.rows[0];
        if (denied) {
          await this.event(sql,denied,'authorization_denied',{runId:asText(denied['run_id']),reasonCode:'FROZEN_AUTHORITY_REVOKED'});
          await this.aggregateActivity(sql,denied);
        }
        return 'finished';
      }
      const updated=await sql.query(`UPDATE app.agent_authorized_actions SET state='executing',started_at=now()
        WHERE id=$1::uuid AND state='authorized' RETURNING activity_id,user_id,account_id,run_id,correlation_id`,[actionId]);
      const action=updated.rows[0]; if (!action) return 'finished';
      await sql.query(`UPDATE app.actions SET state='executing',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1::uuid AND state='planned'`,[actionId]);
      await this.event(sql,action,'action_started',{runId:asText(action['run_id']),actionId});
      return 'run';
    });
  }

  async reportProvider(actionId:string, accountId:string, receipt:ProviderReceipt):Promise<void> {
    void receipt;
    await this.sql.transaction(async sql => {
      const updated=await sql.query(`UPDATE app.agent_authorized_actions SET state='verifying',provider_reported_at=now()
        WHERE id=$1::uuid AND account_id=$2::uuid AND state='executing'
        RETURNING activity_id,user_id,account_id,run_id,correlation_id`,[actionId,accountId]);
      const action=updated.rows[0]; if (!action) throw new Error('POLICY_ACTION_NOT_REPORTABLE');
      await this.event(sql,action,'action_provider_reported',{runId:asText(action['run_id']),actionId});
    });
  }

  async complete(actionId:string, accountId:string, completion:Completion, safety:PolicySafetyConfig):Promise<ActionOutcome> {
    void safety;
    return this.sql.transaction(async sql => {
      const found=await sql.query(`SELECT * FROM app.agent_authorized_actions WHERE id=$1::uuid AND account_id=$2::uuid FOR UPDATE`,[actionId,accountId]);
      let row=found.rows[0]; if (!row) throw new Error('POLICY_ACTION_NOT_FOUND');
      const terminal=asText(row['state']);
      if (terminal==='verified') return 'succeeded';
      if (terminal==='failed'||terminal==='unverifiable') return terminal;
      if (completion.outcome==='succeeded') {
        // Recovery of an interrupted dispatch preserves the absence of a connector report:
        // authoritative readback may verify executing -> verified directly, with no report event.
        if (asText(row['state'])!=='executing' && asText(row['state'])!=='verifying') throw new Error('POLICY_ACTION_NOT_COMPLETABLE');
        const priorState=asText(row['state']);
        const digest=canonicalDigest(completion.observed);
        const mutationId=this.providerMutationId(completion.receipt);
        await sql.query(`INSERT INTO app.agent_action_verifications(action_id,user_id,account_id,verifier,provider_mutation_id,evidence_digest,observed_at)
          VALUES($1::uuid,$2::uuid,$3::uuid,'hypermail_provider_readback',$4,$5,now())`,[actionId,row['user_id'],accountId,mutationId,digest]);
        const updated=await sql.query(`UPDATE app.agent_authorized_actions SET state='verified',completed_at=now()
          WHERE id=$1::uuid AND state=$2::app.agent_action_state RETURNING *`,[actionId,priorState]);
        row=updated.rows[0]; if (!row) throw new Error('POLICY_ACTION_NOT_COMPLETABLE');
        await sql.query(`UPDATE app.actions SET state='succeeded',provider_receipt=$2::jsonb,finished_at=now(),updated_at=now() WHERE id=$1::uuid AND state IN ('planned','executing')`,[actionId,JSON.stringify(completion.receipt??{})]);
        await this.event(sql,row,'action_verified',{runId:asText(row['run_id']),actionId});
        await enqueueMailboxMemoryEventInTransaction(mailboxMemorySql(sql), { userId: asText(row['user_id']), mailboxId: accountId,
          sourceType: 'agent_action', sourceId: actionId, sourceVersion: Number(row['attempt'] ?? 1), kind: 'mailbox_action_verified',
          occurredAt: iso(row['completed_at']), contentPayload: { outcome: 'verified', actionKind: asText(row['kind']), target: jsonObject(row['target']) } });
        await this.aggregateActivity(sql,row);
        return 'succeeded';
      }
      const state=completion.outcome==='unverifiable' ? 'unverifiable' : 'failed';
      const code=completion.errorCode ?? (completion.outcome==='incorrect' ? 'VERIFICATION_MISMATCH' : 'PROVIDER_MUTATION_FAILED');
      const updated=await sql.query(`UPDATE app.agent_authorized_actions SET state=$3::app.agent_action_state,
          error_code=CASE WHEN $3='failed' THEN $4 ELSE NULL END,completed_at=now()
        WHERE id=$1::uuid AND account_id=$2::uuid AND state IN ('authorized','executing','verifying') RETURNING *`,[actionId,accountId,state,code]);
      row=updated.rows[0]; if (!row) throw new Error('POLICY_ACTION_NOT_COMPLETABLE');
      await sql.query(`UPDATE app.actions SET state=$2::app.action_state,error_code=$3,finished_at=now(),updated_at=now() WHERE id=$1::uuid AND state IN ('planned','executing')`,[actionId,completion.outcome==='incorrect'?'incorrect':state,code]);
      await this.event(sql,row,state==='unverifiable'?'action_unverifiable':'action_failed',state==='unverifiable'
        ? {runId:asText(row['run_id']),actionId,reasonCode:code}:{runId:asText(row['run_id']),actionId,errorCode:code});
      await enqueueMailboxMemoryEventInTransaction(mailboxMemorySql(sql), { userId: asText(row['user_id']), mailboxId: accountId,
        sourceType: 'agent_action', sourceId: actionId, sourceVersion: Number(row['attempt'] ?? 1),
        kind: state === 'unverifiable' ? 'mailbox_action_unverifiable' : 'mailbox_action_failed',
        occurredAt: iso(row['completed_at']), contentPayload: { outcome: state, actionKind: asText(row['kind']), target: jsonObject(row['target']) } });
      await this.aggregateActivity(sql,row);
      return completion.outcome;
    });
  }

  private canonicalTarget(target:PolicyActionInput['target']):Record<string,unknown> {
    const canonicalTarget:Record<string,unknown>={...target}; delete canonicalTarget['accountId']; return canonicalTarget;
  }
  private capability(kind:string):string { return ({archive:'mail.archive',recoverable_trash:'mail.trash_recoverable',move:'mail.move',mark_read:'mail.mark_read',mark_unread:'mail.mark_unread',draft_create:'draft.create',draft_edit:'draft.edit'} as Record<string,string>)[kind] ?? 'DENIED'; }
  private array(value:unknown):string[] { return Array.isArray(value) ? value.map(String) : typeof value==='string' ? value.replace(/[{}]/g,'').split(',').filter(Boolean) : []; }
  private providerMutationId(receipt:ProviderReceipt|undefined):string|null { const value=receipt?.['providerMutationId'] ?? receipt?.['providerMessageId'] ?? receipt?.['providerDraftId'] ?? receipt?.['id']; return typeof value==='string'&&value.length ? value : null; }
  private async aggregateActivity(sql:PolicySqlClient,row:SqlRow):Promise<void> {
    const summary=await sql.query(`SELECT count(*) FILTER (WHERE state IN ('authorized','executing','verifying'))::integer AS pending,
      count(*) FILTER (WHERE state IN ('failed','unverifiable','cancelled'))::integer AS attention
      FROM app.agent_authorized_actions WHERE run_id=$1::uuid`,[row['run_id']]);
    const counts=summary.rows[0]; if (Number(counts?.['pending']??0)>0) return;
    const state=Number(counts?.['attention']??0)>0?'attention_required':'resolved';
    await sql.query(`UPDATE app.agent_activities SET state=$2::app.agent_activity_state,revision=revision+1,updated_at=now()
      WHERE id=$1::uuid AND state='open'`,[row['activity_id'],state]);
  }
  private async event(sql:PolicySqlClient,row:SqlRow,type:string,detail:Record<string,unknown>):Promise<void> {
    await sql.query(`SELECT id FROM app.agent_activities WHERE id=$1::uuid AND user_id=$2::uuid AND account_id=$3::uuid FOR UPDATE`,[row['activity_id'],row['user_id'],row['account_id']]);
    const sequence=await sql.query(`SELECT coalesce(max(sequence),0)::integer+1 AS sequence FROM app.agent_activity_events WHERE activity_id=$1::uuid`,[row['activity_id']]);
    await sql.query(`INSERT INTO app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,causation_id,occurred_at,detail)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,clock_timestamp(),$7::jsonb)`,[row['activity_id'],row['user_id'],row['account_id'],Number(sequence.rows[0]?.['sequence']??1),row['correlation_id'],row['run_id'],JSON.stringify({type,...detail})]);
  }
}
