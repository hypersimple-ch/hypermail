/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import type { ManagedSqlClient } from '@hypermail/db';
import { PolicyExecutor, type Completion, type PolicyPersistence } from '@hypermail/policy';
import { HypermailPrivateMutationTransport } from '../src/policy.js';

const ids = { account: '11111111-1111-4111-8111-111111111111', run: '77777777-7777-4777-8777-777777777777', user: '88888888-8888-4888-8888-888888888888', message: '22222222-2222-4222-8222-222222222222', folder: '33333333-3333-4333-8333-333333333333', activity: '44444444-4444-4444-8444-444444444444', decision: '55555555-5555-4555-8555-555555555555' };
const database = (query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }>) => {
  const db = { query, transaction: async <T>(operation: (client: ManagedSqlClient) => Promise<T>) => operation(db as unknown as ManagedSqlClient), close: () => Promise.resolve() };
  return db as unknown as ManagedSqlClient;
};

describe('worker policy boundary', () => {
  it('persists bounded folder lookup progress across transport restart and ends exhausted without provider mutation',async()=>{
    let cursor:string|null=null,expired=false;const skips:number[]=[];
    const db=database(async(sql,values)=>{
      if(sql.includes('from app.folders'))return {rows:[{id:ids.folder,providerFolderId:'archive-provider'}]};
      if(sql.includes('select verification_cursor'))return {rows:[{cursor,expired,folderId:cursor?'archive-provider':null}]};
      if(sql.includes('set verification_cursor')){const progress=values?.[1];if(progress&&typeof progress==='object'&&'cursor' in progress&&(progress.cursor===null||typeof progress.cursor==='string'))cursor=progress.cursor;else throw new Error('invalid verification cursor');return {rows:[]};}
      return {rows:[{email:'owner@test.invalid',providerMessageId:'target'}]};
    });
    let mutations=0;const client={call:async(name:string,args:Record<string,unknown>)=>{
      if(name!=='list_emails'){mutations++;throw new Error('unexpected mutation');}
      const skip=Number(args['skip']);skips.push(skip);return {items:skip===5000?[{id:'target'}]:[{id:`other-${String(skip)}`}],hasMore:skip<5000};
    }};
    const target={accountId:ids.account,messageId:ids.message};
    const first=new HypermailPrivateMutationTransport(db,client,()=>Promise.resolve());
    expect(await first.read(target,'archive',ids.activity)).toEqual({verificationState:'incomplete'});expect(cursor).toBe('5000');
    const restarted=new HypermailPrivateMutationTransport(db,client,()=>Promise.resolve());
    expect(await restarted.read(target,'archive',ids.activity)).toEqual({folderRole:'archive'});expect(skips.at(-1)).toBe(5000);
    expired=true;const before=skips.length;
    expect(await restarted.read(target,'archive',ids.activity)).toEqual({verificationState:'exhausted'});expect(skips.length).toBe(before);expect(mutations).toBe(0);
  });
  it('uses exact allowlisted tool names and provider identities, never app UUIDs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = database(async sql => ({ rows: sql.includes('app.folders') ? [{ providerFolderId: 'provider-folder' }] : sql.includes('update app.messages') ? [{ id: ids.message }] : [{ email: 'account@example.test', providerMessageId: 'provider-message' }] }));
    const transport = new HypermailPrivateMutationTransport(db, { call: async (name, args) => { calls.push({ name, args }); if (name === 'archive_email') return { archived: true, id: 'provider-message' }; if (name === 'trash_email') return { trashed: true, id: 'provider-message' }; if (name === 'move_email') return { moved: true, id: 'provider-message', destination: args['destination'] }; return { marked: true, id: 'provider-message', isRead: name === 'mark_read' }; } }, () => Promise.resolve());
    await transport.archive({ target: { accountId: ids.account, messageId: ids.message }, idempotencyKey: 'x'.repeat(16) });
    await transport.recoverableTrash({ target: { accountId: ids.account, messageId: ids.message }, idempotencyKey: 'x'.repeat(16) });
    await transport.move({ target: { accountId: ids.account, messageId: ids.message, destinationFolderId: ids.folder }, idempotencyKey: 'x'.repeat(16) });
    await transport.markRead({ target: { accountId: ids.account, messageId: ids.message }, idempotencyKey: 'x'.repeat(16) });
    await transport.markUnread({ target: { accountId: ids.account, messageId: ids.message }, idempotencyKey: 'x'.repeat(16) });
    expect(calls).toEqual([
      { name: 'archive_email', args: { account: 'account@example.test', id: 'provider-message' } },
      { name: 'trash_email', args: { account: 'account@example.test', id: 'provider-message' } },
      { name: 'move_email', args: { account: 'account@example.test', id: 'provider-message', destination: 'provider-folder' } },
      { name: 'mark_read', args: { account: 'account@example.test', id: 'provider-message' } },
      { name: 'mark_unread', args: { account: 'account@example.test', id: 'provider-message' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain(ids.message);
    expect(Object.keys(transport)).not.toContain('send');
  });

  it('does not fabricate folder verification facts', async () => {
    const completed: Completion[] = [];
    const persistence: PolicyPersistence = {
      claim: async () => ({ actionId: ids.activity, accountId: ids.account, run: true }), claimImmediatelyBeforeMutation: async () => 'run', reportProvider: async () => undefined,
      complete: async (_action, _account, completion) => { completed.push(completion); return completion.outcome; },
    };
    const transport = new HypermailPrivateMutationTransport(database(async sql => ({ rows: sql.includes('app.folders')?[]:[{ email: 'a@example.test', providerMessageId: 'provider' }] })), { call: async name => name === 'archive_email' ? { archived: true, id: 'provider' } : name === 'read_email' ? { isRead: true } : name === 'list_emails' ? { items: [], hasMore: false } : {} }, () => Promise.resolve());
    await new PolicyExecutor({ persistence, transport, isGloballyPaused: () => false }).execute({ actionId: ids.activity, runId: ids.run, userId: ids.user, activityId: ids.activity, decisionId: ids.decision, idempotencyKey: 'x'.repeat(16), kind: 'archive', target: { accountId: ids.account, messageId: ids.message }, precondition: {} });
    expect(completed[0]).toMatchObject({ outcome: 'unverifiable', errorCode: 'VERIFICATION_INSUFFICIENT', observed: {} });
  });

  it('does not mutate while an account pause is authoritative', async () => {
    let mutations = 0;
    const persistence: PolicyPersistence = {
      claim: async () => ({ actionId: ids.activity, accountId: ids.account, run: false }), claimImmediatelyBeforeMutation: async () => 'paused', reportProvider: async () => undefined,
      complete: async (_action, _account, completion) => completion.outcome,
    };
    const transport = { archive: async () => { mutations += 1; return {}; }, recoverableTrash: async () => ({}), move: async () => ({}), markRead: async () => ({}), markUnread: async () => ({}), draftCreate: async () => ({}), draftEdit: async () => ({}) };
    await expect(new PolicyExecutor({ persistence, transport, isGloballyPaused: () => false }).execute({ actionId: ids.activity, runId: ids.run, userId: ids.user, activityId: ids.activity, decisionId: ids.decision, idempotencyKey: 'x'.repeat(16), kind: 'archive', target: { accountId: ids.account, messageId: ids.message }, precondition: {} })).resolves.toMatchObject({ outcome: 'paused' });
    expect(mutations).toBe(0);
  });


  it('creates and edits provider drafts from durable app drafts and retains changed provider IDs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []; const retained: string[] = [];
    let providerDraftId: string | null = null;
    const db = database(async (sql, values) => {
      if (sql.includes('from app.drafts')) return { rows: [{ email: 'account@example.test', providerDraftId, sourceProviderMessageId: 'source-provider', recipients: [{ kind: 'to', address: 'to@example.test' }], subject: 'Draft subject', body: '<p>Draft body</p>', bodyFormat: 'html', version: 2 }] };
      if (sql.includes('app.draft_revisions')) return { rows: [{ body: 'Old body', bodyFormat: 'markdown' }] };
      if (sql.includes('update app.drafts')) { providerDraftId = String(values?.[0]); retained.push(providerDraftId); return { rows: [{ id: ids.folder }] }; }
      return { rows: [] };
    });
    const client = { call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'draft_email') return { draft: true, id: 'provider-draft-1', draftHtml: '<p>Draft body</p>' };
      if (name === 'read_email') return { id: providerDraftId, subject: 'Draft subject', body: '<p>Old body</p>\n<blockquote>Quoted history</blockquote>', bodyFormat: 'html' };
      return { edited: true, id: 'provider-draft-2', draftHtml: '<p>Draft body</p>' };
    } };
    const transport = new HypermailPrivateMutationTransport(db, client, () => Promise.resolve());
    await expect(transport.draftCreate({ target: { accountId: ids.account, draftId: ids.folder }, idempotencyKey: 'x'.repeat(16) })).resolves.toMatchObject({ providerDraftId: 'provider-draft-1' });
    await expect(transport.draftEdit({ target: { accountId: ids.account, draftId: ids.folder }, idempotencyKey: 'y'.repeat(16) })).resolves.toMatchObject({ providerDraftId: 'provider-draft-2' });
    expect(retained).toEqual(['provider-draft-1', 'provider-draft-2']);
    expect(calls[0]).toMatchObject({ name: 'draft_email', args: { account: 'account@example.test', inReplyTo: 'source-provider', format: 'html' } });
    expect(calls.at(-1)).toMatchObject({ name: 'edit_draft', args: { id: 'provider-draft-1', old_text: '<p>Old body</p>', new_text: '<p>Draft body</p>', format: 'html' } });
    await expect(transport.read({ accountId: ids.account, draftId: ids.folder })).resolves.toEqual({ draftId: ids.folder });
  });


  it('compares prior HTML revisions unchanged during exact edit verification', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = database(async sql => {
      if (sql.includes('from app.drafts')) return { rows: [{ email: 'account@example.test', providerDraftId: 'provider-draft', sourceProviderMessageId: null, recipients: [{ kind: 'to', address: 'to@example.test' }], subject: 'Draft subject', body: '<p>New rich body</p>', bodyFormat: 'html', version: 2 }] };
      if (sql.includes('app.draft_revisions')) return { rows: [{ body: '<p>Old rich body</p>', bodyFormat: 'html' }] };
      if (sql.includes('update app.drafts')) return { rows: [{ id: ids.folder }] };
      return { rows: [] };
    });
    const transport = new HypermailPrivateMutationTransport(db, { call: async (name, args) => { calls.push({ name, args }); return name === 'read_email' ? { id: 'provider-draft', body: '<p>Old rich body</p><blockquote>Quote</blockquote>', bodyFormat: 'html' } : { edited: true, id: 'provider-draft' }; } }, () => Promise.resolve());
    await transport.draftEdit({ target: { accountId: ids.account, draftId: ids.folder }, idempotencyKey: 'html'.repeat(4) });
    expect(calls.at(-1)).toMatchObject({ name: 'edit_draft', args: { old_text: '<p>Old rich body</p>', new_text: '<p>New rich body</p>', format: 'html' } });
  });

  it('fails closed after a draft may have been created but its provider ID was not retained', async () => {
    let priorAttempt = false; let providerCalls = 0;
    const db = database(async sql => {
      if (sql.includes('from app.actions')) return { rows: priorAttempt ? [{ id: ids.activity }] : [] };
      if (sql.includes('from app.drafts')) return { rows: [{ email: 'account@example.test', providerDraftId: null, sourceProviderMessageId: null, recipients: [{ kind: 'to', address: 'to@example.test' }], subject: 'Draft subject', body: 'Draft body', bodyFormat: 'markdown', version: 2 }] };
      if (sql.includes('update app.drafts')) { priorAttempt = true; throw new Error('database unavailable after provider mutation'); }
      return { rows: [] };
    });
    const transport = new HypermailPrivateMutationTransport(db, { call: async () => { providerCalls += 1; return { draft: true, id: 'orphaned-provider-draft' }; } }, () => Promise.resolve());
    await expect(transport.draftCreate({ target: { accountId: ids.account, draftId: ids.folder }, idempotencyKey: 'first'.repeat(4) })).rejects.toThrow('database unavailable');
    await expect(transport.draftCreate({ target: { accountId: ids.account, draftId: ids.folder }, idempotencyKey: 'second'.repeat(4) })).rejects.toThrow('POLICY_DRAFT_CREATE_ALREADY_ATTEMPTED');
    expect(providerCalls).toBe(1);
  });

});
