/* eslint-disable */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createWebServer } from '../../src/server.js';
import { createPublicMcpHttpHandler } from '../../src/mcp/http.js';
import type { WebRuntime } from '../../src/runtime.js';

const principal = { familyId: '00000000-0000-4000-8000-000000000010', clientId: 'client-a', userId: '00000000-0000-4000-8000-000000000001', connectionId: '00000000-0000-4000-8000-000000000002', mailboxId: '00000000-0000-4000-8000-000000000003', audience: '', scopes: ['agent:mailbox'], lifecycleRevision: 1, assignmentRevision: 1, grantRevision: 1, safetyRevision: 1 };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const decode = (text: string): any => { const data = text.split('\n').find(line => line.startsWith('data: ')); return JSON.parse(data ? data.slice(6) : text); };

describe('public MCP raw Streamable HTTP transport', () => {
  const servers: ReturnType<typeof createWebServer>[] = [];
  afterEach(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); servers.length = 0; });
  async function fixture(identity = principal, handlerOptions:Record<string,unknown>={}) {
    const invoked = vi.fn(async (_binding, name: string) => name === 'list_folders' ? { folders: [] } : name === 'read_attachment' ? {id:'attachment',name:'a.txt',encoding:'base64',content:'U0VDUkVUX0JBU0U2NA=='} : { messages: [] });
    const oauth = { verifyAccess: vi.fn(async (token: string) => token === 'good' || token === 'rotated' ? { ...identity, credentialId: token, audience: origin + '/mcp' } : token === 'other-family' ? { ...identity, credentialId:token, familyId:'00000000-0000-4000-8000-000000000099', audience:origin+'/mcp' } : null) };
    let origin = 'http://127.0.0.1';
    const runtime: WebRuntime = { dispatch: async () => null, close: async () => {}, publicMcp: undefined };
    const server = createWebServer(undefined, runtime); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const publicMcp=createPublicMcpHttpHandler({ oauth: oauth as never, facade: { invoke: invoked } as never, origin, ...handlerOptions });Object.defineProperty(runtime, 'publicMcp', { value:publicMcp });
    const request = (body?: unknown, headers: Record<string,string> = {}, method = 'POST') => fetch(origin + '/mcp', { method, headers: { authorization: 'Bearer good', accept: 'application/json, text/event-stream', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { request, invoked, oauth, origin, publicMcp };
  }
  it('initializes, exposes exactly the 13 public tools, permits rotated same-identity access, and deletes the session', async () => {
    const { request } = await fixture(); const initialized = await request(initialize); expect(initialized.status).toBe(200);
    const session = initialized.headers.get('mcp-session-id'); expect(session).toBeTruthy(); expect(decode(await initialized.text()).result.protocolVersion).toBe('2025-11-25');
    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': session!, 'mcp-protocol-version': '2025-11-25', authorization: 'Bearer rotated' });
    const names = decode(await listed.text()).result.tools.map((tool: {name:string}) => tool.name);
    expect(names).toEqual(['list_emails','search_emails','read_email','read_attachment','list_folders','archive_email','trash_email','move_email','mark_read','mark_unread','draft_email','edit_draft','request_send_email']);
    const removed = await request(undefined, { 'mcp-session-id': session! }, 'DELETE'); expect(removed.status).toBe(200);
    const second=await request(initialize);const secondSession=second.headers.get('mcp-session-id');await second.text();const crossed=await request({jsonrpc:'2.0',id:3,method:'tools/list',params:{}},{'mcp-session-id':secondSession!,'mcp-protocol-version':'2025-11-25',authorization:'Bearer other-family'});expect(crossed.status).toBe(404);
    const victimStillUsable=await request({jsonrpc:'2.0',id:4,method:'tools/list',params:{}},{'mcp-session-id':secondSession!,'mcp-protocol-version':'2025-11-25'});expect(victimStillUsable.status).toBe(200);await victimStillUsable.text();
    expect((await request(undefined, { 'mcp-session-id': session! }, 'GET')).status).toBe(404);
  });
  it('challenges every method and rejects malformed, oversized, unknown, and identity-mismatched requests', async () => {
    const { request, origin } = await fixture();
    const unauthorized = await fetch(origin + '/mcp', { method: 'GET', headers: { host: new URL(origin).host } }); expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    expect((await fetch(origin + '/mcp', { method:'POST', headers:{ authorization:'Bearer good', accept:'application/json, text/event-stream', 'content-type':'application/json' }, body:'{' })).status).toBe(400);
    expect((await request({jsonrpc:'2.0',id:1,method:'tools/list'}, {'mcp-session-id':'unknown'})).status).toBe(404);
    const initialized = await request(initialize); const session = initialized.headers.get('mcp-session-id')!; await initialized.text();
    const other = createPublicMcpHttpHandler({ oauth: { verifyAccess: async () => ({ ...principal, mailboxId:'00000000-0000-4000-8000-000000000099', audience:origin+'/mcp' }) } as never, facade:{invoke:async()=>({})} as never, origin }); await other.close();
    const huge = 'x'.repeat(512 * 1024 + 1); expect((await fetch(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer good','content-type':'application/json',accept:'application/json, text/event-stream'},body:huge})).status).toBe(413);
    expect(session).toBeTruthy();
  });
  it('throttles invalid bearer attempts before repeated verification',async()=>{
    const {origin,oauth}=await fixture(principal,{preAuthLimit:2,preAuthWindowMs:60_000});const send=(token:string)=>fetch(origin+'/mcp',{method:'GET',headers:{authorization:`Bearer ${token}`}});
    expect((await send('invalid-one')).status).toBe(401);expect((await send('invalid-two')).status).toBe(401);expect((await send('invalid-three')).status).toBe(429);expect(oauth.verifyAccess).toHaveBeenCalledTimes(2);
  });
  it('reserves initialization admission atomically and releases failed initialize reservations',async()=>{
    const {request,publicMcp}=await fixture(principal,{maxSessions:1,preAuthLimit:20});
    const malformed=await request({...initialize,params:{}});expect([400,200]).toContain(malformed.status);await malformed.text();expect(publicMcp.sessionCount).toBe(0);
    const [one,two]=await Promise.all([request(initialize),request(initialize)]);expect([one.status,two.status].sort()).toEqual([200,503]);await Promise.all([one.text(),two.text()]);expect(publicMcp.sessionCount).toBe(1);
  });
  it('does not duplicate attachment base64 in MCP text content',async()=>{
    const {request}=await fixture();const initialized=await request(initialize);const session=initialized.headers.get('mcp-session-id')!;await initialized.text();const called=await request({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_attachment',arguments:{messageId:'44444444-4444-4444-8444-444444444444',attachmentId:'55555555-5555-4555-8555-555555555555'}}},{'mcp-session-id':session,'mcp-protocol-version':'2025-11-25'});const result=decode(await called.text()).result;expect(result.structuredContent.content).toBe('U0VDUkVUX0JBU0U2NA==');expect(result.content[0].text).not.toContain('U0VDUkVUX0JBU0U2NA==');
  });

  it('closes managed resources when MCP server connection fails',async()=>{
    const closed:string[]=[];const connectSession=async(server:{close:()=>Promise<void>},transport:{close:()=>Promise<void>})=>{const serverClose=server.close.bind(server),transportClose=transport.close.bind(transport);server.close=async()=>{closed.push('server');await serverClose()};transport.close=async()=>{closed.push('transport');await transportClose()};throw new Error('connect failed')};
    const {request,publicMcp}=await fixture(principal,{connectSession});const response=await request(initialize);expect(response.status).toBe(503);expect(publicMcp.sessionCount).toBe(0);expect(closed.sort()).toEqual(['server','transport']);
  });

});
