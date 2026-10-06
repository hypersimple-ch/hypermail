import sanitizeHtml from 'sanitize-html';
import { McpTransportError } from '@hypermail/hypermail';
import type { SqlClient } from './activity/postgres-repository.js';
import { MailReadError, type MailReadProvider, type MailReadScope } from './mailbox-page.js';

const textEntities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };
export interface ReadMessageDetail {
  id: string; account_id: string; sender: string; senderAddress: string; subject: string; preview: string; received_at: string;
  body: string; sanitizedHtml: string | null;
  attachments: readonly { id: string; name: string; sizeBytes: number; contentType: string }[];
}
/** Full-body cache only: previews can never stand in for provider content. */
export class MessageReader {
  constructor(private readonly sql: SqlClient, private readonly provider: MailReadProvider, private readonly now: () => number = Date.now, private readonly cacheMs = 24 * 60 * 60_000) {}
  async read(scope: MailReadScope, messageId: string): Promise<ReadMessageDetail> {
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw new MailReadError(404, 'MESSAGE_NOT_FOUND');
    const row = (await this.sql.query<{ id: string; account_id: string; email: string; provider_message_id: string; sender: { address: string; name?: string }; subject: string; preview: string; received_at: Date | string; text_body: string | null; sanitized_html_body: string | null; purge_after: Date | string | null }>(`select m.id,m.account_id,a.email,m.provider_message_id,m.sender,m.subject,m.preview,m.received_at,b.text_body,b.sanitized_html_body,b.purge_after from app.messages m join app.accounts a on a.id=m.account_id left join app.message_bodies b on b.message_id=m.id where m.id=$1::uuid and m.account_id=any($2::uuid[]) and a.user_id=$3::uuid and m.deleted_at is null`, [messageId,scope.accountIds,scope.subjectId])).rows[0];
    if (!row) throw new MailReadError(404, 'MESSAGE_NOT_FOUND');
    let body = row.text_body;
    let html = row.sanitized_html_body;
    if (body === null || !row.purge_after || new Date(row.purge_after).getTime() <= this.now()) {
      try {
        const full = await this.provider.withRead(scope.subjectId, read => read.readMessage(row.email,row.provider_message_id,'html'));
        if (typeof full.body !== 'string') throw new MailReadError(503, 'PROVIDER_BODY_UNAVAILABLE');
        html = full.bodyFormat === 'html' || full.bodyFormat === undefined ? sanitizeHtml(full.body, {
          allowedTags: ['p','br','strong','b','em','i','u','s','ul','ol','li','blockquote','pre','code','div','span','table','thead','tbody','tr','th','td','a','hr'],
          allowedAttributes: { a: ['href','title','rel'] }, allowedSchemes: ['https','http','mailto'], allowProtocolRelative: false,
          transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
        }) : null;
        body = html === null ? full.body : sanitizeHtml(html.replace(/<br\s*\/?>|<\/(?:p|div|li|tr|blockquote|pre)>/gi, '\n'), { allowedTags: [], allowedAttributes: {} }).replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, entity => textEntities[entity] ?? entity).trimEnd();
        await this.sql.transaction(async sql => {
          await sql.query(`insert into app.message_bodies(message_id,text_body,sanitized_html_body,cached_at,purge_after) values($1,$2,$3,$4,$5) on conflict(message_id) do update set text_body=excluded.text_body,sanitized_html_body=excluded.sanitized_html_body,cached_at=excluded.cached_at,purge_after=excluded.purge_after`, [messageId,body,html,new Date(this.now()),new Date(this.now()+this.cacheMs)]);
          for (const item of full.attachments ?? []) await sql.query(`insert into app.attachments(message_id,provider_attachment_id,filename,media_type,size_bytes) values($1,$2,$3,$4,$5) on conflict(message_id,provider_attachment_id) do update set filename=excluded.filename,media_type=excluded.media_type,size_bytes=excluded.size_bytes`, [messageId,item.id,item.name,item.contentType ?? 'application/octet-stream',item.size ?? 0]);
        });
      } catch (error) {
        if (error instanceof MailReadError) throw error;
        if (error instanceof McpTransportError && error.status === 404) throw new MailReadError(404, 'MESSAGE_NOT_FOUND');
        throw new MailReadError(503, 'PROVIDER_UNAVAILABLE');
      }
    }
    const attachments = (await this.sql.query<{ id: string; name: string; sizeBytes: number; contentType: string }>('select id,filename as name,size_bytes as "sizeBytes",media_type as "contentType" from app.attachments where message_id=$1 order by id', [messageId])).rows;
    return { id:row.id,account_id:row.account_id,sender:row.sender.name ?? row.sender.address,senderAddress:row.sender.address,subject:row.subject,preview:row.preview,received_at:new Date(row.received_at).toISOString(),body,sanitizedHtml:html,attachments };
  }
}

export function mailReadErrorResponse(error: unknown): { status: number; body: { error: { code: string } } } {
  return error instanceof MailReadError ? { status:error.status,body:{error:{code:error.code}} } : { status:503,body:{error:{code:'PROVIDER_UNAVAILABLE'}} };
}
