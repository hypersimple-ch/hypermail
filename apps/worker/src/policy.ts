import { PolicyExecutor, PostgresPolicyPersistence, policyActionInputSchema } from '@hypermail/policy';
import type { PolicyActionInput, PrivateMutationTransport } from '@hypermail/policy';
import { AgentProposalStore, type ManagedSqlClient } from '@hypermail/db';
import { HypermailPolicyClient, renderDraftMarkdown, type EmailAddress, type FolderLookupPage, type HypermailMcpHttpClient } from '@hypermail/hypermail';
import type { JobConsumer } from './runtime.js';
import type { PgBossLike } from './pg-boss-queue.js';

type JsonObject = Readonly<Record<string, unknown>>;
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

/** Sends only durable policy jobs and gives pg-boss a stable deduplication key. */
export class PgBossPolicyDispatcher {
  constructor(private readonly boss: PgBossLike) {}
  async dispatch(actionId: string): Promise<void> {
    const id = await this.boss.send('policy.execute', { actionId }, { singletonKey: `policy:execute:${actionId}` });
    if (!id) throw new Error('pg-boss did not return a policy job id');
  }
}

/** Recovers orphan decisions, independent ready proposals, and committed actions. */
export class DurablePolicyRecovery {
  constructor(private readonly database: ManagedSqlClient, private readonly dispatcher: PgBossPolicyDispatcher, private readonly limit = 100, private readonly threshold = 0.60) {}
  async recover(): Promise<void> {
    const store = new AgentProposalStore(this.database, this.threshold);
    await store.recoverOrphanDecisions(this.limit);
    for (const proposalId of await store.readyProposalIds(this.limit)) {
      const actionId = await store.authorizeReadyProposal(proposalId);
      if (actionId) await this.dispatcher.dispatch(actionId);
    }
    const result = await this.database.query<{ id: string }>(`select id from app.agent_authorized_actions where state in ('authorized','executing','verifying') order by authorized_at,id limit $1`, [this.limit]);
    for (const row of result.rows) await this.dispatcher.dispatch(row.id);
  }
}

/** Authorizes each durable ready proposal without re-running the model. */
export class PostgresPolicyPlanner {
  constructor(private readonly database: ManagedSqlClient, private readonly dispatcher: PgBossPolicyDispatcher, private readonly threshold = 0.60) {}
  async plan(activityId: string, attempt: number, decision: JsonObject): Promise<void> {
    if (decision['state'] !== 'actionable') return;
    const persisted = await this.database.query<{id:string}>(`select id from app.decisions where activity_id=$1 and attempt=$2 and schema_version=2`,[activityId,attempt]);
    if (!persisted.rows[0]) throw new Error('POLICY_DECISION_NOT_PERSISTED');
    const store = new AgentProposalStore(this.database, this.threshold);
    await store.materializeDecision(persisted.rows[0].id);
    const proposals = await this.database.query<{id:string}>(`select id from app.agent_action_proposals where decision_id=$1 and state='ready' order by created_at,id`,[persisted.rows[0].id]);
    for (const proposal of proposals.rows) {
      const actionId = await store.authorizeReadyProposal(proposal.id);
      if (actionId) await this.dispatcher.dispatch(actionId);
    }
  }
}

/** Loads only durable action fields; model output and app UUIDs never reach Hypermail. */
export class PostgresPolicyActionInputStore {
  constructor(private readonly database: ManagedSqlClient) {}
  async get(actionId: string): Promise<PolicyActionInput | null> {
    const result = await this.database.query<ActionRow>(`select ca.id as "actionId",ca.run_id as "runId",ca.user_id as "userId",ca.account_id as "accountId",ca.activity_id as "activityId",ca.causation_id as "decisionId",ca.idempotency_key as "idempotencyKey",ca.kind,ca.target,coalesce(la.precondition,'{}'::jsonb) as precondition from app.agent_authorized_actions ca left join app.actions la on la.id=ca.id where ca.id=$1::uuid`, [actionId]);
    const row = result.rows[0];
    return row ? policyActionInputSchema.parse({
      actionId: row.actionId, runId: row.runId, userId: row.userId, activityId: row.activityId,
      decisionId: row.decisionId, idempotencyKey: row.idempotencyKey, kind: row.kind,
      target: { accountId: row.accountId, ...json(row.target) }, precondition: json(row.precondition),
    }) : null;
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
  async read(target: PolicyActionInput['target'], kind?: PolicyActionInput['kind'], actionId?:string): Promise<JsonObject | null> {
    if ('draftId' in target) {
      if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
      const draft = await this.draft(target); if (!draft.providerDraftId) return null;
      await this.policyClient.readDraft(draft.email, draft.providerDraftId); return { draftId: target.draftId };
    }
    const message = await this.message(target); if (!this.client) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
    if(!actionId)return json(await this.client.call('read_email',{account:message.account,id:message.id,format:'text'}));
    if(kind==='archive'||kind==='recoverable_trash'||kind==='move'){
      const folders=await this.database.query<{id:string;providerFolderId:string}>(`select id,provider_folder_id as "providerFolderId" from app.folders where account_id=$1::uuid and ${kind==='move'?'id=$2::uuid':'role=$2'} limit 1`,[target.accountId,kind==='move'&&'destinationFolderId' in target?target.destinationFolderId:kind==='archive'?'archive':'trash']);
      const folder=folders.rows[0];if(!folder)return {};
      const cursors=await this.database.query<{cursor:string|null;expired:boolean;folderId:string|null}>(`select verification_cursor->>'cursor' as cursor,coalesce(verification_deadline_at,started_at+interval '15 minutes')<=clock_timestamp() as expired,verification_cursor->>'folderId' as "folderId" from app.agent_authorized_actions where id=$1::uuid`,[actionId]);
      const progress=cursors.rows[0];if(!progress||progress.expired||(progress.folderId!==null&&progress.folderId!==folder.providerFolderId))return {verificationState:'exhausted'};
      let located:FolderLookupPage;
      try{located=await this.policy().locateMessageInFolderPage(message.account,message.id,folder.providerFolderId,{...(progress.cursor?{cursor:progress.cursor}:{}),maxPages:50,timeoutMs:30_000});}catch{return {verificationState:'incomplete'};}
      await this.database.query(`update app.agent_authorized_actions set verification_cursor=$2::jsonb,verification_deadline_at=coalesce(verification_deadline_at,started_at+interval '15 minutes') where id=$1::uuid and verification_cursor->>'cursor' is not distinct from $3 and state in ('executing','verifying')`,[actionId,{folderId:folder.providerFolderId,cursor:located.nextCursor},progress.cursor]);
      if(located.state==='incomplete')return {verificationState:'incomplete'};
      return kind==='move'?{folderId:located.state==='present'?folder.id:null}:{folderRole:located.state==='present'?(kind==='archive'?'archive':'trash'):null};
    }
    const observed = json(await this.client.call('read_email', { account: message.account, id: message.id, format: 'text' }));
    return { ...(typeof observed['isRead'] === 'boolean' ? { isRead: observed['isRead'] } : {}) };
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
