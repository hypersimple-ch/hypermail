import { randomUUID } from 'node:crypto';
import { draftFieldsSchema, type DraftFields } from '@hypermail/contracts';
import type { SqlClient } from './postgres-client.js';
import { enqueueMailboxMemoryEventInTransaction } from './mailbox-memory-event-store.js';
import { draftMemoryProjection, draftMemoryChangeProjection } from './draft-memory-projection.js';

type Sql = Pick<SqlClient, 'query'>;
export type TransactionDraft = DraftFields & { id: string; accountId: string; sourceMessageId: string | null; createdBy: 'agent' | 'user'; state: string; version: number; createdAt: string; updatedAt: string };
const stamp = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
export function transactionDraft(row: Record<string, unknown>): TransactionDraft {
  return { ...draftFieldsSchema.parse({ recipients: row['recipients'], subject: row['subject'], body: row['body'], bodyFormat: row['body_format'] }), id: String(row['id']), accountId: String(row['account_id']), sourceMessageId: row['source_message_id'] == null ? null : row['source_message_id'] as string, createdBy: row['created_by'] as 'agent' | 'user', state: String(row['state']), version: Number(row['version']), createdAt: stamp(row['created_at']), updatedAt: stamp(row['updated_at']) };
}
async function revision(sql: Sql, userId: string, value: TransactionDraft, editor: 'agent' | 'user', before?: TransactionDraft): Promise<void> {
  const snapshot: DraftFields = { recipients: value.recipients, subject: value.subject, body: value.body, bodyFormat: value.bodyFormat };
  await sql.query(`insert into app.draft_revisions(draft_id,version,editor,snapshot) values($1,$2,$3,$4::text::jsonb)`, [value.id,value.version,editor,JSON.stringify(snapshot)]);
  await sql.query(`insert into app.audits(actor_type,actor_id,account_id,event,correlation_id,metadata) values($1,$2,$3,$4,$5,$6::text::jsonb)`, [editor,userId,value.accountId,before ? 'draft.edited' : 'draft.created',`draft:${value.id}`,JSON.stringify({draftId:value.id,version:value.version,editor})]);
  if (editor === 'agent') return;
  const corrected = before?.createdBy === 'agent';
  await enqueueMailboxMemoryEventInTransaction(sql,{userId,mailboxId:value.accountId,sourceType:'draft',sourceId:value.id,sourceVersion:value.version,kind:before ? corrected ? 'draft_corrected' : 'draft_edited' : 'draft_created',occurredAt:before ? value.updatedAt : value.createdAt,contentPayload:before ? {outcome:corrected?'corrected':'edited',creator:before.createdBy,editor,...draftMemoryChangeProjection(before,value)} : {outcome:'created',actor:editor,after:draftMemoryProjection(value)}});
}
export async function createDraftInTransaction(sql: Sql, userId: string, input: DraftFields & { id?: string; accountId: string; sourceMessageId: string | null; createdBy: 'agent' | 'user'; state: string }): Promise<TransactionDraft> {
  const fields = draftFieldsSchema.parse({recipients:input.recipients,subject:input.subject,body:input.body,bodyFormat:input.bodyFormat});
  const result = await sql.query(`insert into app.drafts(id,account_id,source_message_id,created_by,state,recipients,subject,body,body_format) select $1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9 from app.user_accounts where user_id=$10 and account_id=$2 returning *`,[input.id??randomUUID(),input.accountId,input.sourceMessageId,input.createdBy,input.state,JSON.stringify(fields.recipients),fields.subject,fields.body,fields.bodyFormat,userId]);
  if (!result.rows[0]) throw new Error('DRAFT_SCOPE_NOT_FOUND');
  const value=transactionDraft(result.rows[0]); await revision(sql,userId,value,input.createdBy); return value;
}
export type TransactionDraftMutation = {kind:'not_found'} | {kind:'conflict';currentVersion:number} | {kind:'blocked';reason:string} | {kind:'updated';draft:TransactionDraft};
export async function editDraftInTransaction(sql: Sql, scope: {userId:string;accountIds:readonly string[]}, id:string, expected:number, input:DraftFields, editor:'agent'|'user'):Promise<TransactionDraftMutation> {
  const fields=draftFieldsSchema.parse(input);
  const locked=await sql.query(`select d.* from app.drafts d join app.user_accounts ua on ua.account_id=d.account_id where d.id=$1 and ua.user_id=$2 and d.account_id=any($3::uuid[]) for update of d`,[id,scope.userId,scope.accountIds]);
  if (!locked.rows[0]) return {kind:'not_found'};
  const before=transactionDraft(locked.rows[0]);
  if(before.version!==expected) return {kind:'conflict',currentVersion:before.version};
  if(!['editing','failed'].includes(before.state)) return {kind:'blocked',reason:'Only editable drafts can be changed.'};
  const result=await sql.query(`update app.drafts set recipients=$1::text::jsonb,subject=$2,body=$3,body_format=$4,state='editing',version=version+1,updated_at=now() where id=$5 and version=$6 returning *`,[JSON.stringify(fields.recipients),fields.subject,fields.body,fields.bodyFormat,id,expected]);
  if(!result.rows[0]) return {kind:'conflict',currentVersion:expected+1};
  const value=transactionDraft(result.rows[0]); await revision(sql,scope.userId,value,editor,before); return {kind:'updated',draft:value};
}
