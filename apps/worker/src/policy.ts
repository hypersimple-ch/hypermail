import { createHash } from 'node:crypto';
import { PolicyExecutor, PostgresPolicyPersistence, policyActionInputSchema } from '@hypermail/policy';
import type { PolicyActionInput, PrivateMutationTransport } from '@hypermail/policy';
import type { ManagedSqlClient } from '@hypermail/db';
import type { HypermailMcpHttpClient } from '@hypermail/hypermail';
import type { JobConsumer } from './runtime.js';
import type { PgBossLike } from './pg-boss-queue.js';

type JsonObject = Readonly<Record<string, unknown>>;
type ActionRow = { activityId: string; decisionId: string; idempotencyKey: string; kind: string; target: unknown; precondition: unknown };
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const json = (value: unknown): JsonObject => {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) ?? {}; } catch { return {}; }
  }
  return object(value) ?? {};
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
  constructor(private readonly database: ManagedSqlClient, private readonly client: Pick<HypermailMcpHttpClient, 'call'> | undefined, private readonly initialize: () => Promise<unknown>) {}
  private async call(name: 'archive_email' | 'trash_email' | 'move_email' | 'mark_read' | 'mark_unread', args: Record<string, string>): Promise<JsonObject> {
    if (!this.client) throw new Error('POLICY_TRANSPORT_UNAVAILABLE');
    await this.initialize();
    return json(await this.client.call(name, args));
  }
  private async message(target: { accountId: string; messageId: string }): Promise<{ account: string; id: string }> {
    const result = await this.database.query<{ email: string; providerMessageId: string }>(`select a.email, m.provider_message_id as "providerMessageId" from app.messages m join app.accounts a on a.id = m.account_id where m.id = $1::uuid and m.account_id = $2::uuid`, [target.messageId, target.accountId]);
    const row = result.rows[0];
    if (!row) throw new Error('POLICY_MESSAGE_NOT_FOUND');
    return { account: row.email, id: row.providerMessageId };
  }
  async archive({ target }: Parameters<PrivateMutationTransport['archive']>[0]): Promise<JsonObject> { return this.call('archive_email', await this.message(target)); }
  async recoverableTrash({ target }: Parameters<PrivateMutationTransport['recoverableTrash']>[0]): Promise<JsonObject> { return this.call('trash_email', await this.message(target)); }
  async markRead({ target }: Parameters<PrivateMutationTransport['markRead']>[0]): Promise<JsonObject> { return this.call('mark_read', await this.message(target)); }
  async markUnread({ target }: Parameters<PrivateMutationTransport['markUnread']>[0]): Promise<JsonObject> { return this.call('mark_unread', await this.message(target)); }
  async move({ target }: Parameters<PrivateMutationTransport['move']>[0]): Promise<JsonObject> {
    const message = await this.message(target);
    const result = await this.database.query<{ providerFolderId: string }>(`select provider_folder_id as "providerFolderId" from app.folders where id = $1::uuid and account_id = $2::uuid`, [target.destinationFolderId, target.accountId]);
    const folder = result.rows[0];
    if (!folder) throw new Error('POLICY_FOLDER_NOT_FOUND');
    return this.call('move_email', { ...message, destination: folder.providerFolderId });
  }
  // The Hypermail write-draft response contract is not represented by @hypermail/hypermail.
  // Refuse before I/O rather than guessing a request/response shape or losing a provider draft ID.
  draftCreate(): Promise<JsonObject> { return Promise.reject(new Error('POLICY_DRAFT_RESPONSE_UNVERIFIED')); }
  async draftEdit({ target }: Parameters<PrivateMutationTransport['draftEdit']>[0]): Promise<JsonObject> {
    const result = await this.database.query<{ providerDraftId: string | null }>(`select provider_draft_id as "providerDraftId" from app.drafts where id = $1::uuid and account_id = $2::uuid`, [target.draftId, target.accountId]);
    if (!result.rows[0]?.providerDraftId) throw new Error('POLICY_DRAFT_PROVIDER_ID_MISSING');
    throw new Error('POLICY_DRAFT_RESPONSE_UNVERIFIED');
  }
  async read(target: PolicyActionInput['target']): Promise<JsonObject | null> {
    if (!('messageId' in target)) return null;
    const message = await this.message(target);
    if (!this.client) throw new Error('POLICY_TRANSPORT_UNAVAILABLE');
    await this.initialize();
    const observed = json(await this.client.call('read_email', { account: message.account, id: message.id, format: 'text' }));
    // Only isRead is an established read_email fact. Folder facts are intentionally omitted.
    return typeof observed['isRead'] === 'boolean' ? { isRead: observed['isRead'] } : {};
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
