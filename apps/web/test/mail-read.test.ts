import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HypermailReadClient, Message } from '@hypermail/hypermail';
import type { SqlClient } from '../src/activity/postgres-repository.js';
import { MailboxPageReader, type MailReadProvider } from '../src/mailbox-page.js';
import { MessageReader } from '../src/message-reader.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const scope = {subjectId:userId,accountIds:[accountId]};
const provider = (read: Partial<HypermailReadClient>): MailReadProvider => ({withRead: (_id, operation) => operation(read as HypermailReadClient)});
function database(rows: (statement: string, values: readonly unknown[]) => readonly Record<string,unknown>[]): SqlClient {
  const sql: SqlClient = {
    query: (statement, values = []) => Promise.resolve({rows:rows(statement,values) as never[]}),
    transaction: operation => operation(sql),
  };
  return sql;
}

describe('provider-backed owner mail reads', () => {
  it('loads 125 provider Inbox messages across signed pages and rejects cross-scope/tampered/expired cursors', async () => {
    const messages: Message[] = Array.from({length:125},(_,i)=>({id:`mail-${String(i)}`,account:'owner@example.test',subject:`Subject ${String(i)}`,receivedAt:'2026-10-01T12:00:00Z'}));
    const projected = new Map<string,string>();
    const sql = database((statement,values) => {
      if (statement.startsWith('select email')) return [{email:'owner@example.test'}];
      if (statement.startsWith('insert into app.folders')) return [{id:'folder-projection'}];
      if (statement.startsWith('insert into app.messages')) { const id=String(values[1]);projected.set(id,id);return [{id}]; }
      throw new Error('Unexpected read side effect');
    });
    const mailboxPage = vi.fn((_account: string,input: {folder?:string;skip?:number;limit?:number} = {}) => {
      if (input.folder !== 'provider-inbox') throw new Error('Not Inbox');
      const skip=input.skip ?? 0, limit=input.limit ?? 50;
      return Promise.resolve({messages:messages.slice(skip,skip+limit),hasMore:skip+limit<messages.length});
    });
    let now=Date.parse('2026-10-05T12:00:00Z');
    const reader=new MailboxPageReader(sql,provider({folders:()=>Promise.resolve([{id:'provider-inbox',displayName:'Inbox',wellKnownName:'inbox'}]),mailboxPage}),'secret',()=>now);
    const first=await reader.page(scope,accountId);
    if (first.nextCursor === null) throw new Error('missing first page cursor');
    const second=await reader.page(scope,accountId,first.nextCursor);
    if (second.nextCursor === null) throw new Error('missing second page cursor');
    const third=await reader.page(scope,accountId,second.nextCursor);
    expect([...first.messages,...second.messages,...third.messages].map(m=>m.id)).toEqual(messages.map(m=>m.id));
    expect(third.nextCursor).toBeNull();
    await expect(reader.page(scope,accountId,`${first.nextCursor}x`)).rejects.toMatchObject({status:400,code:'INVALID_CURSOR'});
    await expect(reader.page({...scope,subjectId:'other'},accountId,first.nextCursor)).rejects.toMatchObject({status:400});
    const otherAccount='44444444-4444-4444-8444-444444444444';
    await expect(reader.page({...scope,accountIds:[accountId,otherAccount]},otherAccount,first.nextCursor)).rejects.toMatchObject({status:400});
    const cursorKey = createHmac('sha256', 'secret').update('hypermail:inbox-cursor:v1').digest();
    const unsupportedPayload = Buffer.from(JSON.stringify({version:2,userId,accountId,folderId:'provider-inbox',providerCursor:50,expiresAt:now+15*60_000})).toString('base64url');
    const unsupportedCursor = `${unsupportedPayload}.${createHmac('sha256',cursorKey).update(unsupportedPayload).digest('base64url')}`;
    await expect(reader.page(scope,accountId,unsupportedCursor)).rejects.toMatchObject({status:400,code:'INVALID_CURSOR'});
    now+=15*60_000;
    await expect(reader.page(scope,accountId,first.nextCursor)).rejects.toMatchObject({status:400});
    expect(projected.size).toBe(125);
  });
  it('reads the full provider body, blocks scripts/remote images and refreshes expired cache without preview fallback', async () => {
    let cached: Record<string,unknown> = {text_body:null,sanitized_html_body:null,purge_after:null};
    const sql=database((statement,values) => {
      if (statement.startsWith('select m.id')) return [{id:messageId,account_id:accountId,email:'owner@example.test',provider_message_id:'provider-id',sender:{address:'sender@example.test'},subject:'Subject',preview:'SHORT PREVIEW',received_at:'2026-10-01T12:00:00Z',...cached}];
      if (statement.startsWith('insert into app.message_bodies')) {cached={text_body:values[1],sanitized_html_body:values[2],purge_after:values[4]};return [];}
      if (statement.startsWith('select id,filename')) return [];
      throw new Error('Unexpected read mutation');
    });
    const readMessage=vi.fn(()=>Promise.resolve({id:'provider-id',account:'owner@example.test',body:'<p>COMPLETE BODY</p><script>bad()</script><img src="https://tracker.test/x">',bodyFormat:'html' as const}));
    let now=Date.parse('2026-10-05T12:00:00Z');
    const reader=new MessageReader(sql,provider({readMessage}),()=>now,1000);
    const first=await reader.read(scope,messageId);
    expect(first.body).toBe('COMPLETE BODY');
    expect(first.sanitizedHtml).toBe('<p>COMPLETE BODY</p>');
    expect((await reader.read(scope,messageId)).body).toBe('COMPLETE BODY');
    expect(readMessage).toHaveBeenCalledTimes(1);
    now+=1001;readMessage.mockRejectedValueOnce(new Error('offline'));
    await expect(reader.read(scope,messageId)).rejects.toMatchObject({status:503,code:'PROVIDER_UNAVAILABLE'});
  });
});
