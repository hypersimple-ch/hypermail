import { once } from 'node:events';import { request } from 'node:http';import { afterEach,describe,expect,it } from 'vitest';import { createWebServer } from '../src/server.js';import type { WebRuntime } from '../src/runtime.js';
let close:undefined|(()=>Promise<void>);afterEach(async()=>{await close?.();close=undefined;});
async function call(method:string,path:string,body:string,contentType?:string){const seen:string[]=[];const runtime:WebRuntime={dispatch:r=>{seen.push(r.contentType??'');return Promise.resolve({status:200,body:{ok:true}});},close:()=>Promise.resolve()};const server=createWebServer(undefined,runtime);server.listen(0,'127.0.0.1');await once(server,'listening');close=()=>new Promise(resolve=>server.close(()=>{resolve();}));const address=server.address();if(!address||typeof address==='string')throw new Error('address');return await new Promise<{status:number;seen:string[]}>(resolve=>{const req=request({host:'127.0.0.1',port:address.port,path,method,headers:{...(contentType?{'content-type':contentType}:{}),'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>{resolve({status:res.statusCode??0,seen});});});req.end(body);});}
describe('OAuth HTTP form adapter',()=>{it('passes exact form media type',async()=>{expect(await call('POST','/oauth/token','a=1','application/x-www-form-urlencoded; charset=utf-8')).toEqual({status:200,seen:['application/x-www-form-urlencoded']});});it('maps duplicate fields to 400 before dispatch',async()=>{expect(await call('POST','/oauth/token','a=1&a=2','application/x-www-form-urlencoded')).toEqual({status:400,seen:[]});});it('maps oversized forms to 413',async()=>{expect(await call('POST','/oauth/token','a='.padEnd(8193,'x'),'application/x-www-form-urlencoded')).toEqual({status:413,seen:[]});});});

async function redirectListener(status = 303, includeLocation = true): Promise<string> {
  const runtime: WebRuntime = {
    dispatch: () => Promise.resolve({
      status,
      headers: { ...(includeLocation ? { Location: 'https://client.example.test/callback?code=server-issued&state=approved%2Bstate' } : {}), 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      ...(status === 400 ? { body: { error: 'invalid_request' } } : {}),
    }),
    close: () => Promise.resolve(),
  };
  const server = createWebServer(undefined, runtime);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  close = () => {
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    server.close((error) => { if (error) reject(error); else resolve(undefined); });
    return promise;
  };
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('OAuth consent HTTP representations', () => {
  it('returns the completed server redirect as JSON without asking fetch to follow it', async () => {
    const origin = await redirectListener();
    const response = await fetch(`${origin}/oauth/authorize`, { method: 'POST', headers: { Accept: 'application/json; charset=utf-8', 'Content-Type': 'application/json' }, body: '{"request_token":"request","decision":"allow","mailbox_id":"owned"}' });
    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.get('pragma')).toBe('no-cache');
    await expect(response.json()).resolves.toEqual({ redirectUrl: 'https://client.example.test/callback?code=server-issued&state=approved%2Bstate' });
  });

  it('keeps default, form and wildcard clients on the original redirect contract', async () => {
    const origin = await redirectListener();
    for (const accept of [undefined, '*/*', 'application/*', 'application/json;q=0', 'application/json-extra']) {
      const response = await fetch(`${origin}/oauth/authorize`, { method: 'POST', headers: accept ? { Accept: accept } : {}, body: new URLSearchParams({ request_token: 'request', decision: 'deny' }), redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://client.example.test/callback?code=server-issued&state=approved%2Bstate');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Accept');
    }
    for (const [method, path] of [['GET', '/oauth/authorize'], ['POST', '/oauth/token'], ['POST', '/oauth/authorize/']] as const) {
      const response = await fetch(`${origin}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://client.example.test/callback?code=server-issued&state=approved%2Bstate');
    }
  });

  it('keeps rejected decisions as errors rather than manufacturing a redirect', async () => {
    const origin = await redirectListener(400, false);
    const response = await fetch(`${origin}/oauth/authorize`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Accept');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
    const malformed = await fetch(`${origin}/oauth/authorize`, { method: 'POST', headers: { Accept: 'text/html', 'Content-Type': 'application/json' }, body: '{', redirect: 'manual' });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/json');
    expect(malformed.headers.get('cache-control')).toBe('no-store');
    expect(malformed.headers.get('vary')).toBe('Accept');
  });
});
