import { createHash } from 'node:crypto';
import { PolicyExecutor, PostgresPolicyPersistence, policyActionInputSchema } from '@hypermail/policy';
import type { PolicyActionInput, PrivateMutationTransport } from '@hypermail/policy';
import type { ManagedSqlClient } from '@hypermail/db';
import { HypermailPolicyClient, renderDraftMarkdown, type EmailAddress, type HypermailMcpHttpClient } from '@hypermail/hypermail';
import type { JobConsumer } from './runtime.js';
import type { PgBossLike } from './pg-boss-queue.js';

type JsonObject = Readonly<Record<string, unknown>>;
type ActionRow = { activityId: string; decisionId: string; idempotencyKey: string; kind: string; target: unknown; precondition: unknown };
type DraftRow = { email: string; providerDraftId: string | null; sourceProviderMessageId: string | null; recipients: unknown; subject: string; body: string; version: number };
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
    const result = await this.database.query<{ id: string }>(`select id from app.actions where state = 'planned' order by created_at, id limit $1`, [this.limit]);
    for (const row of result.rows) await this.dispatcher.dispatch(row.id);
  }
}

/** Projects a persisted actionable decision into idempotent pending policy actions. */
export class PostgresPolicyPlanner {
  constructor(private readonly database: ManagedSqlClient, private readonly dispatcher: PgBossPolicyDispatcher) {}
  async plan(activityId: string, attempt: number, decision: JsonObject): Promise<void> {
    if (decision['state'] !== 'actionable' || !Array.isArray(decision['actions'])) return;
    const actionIds = await this.database.transaction(async database => {
      const persisted = await database.query<{ id: string; output: unknown }>(`select id, output from app.decisions where activity_id = $1::uuid and attempt = $2 for update`, [activityId, attempt]);
      const row = persisted.rows[0];
      const output = row ? json(row.output) : undefined;
      if (!row || !output || output['state'] !== 'actionable' || !Array.isArray(output['actions'])) throw new Error('POLICY_DECISION_NOT_PERSISTED');
      const ids: string[] = [];
      for (const [index, raw] of output['actions'].entries()) {
        const action = object(raw);
        const target = action && object(action['target']);
        if (!action || !target || typeof action['kind'] !== 'string') throw new Error('POLICY_DECISION_INVALID');
        const result = await database.query<{ id: string }>(`insert into app.actions (activity_id, decision_id, kind, state, idempotency_key, target, precondition, created_at, updated_at)
          values ($1::uuid, $2::uuid, $3::app.action_kind, 'planned', $4, $5::jsonb, '{}'::jsonb, now(), now())
          on conflict (idempotency_key) do update set updated_at = app.actions.updated_at
          returning id`, [activityId, row.id, action['kind'], keyFor(row.id, index), JSON.stringify(target)]);
        const actionRow = result.rows[0];
        if (!actionRow) throw new Error('POLICY_ACTION_INSERT_FAILED');
        ids.push(actionRow.id);
      }
      return ids;
    });
    // Publishing follows the committed decision/action projection; recovery closes this crash window.
    for (const actionId of actionIds) await this.dispatcher.dispatch(actionId);
  }
}

/** Loads only durable action fields; model output and app UUIDs never reach Hypermail. */
export class PostgresPolicyActionInputStore {
  constructor(private readonly database: ManagedSqlClient) {}
  async get(actionId: string): Promise<PolicyActionInput | null> {
    const result = await this.database.query<ActionRow>(`select activity_id as "activityId", decision_id as "decisionId", idempotency_key as "idempotencyKey", kind, target, precondition from app.actions where id = $1::uuid`, [actionId]);
    const row = result.rows[0];
    return row ? policyActionInputSchema.parse({ ...row, target: json(row.target), precondition: json(row.precondition) }) : null;
  }
}

/** Concrete, deliberately tiny MCP mutation boundary. All app IDs are resolved through DB first. */
export class HypermailPrivateMutationTransport implements PrivateMutationTransport {
  private readonly policyClient: HypermailPolicyClient | undefined;
  constructor(private readonly database: ManagedSqlClient, private readonly client: Pick<HypermailMcpHttpClient, 'call'> | undefined, private readonly initialize: () => Promise<unknown>) { this.policyClient = client ? new HypermailPolicyClient(client) : undefined; }
  private async draft(target: { accountId: string; draftId: string }): Promise<DraftRow> {
    const result = await this.database.query<DraftRow>(`select a.email, d.provider_draft_id as "providerDraftId", m.provider_message_id as "sourceProviderMessageId", d.recipients, d.subject, d.body, d.version
      from app.drafts d join app.accounts a on a.id = d.account_id left join app.messages m on m.id = d.source_message_id
      where d.id = $1::uuid and d.account_id = $2::uuid`, [target.draftId, target.accountId]);
    const row = result.rows[0]; if (!row) throw new Error('POLICY_DRAFT_NOT_FOUND'); return row;
  }
  private async retainProviderDraftId(target: { accountId: string; draftId: string }, providerDraftId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(`update app.drafts set provider_draft_id = $1, updated_at = now() where id = $2::uuid and account_id = $3::uuid returning id`, [providerDraftId, target.draftId, target.accountId]);
    if (!result.rows[0]) throw new Error('POLICY_DRAFT_PROVIDER_ID_NOT_RETAINED');
  }
  private async previousDraftBodies(draftId: string, beforeVersion: number): Promise<string[]> {
    const result = await this.database.query<{ body: string }>(`select snapshot->>'body' as body from app.draft_revisions where draft_id = $1::uuid and version < $2 and snapshot ? 'body' order by version desc limit 20`, [draftId, beforeVersion]);
    return result.rows.map((row) => renderDraftMarkdown(row.body).trim()).filter((body) => body.length > 0);
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
    const result = await this.policyClient.createDraft({ account: draft.email, ...addresses, subject: draft.subject, body: draft.body, ...(draft.sourceProviderMessageId ? { inReplyTo: draft.sourceProviderMessageId } : {}) });
    await this.retainProviderDraftId(target, result.id); return { providerDraftId: result.id, ...(result.draftHtml !== undefined ? { draftHtml: result.draftHtml } : {}) };
  }
  async draftEdit({ target }: Parameters<PrivateMutationTransport['draftEdit']>[0]): Promise<JsonObject> {
    if (!this.policyClient) throw new Error('POLICY_TRANSPORT_UNAVAILABLE'); await this.initialize();
    const draft = await this.draft(target); if (!draft.providerDraftId) throw new Error('POLICY_DRAFT_PROVIDER_ID_MISSING');
    const current = await this.policyClient.readDraft(draft.email, draft.providerDraftId, 'html'); if (!current.body) throw new Error('POLICY_DRAFT_BODY_UNEDITABLE'); const addresses = recipients(draft.recipients);
    const candidates = await this.previousDraftBodies(target.draftId, draft.version); const providerBody = current.body.trimStart();
    const exact = candidates.find((body) => providerBody.startsWith(body) && providerBody.indexOf(body) === providerBody.lastIndexOf(body));
    if (!exact) throw new Error('POLICY_DRAFT_BODY_SELECTION_UNVERIFIED');
    const bodyEdit = exact === draft.body ? {} : { oldText: exact, newText: draft.body };
    const result = await this.policyClient.editDraft({ account: draft.email, id: draft.providerDraftId, ...addresses, subject: draft.subject, ...bodyEdit });
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

export class DeliverPolicyConsumer implements JobConsumer {
  constructor(private readonly input: PostgresPolicyActionInputStore, private readonly executor: Pick<PolicyExecutor, 'execute'>) {}
  async consume(payload: Parameters<JobConsumer['consume']>[0]): Promise<void> {
    if (!('actionId' in payload)) throw new Error('QUEUE_PAYLOAD_INVALID');
    const action = await this.input.get(payload.actionId);
    if (action) await this.executor.execute(action);
  }
}

export const createPolicyExecutor = (database: ManagedSqlClient, transport: PrivateMutationTransport, threshold: number) =>
  new PolicyExecutor({ persistence: new PostgresPolicyPersistence(database), transport, isGloballyPaused: () => false, safety: { maxIncorrectRate: threshold } });
