import { createHash } from 'node:crypto';
import { PolicyExecutor, PostgresPolicyPersistence, policyActionInputSchema } from '@hypermail/policy';
import type { PolicyActionInput, PrivateMutationTransport } from '@hypermail/policy';
import type { ManagedSqlClient } from '@hypermail/db';
import { HypermailPolicyClient, renderDraftMarkdown, type EmailAddress, type HypermailMcpHttpClient } from '@hypermail/hypermail';
import type { JobConsumer } from './runtime.js';
import type { PgBossLike } from './pg-boss-queue.js';

type JsonObject = Readonly<Record<string, unknown>>;
type CanonicalRunRow = Record<string, unknown> & { grant_capabilities: unknown; safety_capabilities: unknown };
type ActionRow = { actionId: string; runId: string; userId: string; accountId: string; activityId: string; decisionId: string; idempotencyKey: string; kind: string; target: unknown; precondition: unknown };
type DraftBodyFormat = 'markdown' | 'html';
type DraftRow = { email: string; providerDraftId: string | null; sourceProviderMessageId: string | null; recipients: unknown; subject: string; body: string; bodyFormat: DraftBodyFormat; version: number };
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const json = (value: unknown): JsonObject => {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) ?? {}; } catch { return {}; }
  }
  return object(value) ?? {};
};
const recipients = (value: unknown): { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] } => {
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!Array.isArray(raw)) throw new Error('POLICY_DRAFT_RECIPIENTS_INVALID');
  const result = { to: [] as EmailAddress[], cc: [] as EmailAddress[], bcc: [] as EmailAddress[] };
  for (const entry of raw) {
    const item = object(entry); const kind = item?.['kind']; const address = item?.['address']; const name = item?.['name'];
    if ((kind !== 'to' && kind !== 'cc' && kind !== 'bcc') || typeof address !== 'string' || (name !== undefined && typeof name !== 'string')) throw new Error('POLICY_DRAFT_RECIPIENTS_INVALID');
    result[kind].push({ address, ...(typeof name === 'string' ? { name } : {}) });
  }
  if (result.to.length === 0) throw new Error('POLICY_DRAFT_TO_REQUIRED');
  return result;
};
const keyFor = (decisionId: string, index: number): string => `policy:${createHash('sha256').update(`${decisionId}:${String(index)}`).digest('hex')}`;
const uuidFor = (seed: string): string => { const hex=createHash('sha256').update(seed).digest('hex'); const variant=['8','9','a','b'][Number.parseInt(hex.charAt(16),16)&3] ?? '8'; return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${variant}${hex.slice(17,20)}-${hex.slice(20,32)}`; };
const capabilityFor = (kind: string): string | undefined => ({ archive:'mail.archive',recoverable_trash:'mail.trash_recoverable',move:'mail.move',mark_read:'mail.mark_read',mark_unread:'mail.mark_unread',draft_create:'draft.create',draft_edit:'draft.edit' } as Record<string,string>)[kind];

/** Sends only durable policy jobs and gives pg-boss a stable deduplication key. */
export class PgBossPolicyDispatcher {
  constructor(private readonly boss: PgBossLike) {}
  async dispatch(actionId: string): Promise<void> {
    const id = await this.boss.send('policy.execute', { actionId }, { singletonKey: `policy:execute:${actionId}` });
    if (!id) throw new Error('pg-boss did not return a policy job id');
  }
}

/** Replays planned actions after a crash between durable planning and queue publication. */
export class DurablePolicyRecovery {
  constructor(private readonly database: ManagedSqlClient, private readonly dispatcher: PgBossPolicyDispatcher, private readonly limit = 100) {}
  async recover(): Promise<void> {
    const result = await this.database.query<{ id: string }>(`select id from (select id,authorized_at as queued_at from app.agent_authorized_actions where state in ('authorized','executing','verifying') union all select id,created_at as queued_at from app.actions where state='planned') recoverable order by queued_at,id limit $1`, [this.limit]);
    for (const row of result.rows) await this.dispatcher.dispatch(row.id);
  }
}

/** Authorizes each mutation against its frozen canonical Run, then dual-writes legacy projection. */
export class PostgresPolicyPlanner {
  constructor(private readonly database: ManagedSqlClient, private readonly dispatcher: PgBossPolicyDispatcher) {}
  async plan(activityId: string, attempt: number, decision: JsonObject): Promise<void> {
    if (decision['state'] !== 'actionable' || !Array.isArray(decision['actions'])) return;
    const actionIds=await this.database.transaction(async database => {
      const persisted=await database.query<{id:string;output:unknown}>(`select id,output from app.decisions where activity_id=$1::uuid and attempt=$2 for update`,[activityId,attempt]);
      const decisionRow=persisted.rows[0]; const output=decisionRow ? json(decisionRow.output) : undefined;
      if (!decisionRow || !output || output['state']!=='actionable' || !Array.isArray(output['actions'])) throw new Error('POLICY_DECISION_NOT_PERSISTED');
      const runResult=await database.query<CanonicalRunRow>(`select r.*,g.capabilities as grant_capabilities,s.capabilities as safety_capabilities
        from app.agent_jobs j join app.agent_runs r on r.id=j.agent_run_id
        join app.agent_capability_grant_revisions g on g.grant_id=r.grant_id and g.revision=r.grant_revision and g.user_id=r.user_id and g.account_id=r.account_id
        join app.agent_safety_ceiling_revisions s on s.revision=r.safety_revision
        where j.activity_id=$1::uuid for update of r`,[activityId]);
      const run=runResult.rows[0]; if (!run || run['state']!=='running') throw new Error('POLICY_CANONICAL_RUN_NOT_RUNNING');
      const allowed=new Set((Array.isArray(run.grant_capabilities)?run.grant_capabilities:[]).filter((value):value is string=>typeof value==='string'));
      const ceiling=new Set((Array.isArray(run.safety_capabilities)?run.safety_capabilities:[]).filter((value):value is string=>typeof value==='string'));
      const ids:string[]=[];
      for (const [index,raw] of output['actions'].entries()) {
        const action=object(raw); const rawTarget=action&&object(action['target']); const kind=action?.['kind']; const capability=typeof kind==='string'?capabilityFor(kind):undefined;
        if (!action||!rawTarget||typeof kind!=='string'||!capability) throw new Error('POLICY_DECISION_INVALID');
        if (!allowed.has(capability)||!ceiling.has(capability)) { await this.event(database,run,{type:'authorization_denied',runId:String(run['id']),reasonCode:'CAPABILITY_NOT_FROZEN'}); continue; }
        if (typeof rawTarget['accountId']!=='string' || typeof run['account_id']!=='string' || rawTarget['accountId']!==run['account_id']) throw new Error('POLICY_TARGET_OUTSIDE_RUN_MAILBOX');
        const target={...rawTarget}; delete target['accountId'];
        if (kind==='draft_create') {
          const proposed='draft' in action && action['draft'] && typeof action['draft']==='object' ? action['draft'] as {to:{address:string}[];cc?:{address:string}[];subject:string;body:string} : undefined;
          const draftId=uuidFor(`draft:${decisionRow.id}:${String(index)}`);
          await database.query(`insert into app.drafts (id,account_id,source_message_id,created_by,state,recipients,subject,body,body_format,version)
            values ($1::uuid,$2::uuid,$3::uuid,'agent','editing',$4::jsonb,$5,$6,'markdown',1)
            on conflict (id) do nothing`,[draftId,run['account_id'],run['message_id']??null,
            JSON.stringify([...(proposed?.to??[]).map((r)=>({kind:'to',address:r.address})),...(proposed?.cc??[]).map((r)=>({kind:'cc',address:r.address}))]),
            proposed?.subject??'', proposed?.body??'']);
          await database.query(`insert into app.draft_revisions (draft_id,version,editor,snapshot) values ($1::uuid,1,'agent',$2::jsonb) on conflict (draft_id,version) do nothing`,[draftId,JSON.stringify({recipients:[...(proposed?.to??[]).map((r)=>({kind:'to',address:r.address})),...(proposed?.cc??[]).map((r)=>({kind:'cc',address:r.address}))],subject:proposed?.subject??'',body:proposed?.body??'',bodyFormat:'markdown'})]);
          target['draftId']=draftId;
        }
        const id=uuidFor(`canonical-action:${decisionRow.id}:${String(index)}`); const key=keyFor(decisionRow.id,index);
        const inserted=await database.query<{id:string}>(`insert into app.agent_authorized_actions
          (id,activity_id,run_id,user_id,account_id,correlation_id,causation_id,manager_kind,manager_connection_id,manager_legacy_source_id,manager_lifecycle_revision,mode,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,kind,target,authorization_revision,idempotency_key,attempt,retry_of_action_id,state,authorized_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,1,null,'authorized',now())
          on conflict(user_id,account_id,idempotency_key) do nothing returning id`,[id,activityId,run['id'],run['user_id'],run['account_id'],run['correlation_id'],decisionRow.id,run['manager_kind'],run['manager_connection_id']??null,run['manager_legacy_source_id']??null,run['manager_lifecycle_revision']??null,run['mode'],run['assignment_id'],run['assignment_revision'],run['grant_id'],run['grant_revision'],run['safety_revision'],kind,JSON.stringify(target),Number(run['grant_revision']),key]);
        const canonicalId=inserted.rows[0]?.id ?? id;
        if (inserted.rows[0]) await this.event(database,run,{type:'action_authorized',runId:String(run['id']),actionId:canonicalId});
        // Compatibility only: execution/recovery authority always reads canonical tables.
        await database.query(`insert into app.actions(id,activity_id,decision_id,kind,state,idempotency_key,target,precondition,created_at,updated_at)
          values($1,$2,$3,$4,'planned',$5,$6::jsonb,'{}'::jsonb,now(),now()) on conflict(idempotency_key) do nothing`,[canonicalId,activityId,decisionRow.id,kind,key,JSON.stringify(rawTarget)]);
        ids.push(canonicalId);
      }
      if (ids.length===0) {
        await this.event(database,run,{type:'no_action',runId:String(run['id']),reason:output['actions'].length===0?'The decision requested no mailbox mutation.':'All requested mutations were denied by frozen authority.'});
        await database.query(`update app.agent_activities set state=$2::app.agent_activity_state,revision=revision+1,updated_at=now() where id=$1::uuid and state='open'`,[activityId,output['actions'].length===0?'resolved':'attention_required']);
      }
      return ids;
    });
    for (const id of actionIds) await this.dispatcher.dispatch(id);
  }
  private async event(database:Pick<ManagedSqlClient, 'query'>,run:Readonly<Record<string,unknown>>,detail:Record<string,unknown>):Promise<void> {
    await database.query(`select id from app.agent_activities where id=$1::uuid and user_id=$2::uuid and account_id=$3::uuid for update`,[run['activity_id'],run['user_id'],run['account_id']]);
    const next=await database.query<{sequence:number}>(`select coalesce(max(sequence),0)::integer+1 as sequence from app.agent_activity_events where activity_id=$1::uuid`,[run['activity_id']]);
    await database.query(`insert into app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,causation_id,occurred_at,detail)
      values($1,$2,$3,$4,$5,$6,clock_timestamp(),$7::jsonb)`,[run['activity_id'],run['user_id'],run['account_id'],next.rows[0]?.sequence??1,run['correlation_id'],run['id'],JSON.stringify(detail)]);
  }
}

/** Loads only durable action fields; model output and app UUIDs never reach Hypermail. */
export class PostgresPolicyActionInputStore {
  constructor(private readonly database: ManagedSqlClient) {}
  async get(actionId: string): Promise<PolicyActionInput | null> {
    const result = await this.database.query<ActionRow>(`select ca.id as "actionId",ca.run_id as "runId",ca.user_id as "userId",ca.account_id as "accountId",ca.activity_id as "activityId",ca.causation_id as "decisionId",ca.idempotency_key as "idempotencyKey",ca.kind,ca.target,coalesce(la.precondition,'{}'::jsonb) as precondition from app.agent_authorized_actions ca left join app.actions la on la.id=ca.id where ca.id=$1::uuid`, [actionId]);
    const row = result.rows[0];
    return row ? policyActionInputSchema.parse({ ...row, target: { accountId: row.accountId, ...json(row.target) }, precondition: json(row.precondition) }) : null;
  }
}

/** Concrete, deliberately tiny MCP mutation boundary. All app IDs are resolved through DB first. */
export class HypermailPrivateMutationTransport implements PrivateMutationTransport {
  private readonly policyClient: HypermailPolicyClient | undefined;
  constructor(private readonly database: ManagedSqlClient, private readonly client: Pick<HypermailMcpHttpClient, 'call'> | undefined, private readonly initialize: () => Promise<unknown>) { this.policyClient = client ? new HypermailPolicyClient(client) : undefined; }
  private async draft(target: { accountId: string; draftId: string }): Promise<DraftRow> {
    const result = await this.database.query<DraftRow>(`select a.email, d.provider_draft_id as "providerDraftId", m.provider_message_id as "sourceProviderMessageId", d.recipients, d.subject, d.body, d.body_format as "bodyFormat", d.version
      from app.drafts d join app.accounts a on a.id = d.account_id left join app.messages m on m.id = d.source_message_id
      where d.id = $1::uuid and d.account_id = $2::uuid`, [target.draftId, target.accountId]);
    const row = result.rows[0]; if (!row) throw new Error('POLICY_DRAFT_NOT_FOUND'); return row;
  }
  private async retainProviderDraftId(target: { accountId: string; draftId: string }, providerDraftId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(`update app.drafts set provider_draft_id = $1, updated_at = now() where id = $2::uuid and account_id = $3::uuid returning id`, [providerDraftId, target.draftId, target.accountId]);
    if (!result.rows[0]) throw new Error('POLICY_DRAFT_PROVIDER_ID_NOT_RETAINED');
  }
  private async previousDraftBodies(draftId: string, beforeVersion: number): Promise<string[]> {
    const result = await this.database.query<{ body: string; bodyFormat: string | null }>(`select snapshot->>'body' as body, snapshot->>'bodyFormat' as "bodyFormat" from app.draft_revisions where draft_id = $1::uuid and version < $2 and snapshot ? 'body' order by version desc limit 20`, [draftId, beforeVersion]);
    return result.rows.map((row) => (row.bodyFormat === 'html' ? row.body : renderDraftMarkdown(row.body)).trim()).filter((body) => body.length > 0);
  }
  private policy(): HypermailPolicyClient { if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); return this.policyClient; }
  private async retainProviderMessageId(target: { accountId: string; messageId: string }, providerMessageId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(`update app.messages set provider_message_id = $1, updated_at = now() where id = $2::uuid and account_id = $3::uuid returning id`, [providerMessageId, target.messageId, target.accountId]);
    if (!result.rows[0]) throw new Error('POLICY_MESSAGE_PROVIDER_ID_NOT_RETAINED');
  }
  private async message(target: { accountId: string; messageId: string }): Promise<{ account: string; id: string }> {
    const result = await this.database.query<{ email: string; providerMessageId: string }>(`select a.email, m.provider_message_id as "providerMessageId" from app.messages m join app.accounts a on a.id = m.account_id where m.id = $1::uuid and m.account_id = $2::uuid`, [target.messageId, target.accountId]);
    const row = result.rows[0];
    if (!row) throw new Error('POLICY_MESSAGE_NOT_FOUND');
    return { account: row.email, id: row.providerMessageId };
  }
  private async mutateMessage(target: { accountId: string; messageId: string }, operation: (client: HypermailPolicyClient, message: { account: string; id: string }) => Promise<{ id: string }>): Promise<JsonObject> {
    await this.initialize(); const message = await this.message(target); const result = await operation(this.policy(), message); await this.retainProviderMessageId(target, result.id); return { providerMessageId: result.id };
  }
  archive({ target }: Parameters<PrivateMutationTransport['archive']>[0]): Promise<JsonObject> { return this.mutateMessage(target, (client, message) => client.archive(message.account, message.id)); }
  recoverableTrash({ target }: Parameters<PrivateMutationTransport['recoverableTrash']>[0]): Promise<JsonObject> { return this.mutateMessage(target, (client, message) => client.trash(message.account, message.id)); }
  markRead({ target }: Parameters<PrivateMutationTransport['markRead']>[0]): Promise<JsonObject> { return this.mutateMessage(target, (client, message) => client.mark(message.account, message.id, true)); }
  markUnread({ target }: Parameters<PrivateMutationTransport['markUnread']>[0]): Promise<JsonObject> { return this.mutateMessage(target, (client, message) => client.mark(message.account, message.id, false)); }
  async move({ target }: Parameters<PrivateMutationTransport['move']>[0]): Promise<JsonObject> {
    const result = await this.database.query<{ providerFolderId: string }>(`select provider_folder_id as "providerFolderId" from app.folders where id = $1::uuid and account_id = $2::uuid`, [target.destinationFolderId, target.accountId]);
    const folder = result.rows[0]; if (!folder) throw new Error('POLICY_FOLDER_NOT_FOUND');
    return this.mutateMessage(target, (client, message) => client.move(message.account, message.id, folder.providerFolderId));
  }
  async draftCreate({ target, idempotencyKey }: Parameters<PrivateMutationTransport['draftCreate']>[0]): Promise<JsonObject> {
    if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
    const prior = await this.database.query<{ id: string }>(`select id from app.actions where kind = 'draft_create' and target->>'accountId' = $1 and target->>'draftId' = $2 and idempotency_key <> $3 and state in ('executing', 'succeeded', 'unverifiable') limit 1`, [target.accountId, target.draftId, idempotencyKey]);
    if (prior.rows[0]) throw new Error('POLICY_DRAFT_CREATE_ALREADY_ATTEMPTED');
    const draft = await this.draft(target); const addresses = recipients(draft.recipients);
    const result = await this.policyClient.createDraft({ account: draft.email, ...addresses, subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat, ...(draft.sourceProviderMessageId ? { inReplyTo: draft.sourceProviderMessageId } : {}) });
    await this.retainProviderDraftId(target, result.id); return { providerDraftId: result.id, ...(result.draftHtml !== undefined ? { draftHtml: result.draftHtml } : {}) };
  }
  async draftEdit({ target }: Parameters<PrivateMutationTransport['draftEdit']>[0]): Promise<JsonObject> {
    if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
    const draft = await this.draft(target); if (!draft.providerDraftId) throw new Error('POLICY_DRAFT_PROVIDER_ID_MISSING');
    const current = await this.policyClient.readDraft(draft.email, draft.providerDraftId, 'html'); if (!current.body) throw new Error('POLICY_DRAFT_BODY_UNEDITABLE'); const addresses = recipients(draft.recipients);
    const candidates = await this.previousDraftBodies(target.draftId, draft.version); const providerBody = current.body.trimStart();
    const exact = candidates.find((body) => providerBody.startsWith(body) && providerBody.indexOf(body) === providerBody.lastIndexOf(body));
    if (!exact) throw new Error('POLICY_DRAFT_BODY_SELECTION_UNVERIFIED');
    const renderedBody = (draft.bodyFormat === 'html' ? draft.body : renderDraftMarkdown(draft.body)).trim();
    const bodyEdit = exact === renderedBody ? {} : { oldText: exact, newText: draft.body };
    const result = await this.policyClient.editDraft({ account: draft.email, id: draft.providerDraftId, ...addresses, subject: draft.subject, bodyFormat: draft.bodyFormat, ...bodyEdit });
    await this.retainProviderDraftId(target, result.id); return { providerDraftId: result.id, ...(result.draftHtml !== undefined ? { draftHtml: result.draftHtml } : {}) };
  }
  async read(target: PolicyActionInput['target'], kind?: PolicyActionInput['kind']): Promise<JsonObject | null> {
    if ('draftId' in target) {
      if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
      const draft = await this.draft(target); if (!draft.providerDraftId) return null;
      await this.policyClient.readDraft(draft.email, draft.providerDraftId); return { draftId: target.draftId };
    }
    const message = await this.message(target); if (!this.client) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
    const observed = json(await this.client.call('read_email', { account: message.account, id: message.id, format: 'text' }));
    const state: Record<string, unknown> = { ...(typeof observed['isRead'] === 'boolean' ? { isRead: observed['isRead'] } : {}) };
    if (kind === 'archive' && await this.policy().containsMessageInFolder(message.account, message.id, 'archive')) state['folderRole'] = 'archive';
    if (kind === 'recoverable_trash' && await this.policy().containsMessageInFolder(message.account, message.id, 'deleteditems')) state['folderRole'] = 'trash';
    if (kind === 'move' && 'destinationFolderId' in target) {
      const result = await this.database.query<{ providerFolderId: string }>(`select provider_folder_id as "providerFolderId" from app.folders where id = $1::uuid and account_id = $2::uuid`, [target.destinationFolderId, target.accountId]); const folder = result.rows[0];
      if (folder && await this.policy().containsMessageInFolder(message.account, message.id, folder.providerFolderId)) state['folderId'] = target.destinationFolderId;
    }
    return state;
  }
}

type TenantPolicyExecutorLease = Readonly<{ executor: Pick<PolicyExecutor, 'execute'>; release(): Promise<void> }>;
type TenantPolicyExecutorFactory = (userId: string) => Promise<TenantPolicyExecutorLease>;
export class DeliverPolicyConsumer implements JobConsumer {
  constructor(private readonly input: PostgresPolicyActionInputStore, private readonly executor: Pick<PolicyExecutor, 'execute'> | TenantPolicyExecutorFactory) {}
  async consume(payload: Parameters<JobConsumer['consume']>[0]): Promise<void> {
    if (!('actionId' in payload)) throw new Error('QUEUE_PAYLOAD_INVALID');
    const action = await this.input.get(payload.actionId);
    if (!action) return;
    if (typeof this.executor !== 'function') { await this.executor.execute(action); return; }
    const lease = await this.executor(action.userId);
    try { await lease.executor.execute(action); } finally { await lease.release(); }
  }
}

export const createPolicyExecutor = (database: ManagedSqlClient, transport: PrivateMutationTransport, threshold: number) =>
  new PolicyExecutor({ persistence: new PostgresPolicyPersistence(database), transport, isGloballyPaused: () => false, safety: { maxIncorrectRate: threshold } });
