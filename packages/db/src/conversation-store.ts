import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ConversationCursorError, conversationCreateSchema, conversationPostSchema, conversationReplySchema, idSchema,
  type Conversation, type ConversationCreate, type ConversationMessage, type ConversationMessagePage,
  type ConversationPage, type ConversationTurn, type MessagePost, type ScopeAuth,
} from '@hypermail/contracts';
import { enqueueMailboxMemoryEventInTransaction, mailboxMemoryTextEvidence } from './mailbox-memory-event-store.js';
import type { SqlClient } from './postgres-client.js';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const conversationFrom = (row: Row): Conversation => ({
  id: row['id'] as string, userId: row['user_id'] as string, scope: row['scope'] as Conversation['scope'],
  accountId: row['account_id'] as string | null, contextMessageId: row['context_message_id'] as string | null,
  version: row['version'] as number, createdAt: iso(row['created_at']), updatedAt: iso(row['updated_at']),
});
const turnFrom = (row: Row): ConversationTurn => ({
  id: row['id'] as string, userMessageId: row['user_message_id'] as string, state: row['state'] as ConversationTurn['state'],
  attempt: row['attempt'] as number, availableAt: iso(row['available_at']), errorCode: row['error_code'] as string | null,
  claimExpiresAt: row['claim_expires_at'] == null ? null : iso(row['claim_expires_at']),
});
const messageFrom = (row: Row): ConversationMessage => ({
  id: row['id'] as string, conversationId: row['conversation_id'] as string, sequence: row['sequence'] as number,
  role: row['role'] as ConversationMessage['role'], content: row['content'] as string, requestId: row['request_id'] as string | null,
  replyTo: row['reply_to'] as string | null, createdAt: iso(row['created_at']), turn: row['turn'] ? turnFrom(row['turn'] as Row) : null,
});
const cursorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversations'), userId: idSchema, scope: z.enum(['global', 'mailbox']), accountId: idSchema.nullable(), createdAt: z.iso.datetime(), id: idSchema }),
  z.strictObject({ kind: z.literal('messages'), userId: idSchema, conversationId: idSchema, sequence: z.number().int().positive().max(2_147_483_647) }),
]);
const encodeCursor = (value: z.infer<typeof cursorSchema>): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value: string): z.infer<typeof cursorSchema> {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ConversationCursorError();
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new ConversationCursorError();
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch { throw new ConversationCursorError(); }
}
const bounded = (value: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Conversation batch size is out of range.');
  return value;
};
export type ConversationClaim = {
  turn: ConversationTurn; conversation: Conversation; userMessage: ConversationMessage; claimToken: string; claimedAt: string;
};
export type ConversationAppendResult =
  | { kind: 'accepted'; conversation: Conversation; message: ConversationMessage; turn: ConversationTurn; replayed: boolean }
  | { kind: 'not_found' } | { kind: 'conflict'; currentVersion: number };
export type ConversationRetryResult = { kind: 'queued'; turn: ConversationTurn } | { kind: 'not_found' } | { kind: 'conflict'; currentAttempt: number };
export interface OwnerMemorySource {
  id: string;
  scope: 'mailbox' | 'global';
  accountId: string | null;
  conversationId: string | null;
  activityId: string | null;
  content: string;
  /** Exact PostgreSQL timestamp, including microseconds, for lossless pagination. */
  createdAt: string;
}
export interface OwnerSourceCursor { createdAt: string; sourceId: string }

/** Application history only: no model or provider calls occur inside these transactions. */
export class ConversationStore {
  constructor(private readonly sql: SqlClient) {}

  async create(scope: ScopeAuth, raw: ConversationCreate): Promise<Conversation | null> {
    const input = conversationCreateSchema.parse(raw);
    if (input.scope === 'mailbox' && !scope.accountIds.includes(input.accountId)) return null;
    const row = (await this.sql.query(`insert into app.agent_conversations(id,user_id,scope,account_id,context_message_id)
      select $1,$2,$3,$4,$5 where exists(select 1 from app.users where id=$2::uuid)
      and ($3='global' or exists(select 1 from app.user_accounts where user_id=$2::uuid and account_id=$4::uuid))
      and ($5::uuid is null or exists(select 1 from app.messages where id=$5::uuid and account_id=$4::uuid)) returning *`,
    [randomUUID(), scope.userId, input.scope, input.scope === 'mailbox' ? input.accountId : null,
      input.scope === 'mailbox' ? input.contextMessageId ?? null : null])).rows[0];
    return row ? conversationFrom(row) : null;
  }

  async get(scope: ScopeAuth, conversationId: string): Promise<Conversation | null> {
    const row = await this.readConversation(this.sql, scope, conversationId);
    return row ? conversationFrom(row) : null;
  }

  async list(scope: ScopeAuth, input: { scope: 'mailbox' | 'global'; accountId?: string | undefined; cursor?: string | undefined }): Promise<ConversationPage> {
    if (input.scope === 'global' && input.accountId !== undefined) throw new ConversationCursorError();
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (cursor && (cursor.kind !== 'conversations' || cursor.userId !== scope.userId || cursor.scope !== input.scope || cursor.accountId !== (input.accountId ?? null))) throw new ConversationCursorError();
    if (input.accountId && !scope.accountIds.includes(input.accountId)) return { conversations: [], nextCursor: null };
    const rows = (await this.sql.query(`select c.*,to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
      from app.agent_conversations c where c.user_id=$1::uuid and c.scope=$2
      and (c.scope='global' or (c.account_id=any($3::uuid[]) and exists(select 1 from app.user_accounts ua where ua.user_id=c.user_id and ua.account_id=c.account_id)))
      and ($4::uuid is null or c.account_id=$4::uuid)
      and ($5::text::timestamptz is null or (c.created_at,c.id)>($5::text::timestamptz,$6::uuid)) order by c.created_at,c.id limit 51`,
    [scope.userId, input.scope, [...scope.accountIds], input.accountId ?? null,
      cursor?.kind === 'conversations' ? cursor.createdAt : null, cursor?.kind === 'conversations' ? cursor.id : null])).rows;
    const conversations = rows.slice(0, 50).map(conversationFrom); const last = conversations.at(-1);
    return { conversations, nextCursor: rows.length > 50 && last ? encodeCursor({ kind: 'conversations', userId: scope.userId, scope: input.scope, accountId: input.accountId ?? null, createdAt: rows[49]?.['cursor_created_at'] as string, id: last.id }) : null };
  }

  async messages(scope: ScopeAuth, conversationId: string, value?: string): Promise<ConversationMessagePage | null> {
    const cursor = value === undefined ? null : decodeCursor(value);
    if (cursor && (cursor.kind !== 'messages' || cursor.userId !== scope.userId || cursor.conversationId !== conversationId)) throw new ConversationCursorError();
    if (!await this.readConversation(this.sql, scope, conversationId)) return null;
    const rows = (await this.sql.query(`select m.*,to_jsonb(t) as turn from app.agent_conversation_messages m
      left join app.agent_conversation_turns t on t.user_message_id=m.id
      where m.conversation_id=$1::uuid and m.sequence>$2 order by m.sequence limit 51`,
    [conversationId, cursor?.kind === 'messages' ? cursor.sequence : 0])).rows;
    const messages = rows.slice(0, 50).map(messageFrom); const last = messages.at(-1);
    return { messages, nextCursor: rows.length > 50 && last ? encodeCursor({ kind: 'messages', userId: scope.userId, conversationId, sequence: last.sequence }) : null };
  }

  async append(scope: ScopeAuth, conversationId: string, raw: MessagePost): Promise<ConversationAppendResult> {
    const input = conversationPostSchema.parse(raw);
    const digest = createHash('sha256').update(JSON.stringify({ conversationId, content: input.content })).digest('hex');
    return this.sql.transaction(async (db) => {
      // Serializes the cross-conversation owner request key without locking the owner row.
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`conversation:${scope.userId}:${input.requestId}`]);
      const row = await this.readConversation(db, scope, conversationId, true);
      if (!row) return { kind: 'not_found' };
      const conversation = conversationFrom(row);
      const previous = (await db.query(`select m.*,to_jsonb(t) as turn from app.agent_conversation_messages m
        join app.agent_conversation_turns t on t.user_message_id=m.id where m.user_id=$1::uuid and m.request_id=$2::uuid`, [scope.userId, input.requestId])).rows[0];
      if (previous) {
        if (previous['conversation_id'] !== conversationId || previous['request_digest'] !== digest) return { kind: 'conflict', currentVersion: conversation.version };
        const message = messageFrom(previous);
        return { kind: 'accepted', conversation, message, turn: message.turn as ConversationTurn, replayed: true };
      }
      if (conversation.version !== input.expectedVersion) return { kind: 'conflict', currentVersion: conversation.version };
      const messageRow = (await db.query(`insert into app.agent_conversation_messages(id,conversation_id,user_id,sequence,role,content,request_id,request_digest)
        select $1,$2,$3,coalesce(max(sequence),0)+1,'user',$4,$5,$6 from app.agent_conversation_messages where conversation_id=$2::uuid returning *`,
      [randomUUID(), conversationId, scope.userId, input.content, input.requestId, digest])).rows[0] as Row;
      const turnRow = (await db.query('insert into app.agent_conversation_turns(id,user_message_id) values($1,$2) returning *', [randomUUID(), messageRow['id']])).rows[0] as Row;
      const updated = (await db.query('update app.agent_conversations set version=version+1,updated_at=clock_timestamp() where id=$1 returning *', [conversationId])).rows[0] as Row;
      const accounts = (await db.query(`select a.id from app.accounts a join app.user_accounts ua on ua.account_id=a.id and ua.user_id=a.user_id
        where a.user_id=$1::uuid and (a.id=$2::uuid or ($2::uuid is null and a.state in ('ready','degraded'))) order by a.id`, [scope.userId, conversation.accountId])).rows;
      for (const account of accounts) await this.enqueueOwnerMessage(db, scope.userId, account['id'] as string, conversation.scope, messageRow);
      const turn = turnFrom(turnRow);
      return { kind: 'accepted', conversation: conversationFrom(updated), message: { ...messageFrom(messageRow), turn }, turn, replayed: false };
    });
  }

  async retry(scope: ScopeAuth, conversationId: string, turnId: string, expectedAttempt: number): Promise<ConversationRetryResult> {
    if (!Number.isInteger(expectedAttempt) || expectedAttempt < 0) throw new Error('Invalid expected attempt.');
    return this.sql.transaction(async (db) => {
      if (!await this.readConversation(db, scope, conversationId, true)) return { kind: 'not_found' };
      const row = (await db.query(`select t.* from app.agent_conversation_turns t join app.agent_conversation_messages m on m.id=t.user_message_id
        where t.id=$1::uuid and m.conversation_id=$2::uuid for update of t`, [turnId, conversationId])).rows[0];
      if (!row) return { kind: 'not_found' };
      if (row['state'] !== 'failed' || row['attempt'] !== expectedAttempt) return { kind: 'conflict', currentAttempt: row['attempt'] as number };
      const queued = (await db.query(`update app.agent_conversation_turns set state='pending',error_code=null,model_failure_count=0,
        available_at=greatest(available_at,clock_timestamp()),updated_at=clock_timestamp() where id=$1 returning *`, [turnId])).rows[0] as Row;
      return { kind: 'queued', turn: turnFrom(queued) };
    });
  }

  async claim(turnId: string, userId: string): Promise<ConversationClaim | null> {
    return this.sql.transaction(async (db) => {
      const parent = (await db.query(`select c.* from app.agent_conversations c join app.agent_conversation_messages m on m.conversation_id=c.id
        join app.agent_conversation_turns t on t.user_message_id=m.id where t.id=$1::uuid and c.user_id=$2::uuid
        and (c.scope='global' or exists(select 1 from app.user_accounts ua where ua.user_id=c.user_id and ua.account_id=c.account_id))
        for update of c`, [turnId, userId])).rows[0];
      if (!parent) return null;
      const claimToken = randomUUID();
      const row = (await db.query(`update app.agent_conversation_turns set state='running',attempt=attempt+1,claim_token=$2::uuid,
        claim_expires_at=now()+interval '120 seconds',updated_at=clock_timestamp(),error_code=null
        where id=$1::uuid and ((state='pending' and available_at<=now()) or (state='running' and claim_expires_at<=now())) returning *,now() as claimed_at`, [turnId, claimToken])).rows[0];
      if (!row) return null;
      const message = (await db.query('select * from app.agent_conversation_messages where id=$1', [row['user_message_id']])).rows[0] as Row;
      return { turn: turnFrom(row), conversation: conversationFrom(parent), userMessage: { ...messageFrom(message), turn: turnFrom(row) }, claimToken, claimedAt: iso(row['claimed_at']) };
    });
  }

  async recentMessages(claim: ConversationClaim, limit = 20): Promise<readonly ConversationMessage[]> {
    bounded(limit, 20);
    // Replies to earlier turns may have a later sequence; include them but never include future owner turns or their replies.
    const rows = (await this.sql.query(`select m.*,to_jsonb(t) as turn from app.agent_conversation_messages m
      left join app.agent_conversation_turns t on t.user_message_id=m.id
      left join app.agent_conversation_messages parent on parent.id=m.reply_to
      where m.conversation_id=$1::uuid and m.user_id=$2::uuid and
        ((m.role='user' and m.sequence<=$3) or (m.role='assistant' and parent.sequence<$3))
      order by m.sequence desc limit $4`, [claim.conversation.id, claim.conversation.userId, claim.userMessage.sequence, limit])).rows;
    return rows.map(messageFrom).reverse();
  }

  async renew(claim: ConversationClaim): Promise<boolean> {
    const rows = (await this.sql.query(`update app.agent_conversation_turns set claim_expires_at=now()+interval '120 seconds',updated_at=clock_timestamp()
      where id=$1::uuid and user_message_id=$2::uuid and state='running' and claim_token=$3::uuid and attempt=$4 and claim_expires_at>now()
      and claim_expires_at<now()+interval '120 seconds' returning id`, [claim.turn.id, claim.userMessage.id, claim.claimToken, claim.turn.attempt])).rows;
    return rows.length === 1;
  }

  async complete(claim: ConversationClaim, reply: string): Promise<boolean> {
    conversationReplySchema.parse({ reply });
    return this.sql.transaction(async (db) => {
      const parent = (await db.query('select id from app.agent_conversations where id=$1::uuid and user_id=$2::uuid for update', [claim.conversation.id, claim.conversation.userId])).rows[0];
      if (!parent) return false;
      const turn = (await db.query(`select * from app.agent_conversation_turns where id=$1::uuid and user_message_id=$2::uuid and state='running'
        and claim_token=$3::uuid and attempt=$4 and claim_expires_at>now() for update`, [claim.turn.id, claim.userMessage.id, claim.claimToken, claim.turn.attempt])).rows[0];
      if (!turn) return false;
      await db.query(`insert into app.agent_conversation_messages(id,conversation_id,user_id,sequence,role,content,reply_to)
        select $1,$2,$3,coalesce(max(sequence),0)+1,'assistant',$4,$5 from app.agent_conversation_messages where conversation_id=$2::uuid`,
      [randomUUID(), claim.conversation.id, claim.conversation.userId, reply, claim.userMessage.id]);
      await db.query(`update app.agent_conversation_turns set state='completed',claim_expires_at=null,error_code=null,updated_at=clock_timestamp() where id=$1`, [claim.turn.id]);
      await db.query('update app.agent_conversations set version=version+1,updated_at=clock_timestamp() where id=$1', [claim.conversation.id]);
      return true;
    });
  }

  async fail(claim: ConversationClaim, failure: { code: string; temporary: boolean; memoryUnavailable?: boolean }): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(failure.code)) throw new Error('Invalid conversation error code.');
    const rows = (await this.sql.query(`update app.agent_conversation_turns set
      model_failure_count=case when $6 then model_failure_count else least(3,model_failure_count+1) end,
      state=case when $6 then 'pending' when $5 and model_failure_count<2 then 'pending' else 'failed' end,
      available_at=now()+make_interval(secs=>case when $6 then least(900,5*power(2,least(attempt-1,8)))::integer
        when $5 then (array[5,30,120])[least(3,model_failure_count+1)] else 0 end),
      error_code=$4,claim_expires_at=null,updated_at=clock_timestamp()
      where id=$1::uuid and claim_token=$2::uuid and attempt=$3 and user_message_id=$7::uuid and state='running' and claim_expires_at>now() returning id`,
    [claim.turn.id, claim.claimToken, claim.turn.attempt, failure.code, failure.temporary, failure.memoryUnavailable ?? false, claim.userMessage.id])).rows;
    return rows.length === 1;
  }

  async readyTurnIds(limit = 100): Promise<readonly { turnId: string; userId: string }[]> {
    bounded(limit, 1000);
    const rows = (await this.sql.query(`select t.id as turn_id,m.user_id from app.agent_conversation_turns t
      join app.agent_conversation_messages m on m.id=t.user_message_id
      where (t.state='pending' and t.available_at<=now()) or (t.state='running' and t.claim_expires_at<=now())
      order by coalesce(t.claim_expires_at,t.available_at),t.id limit $1`, [limit])).rows;
    return rows.map((row) => ({ turnId: row['turn_id'] as string, userId: row['user_id'] as string }));
  }

  async backfillGlobalMessages(limitAccounts = 100): Promise<number> {
    bounded(limitAccounts, 1000);
    return this.sql.transaction(async (db) => {
      const accounts = (await db.query(`select a.id,a.user_id from app.accounts a join app.user_accounts ua on ua.account_id=a.id and ua.user_id=a.user_id
        left join app.agent_global_memory_backfills b on b.account_id=a.id and b.user_id=a.user_id
        where a.state in ('ready','degraded') and (b.completed_at is null or exists(
          select 1 from app.agent_conversation_messages m join app.agent_conversations c on c.id=m.conversation_id
          where c.user_id=a.user_id and c.scope='global' and m.role='user' and (
            (m.created_at,m.id)>(b.last_message_created_at,b.last_message_id) or not exists(
              select 1 from app.mailbox_memory_events e where e.user_id=a.user_id and e.account_id=a.id
              and e.source_type='conversation_message' and e.source_id=m.id and e.source_version=1 and e.kind='owner_conversation_message'))))
        order by a.id limit $1`, [limitAccounts])).rows;
      let inserted = 0;
      for (const account of accounts) {
        const userId = account['user_id'] as string; const accountId = account['id'] as string;
        await db.query(`insert into app.agent_global_memory_backfills(user_id,account_id) values($1,$2) on conflict do nothing`, [userId, accountId]);
        await db.query('select account_id from app.agent_global_memory_backfills where user_id=$1 and account_id=$2 for update', [userId, accountId]);
        // Also repair holes from messages whose transactions committed after a watermark advanced.
        const messages = (await db.query(`select m.* from app.agent_conversation_messages m join app.agent_conversations c on c.id=m.conversation_id
          join app.agent_global_memory_backfills b on b.user_id=c.user_id and b.account_id=$2::uuid
          where c.user_id=$1::uuid and c.scope='global' and m.role='user' and
          (b.last_message_id is null or (m.created_at,m.id)>(b.last_message_created_at,b.last_message_id) or not exists(
            select 1 from app.mailbox_memory_events e where e.user_id=$1::uuid and e.account_id=$2::uuid and e.source_type='conversation_message'
              and e.source_id=m.id and e.source_version=1 and e.kind='owner_conversation_message'))
          order by m.created_at,m.id limit 100`, [userId, accountId])).rows;
        for (const message of messages) {
          const exists = (await db.query(`select id from app.mailbox_memory_events where user_id=$1 and account_id=$2 and source_type='conversation_message'
            and source_id=$3 and source_version=1 and kind='owner_conversation_message'`, [userId, accountId, message['id']])).rows.length > 0;
          await this.enqueueOwnerMessage(db, userId, accountId, 'global', message);
          if (!exists) inserted++;
        }
        const last = messages.at(-1);
        await db.query(`update app.agent_global_memory_backfills b set
          last_message_created_at=case when m.id is not null and (b.last_message_id is null or (m.created_at,m.id)>(b.last_message_created_at,b.last_message_id)) then m.created_at else b.last_message_created_at end,
          last_message_id=case when m.id is not null and (b.last_message_id is null or (m.created_at,m.id)>(b.last_message_created_at,b.last_message_id)) then m.id else b.last_message_id end,
          completed_at=case when $4 then clock_timestamp() else null end,updated_at=clock_timestamp()
          from (select id,created_at from app.agent_conversation_messages where id=$3::uuid union all select null::uuid,null::timestamptz where $3::uuid is null) m
          where b.user_id=$1 and b.account_id=$2`, [userId, accountId, last?.['id'] ?? null, messages.length < 100]);
      }
      return inserted;
    });
  }

  async hasPendingOwnerContext(scope: { userId: string; accountId: string }, acceptedBefore: Date): Promise<boolean> {
    const row = (await this.sql.query(`select (
      exists(select 1 from app.mailbox_memory_events e where e.user_id=$1::uuid and e.account_id=$2::uuid and e.occurred_at<=$3
        and e.kind in ('question_answered','retain_question_answer','action_approved','action_rejected','action_corrected','owner_conversation_message') and e.state<>'completed')
      or exists(select 1 from app.agent_conversation_messages m join app.agent_conversations c on c.id=m.conversation_id
        where c.user_id=$1::uuid and (c.scope='global' or c.account_id=$2::uuid) and m.role='user' and m.created_at<=$3
        and not exists(select 1 from app.mailbox_memory_events e where e.user_id=$1::uuid and e.account_id=$2::uuid
          and e.source_type='conversation_message' and e.source_id=m.id and e.source_version=1 and e.kind='owner_conversation_message' and e.state='completed'))
      ) as pending`, [scope.userId, scope.accountId, acceptedBefore])).rows[0];
    return row?.['pending'] === true;
  }

  async ownerSources(scope: { userId: string; accountId?: string }, acceptedBefore: Date, cursor?: OwnerSourceCursor): Promise<readonly OwnerMemorySource[]> {
    return this.readOwnerSources(scope, acceptedBefore, cursor, false);
  }

  async globalOwnerSources(userId: string, acceptedBefore: Date, cursor?: OwnerSourceCursor): Promise<readonly OwnerMemorySource[]> {
    return this.readOwnerSources({ userId }, acceptedBefore, cursor, true);
  }

  private async readOwnerSources(scope: { userId: string; accountId?: string }, acceptedBefore: Date, cursor: OwnerSourceCursor | undefined, globalOnly: boolean): Promise<readonly OwnerMemorySource[]> {
    const rows = (await this.sql.query(`select sources.*,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at from (
      select 'conversation_message:'||m.id::text as id,c.scope,c.account_id,c.id as conversation_id,null::uuid as activity_id,m.content,m.created_at
        from app.agent_conversation_messages m join app.agent_conversations c on c.id=m.conversation_id and c.user_id=m.user_id
        where c.user_id=$1::uuid and (c.scope='global' or (
          ($2::uuid is null or c.account_id=$2::uuid) and exists(
            select 1 from app.user_accounts ua join app.accounts box on box.id=ua.account_id and box.user_id=ua.user_id
            where ua.user_id=c.user_id and ua.account_id=c.account_id)))
          and m.role='user' and m.created_at<=$3
      union all
      select 'question_answer:'||q.id::text,'mailbox',a.account_id,null::uuid,a.id,q.answer,q.answered_at
        from app.questions q join app.activities a on a.id=q.activity_id
        join app.accounts box on box.id=a.account_id
        join app.user_accounts ua on ua.account_id=box.id and ua.user_id=box.user_id
        where box.user_id=$1::uuid and ($2::uuid is null or a.account_id=$2::uuid) and q.answer is not null and q.answered_at<=$3
      union all
      select 'action_review:'||r.id::text,'mailbox',r.account_id,null::uuid,p.activity_id,
        'Owner review: '||r.decision||case when r.reason is null then '' else E'\nOwner explanation: '||r.reason end||
        case when r.correction is null then '' else E'\nOwner correction fields (draft content is contextual evidence): '||(r.correction-'draft')::text end,r.created_at
        from app.agent_action_reviews r
        join app.agent_action_proposals p on p.id=r.proposal_id and p.user_id=r.user_id and p.account_id=r.account_id
        join app.accounts box on box.id=r.account_id and box.user_id=r.user_id
        join app.user_accounts ua on ua.account_id=r.account_id and ua.user_id=r.user_id
        where r.user_id=$1::uuid and ($2::uuid is null or r.account_id=$2::uuid) and r.created_at<=$3
      ) sources where (not $6::boolean or scope='global')
        and ($4::text::timestamptz is null or (created_at,id collate "C")>($4::text::timestamptz,$5::text collate "C"))
      order by created_at,id collate "C" limit 100`,
    [scope.userId, scope.accountId ?? null, acceptedBefore, cursor?.createdAt ?? null, cursor?.sourceId ?? null, globalOnly])).rows;
    return rows.map((row) => ({
      id: row['id'] as string, scope: row['scope'] as 'mailbox' | 'global',
      accountId: row['account_id'] as string | null, conversationId: row['conversation_id'] as string | null,
      activityId: row['activity_id'] as string | null, content: row['content'] as string,
      createdAt: row['cursor_created_at'] as string,
    }));
  }

  private async readConversation(db: SqlClient, scope: ScopeAuth, conversationId: string, lock = false): Promise<Row | undefined> {
    return (await db.query(`select c.* from app.agent_conversations c where c.id=$1::uuid and c.user_id=$2::uuid
      and (c.scope='global' or (c.account_id=any($3::uuid[]) and exists(select 1 from app.user_accounts ua where ua.user_id=c.user_id and ua.account_id=c.account_id)))${lock ? ' for update of c' : ''}`,
    [conversationId, scope.userId, [...scope.accountIds]])).rows[0];
  }

  private async enqueueOwnerMessage(db: SqlClient, userId: string, accountId: string, scope: 'mailbox' | 'global', message: Row): Promise<void> {
    const projection = mailboxMemoryTextEvidence(message['content'] as string, 8000);
    await enqueueMailboxMemoryEventInTransaction(db, {
      userId, mailboxId: accountId, sourceType: 'conversation_message', sourceId: message['id'] as string, sourceVersion: 1,
      kind: 'owner_conversation_message', occurredAt: iso(message['created_at']),
      contentPayload: { scope, content: projection.text, contentDigest: projection.digest, contentTruncated: projection.truncated, conversationId: message['conversation_id'] },
    });
  }
}
