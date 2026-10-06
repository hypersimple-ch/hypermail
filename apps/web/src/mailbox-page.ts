import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HypermailReadClient, Message } from '@hypermail/hypermail';
import type { SqlClient } from './activity/postgres-repository.js';

export interface MailReadScope { subjectId: string; accountIds: readonly string[]; }
export interface MailReadProvider { withRead<T>(userId: string, operation: (read: HypermailReadClient) => Promise<T>): Promise<T>; }
export class MailReadError extends Error {
  constructor(readonly status: 400 | 404 | 503, readonly code: string) { super(code); }
}
export interface InboxMessage { id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string; is_read: boolean; }
interface Cursor { version: 1; userId: string; accountId: string; folderId: string; providerCursor: number; expiresAt: number; }

/** The signed offset is the pinned provider list_emails cursor, never a DB offset. */
export class MailboxPageReader {
  private readonly key: Buffer;
  constructor(private readonly sql: SqlClient, private readonly provider: MailReadProvider, sessionSecret: string, private readonly now: () => number = Date.now) {
    this.key = createHmac('sha256', sessionSecret).update('hypermail:inbox-cursor:v1').digest();
  }
  async page(scope: MailReadScope, accountId: string, cursor?: string, limit = 50): Promise<{ messages: readonly InboxMessage[]; nextCursor: string | null }> {
    if (!scope.accountIds.includes(accountId)) throw new MailReadError(404, 'MAILBOX_NOT_FOUND');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MailReadError(400, 'INVALID_LIMIT');
    const account = (await this.sql.query<{ email: string }>('select email from app.accounts where id=$1::uuid and user_id=$2::uuid and state=\'ready\'', [accountId, scope.subjectId])).rows[0];
    if (!account) throw new MailReadError(404, 'MAILBOX_NOT_FOUND');
    try {
      return await this.provider.withRead(scope.subjectId, async read => {
        const folders = await read.folders(account.email);
        const inbox = folders.find(folder => folder.wellKnownName?.toLowerCase() === 'inbox') ?? folders.find(folder => folder.id.toLowerCase() === 'inbox');
        if (!inbox) throw new MailReadError(503, 'INBOX_UNAVAILABLE');
        const skip = cursor ? this.decode(cursor, scope.subjectId, accountId, inbox.id) : 0;
        const page = await read.mailboxPage(account.email, { folder: inbox.id, skip, limit });
        if (page.hasMore && page.messages.length === 0) throw new MailReadError(503, 'PROVIDER_INVALID_PAGE');
        const messages = await this.sql.transaction(async sql => {
          const folder = (await sql.query<{ id: string }>(`insert into app.folders(account_id,provider_folder_id,name,role) values($1,$2,$3,'inbox') on conflict(account_id,provider_folder_id) do update set name=excluded.name,role='inbox' returning id`, [accountId, inbox.id, inbox.displayName])).rows[0];
          if (!folder) throw new MailReadError(503, 'PROJECTION_UNAVAILABLE');
          const result: InboxMessage[] = [];
          for (const message of page.messages) result.push(await projectReadMessage(sql, accountId, folder.id, message, this.now()));
          return result;
        });
        const nextCursor = page.hasMore ? this.encode({ version: 1, userId: scope.subjectId, accountId, folderId: inbox.id, providerCursor: skip + page.messages.length, expiresAt: this.now() + 15 * 60_000 }) : null;
        return { messages, nextCursor };
      });
    } catch (error) { if (error instanceof MailReadError) throw error; throw new MailReadError(503, 'PROVIDER_UNAVAILABLE'); }
  }
  private encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
  }
  private decode(value: string, userId: string, accountId: string, folderId: string): number {
    try {
      if (value.length > 4096) throw new Error();
      const [payload, signature, extra] = value.split('.');
      if (!payload || !signature || extra !== undefined) throw new Error();
      const expected = createHmac('sha256', this.key).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error();
      const parsed = decoded as Record<string, unknown>;
      if (parsed['version'] !== 1 || parsed['userId'] !== userId || parsed['accountId'] !== accountId || parsed['folderId'] !== folderId || typeof parsed['expiresAt'] !== 'number' || !Number.isSafeInteger(parsed['expiresAt']) || parsed['expiresAt'] <= this.now() || typeof parsed['providerCursor'] !== 'number' || !Number.isSafeInteger(parsed['providerCursor']) || parsed['providerCursor'] < 0) throw new Error();
      return parsed['providerCursor'];
    } catch { throw new MailReadError(400, 'INVALID_CURSOR'); }
  }
}

/** Read projections preserve baseline flags and never create arrivals or memory events. */
export async function projectReadMessage(sql: SqlClient, accountId: string, folderId: string, message: Message, now: number): Promise<InboxMessage> {
  const from = message.from ?? { address: 'unknown@invalid' };
  const receivedAt = message.receivedAt && Number.isFinite(Date.parse(message.receivedAt)) ? message.receivedAt : new Date(now).toISOString();
  const row = (await sql.query<{ id: string }>(`insert into app.messages(account_id,provider_message_id,folder_id,sender,recipients,subject,preview,received_at,is_read,has_attachments,is_baseline) values($1,$2,$3,$4::jsonb,$5::jsonb,$6,'',$7,$8,$9,false) on conflict(account_id,provider_message_id) do update set folder_id=excluded.folder_id,sender=excluded.sender,recipients=excluded.recipients,subject=excluded.subject,is_read=excluded.is_read,has_attachments=excluded.has_attachments,updated_at=now() returning id`, [accountId, message.id, folderId, JSON.stringify(from), JSON.stringify([...(message.to ?? []).map(item => ({kind:'to',...item})), ...(message.cc ?? []).map(item => ({kind:'cc',...item}))]), (message.subject ?? '').slice(0,998), receivedAt, message.isRead ?? false, Boolean(message.attachments?.length)])).rows[0];
  if (!row) throw new MailReadError(503, 'PROJECTION_UNAVAILABLE');
  for (const item of message.attachments ?? []) await sql.query(`insert into app.attachments(message_id,provider_attachment_id,filename,media_type,size_bytes) values($1,$2,$3,$4,$5) on conflict(message_id,provider_attachment_id) do update set filename=excluded.filename,media_type=excluded.media_type,size_bytes=excluded.size_bytes`, [row.id,item.id,item.name,item.contentType ?? 'application/octet-stream',item.size ?? 0]);
  return { id: row.id, account_id: accountId, sender: from.name ?? from.address, subject: message.subject ?? '', preview: '', received_at: receivedAt, is_read: message.isRead ?? false };
}
