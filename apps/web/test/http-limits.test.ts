import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { draftFieldsSchema } from '@hypermail/contracts';
import { connect } from 'node:net';
import { createWebServer } from '../src/server.js';
import { RequestThrottle } from '../src/security/limits.js';
import type { WebRuntime } from '../src/runtime.js';

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  server.close(error => { if (error) reject(error); else resolve(undefined); });
  await promise; server = undefined;
});
async function listen(runtime: WebRuntime, options: Parameters<typeof createWebServer>[2] = {}, throttle = new RequestThrottle(1_000)): Promise<string> {
  server = createWebServer(throttle, runtime, options);
  const { promise, resolve } = Promise.withResolvers<undefined>();
  server.listen(0, '127.0.0.1', () => { resolve(undefined); }); await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  return `http://127.0.0.1:${String(address.port)}`;
}
function streamed(url: string, parts: string[], headers: Record<string, string> = {}): Promise<{ status: number; connection: string | undefined }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; connection: string | undefined }>();
  const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
    response.resume(); response.once('end', () => {
      const status = response.statusCode;
      if (status === undefined) { reject(new Error('missing response status')); return; }
      resolve({ status, connection: response.headers.connection });
    });
  });
  req.once('error', reject);
  for (const part of parts) req.write(part);
  req.end(); return promise;
}

describe('HTTP measured route limits', () => {
  it('keeps a full 2M UTF-16 escaped draft, but rejects business overflow without raising small or MCP bounds', async () => {
    let saved = '';
    const runtime: WebRuntime = { close: () => Promise.resolve(), dispatch: request => {
      const draft = draftFieldsSchema.safeParse(request.body);
      if (!draft.success) return Promise.resolve({ status: 400 });
      saved = draft.data.body; return Promise.resolve({ status: 201 });
    } };
    const base = await listen(runtime);
    const fields = { recipients: [{ kind: 'to', address: 'owner@example.test' }], subject: 'large', body: '\u0000'.repeat(2_000_000), bodyFormat: 'markdown' };
    const raw = JSON.stringify(fields);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(12_000_000);
    const accepted = await fetch(`${base}/api/v1/drafts`, { method: 'POST', body: raw });
    expect(accepted.status).toBe(201); expect(saved).toBe(fields.body);
    const invalid = await fetch(`${base}/api/v1/drafts`, { method: 'POST', body: JSON.stringify({ ...fields, body: 'x'.repeat(2_000_001) }) });
    expect(invalid.status).toBe(400); expect(saved).toBe(fields.body);
    for (const path of ['/api/v1/auth/login', '/api/v1/agent/autonomy']) {
      expect((await fetch(`${base}${path}`, { method: 'POST', body: raw })).status).toBe(413);
    }
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: 'x'.repeat(512 * 1024 + 1) })).status).toBe(413);
    expect((await fetch(`${base}/api/v1/drafts`, { method: 'POST', body: 'x'.repeat(12_100_001) })).status).toBe(413);
  });

  it('accepts valid chunked bodies and rejects counted overflow with a readable 413 and closed connection', async () => {
    let calls = 0;
    const base = await listen({ close: () => Promise.resolve(), dispatch: () => { calls++; return Promise.resolve({ status: 204 }); } });
    expect((await streamed(`${base}/api/v1/drafts`, ['{"body":"', 'x'.repeat(10_000), '"}'])).status).toBe(204);
    expect((await streamed(`${base}/api/v1/conversations/id/messages`, ['{"content":"', 'x'.repeat(30_000), '"}'])).status).toBe(204);
    const small = await streamed(`${base}/api/v1/auth/login`, ['{"body":"', 'x'.repeat(8_193), '"}']);
    expect(small).toEqual({ status: 413, connection: 'close' });
    expect((await streamed(`${base}/api/v1/drafts`, ['x'.repeat(6_100_000), 'x'.repeat(6_100_000)])).status).toBe(413);
    expect((await streamed(`${base}/api/v1/conversations/id/messages`, ['x'.repeat(65_537)])).status).toBe(413);
    expect(calls).toBe(2);
  });
  it('lets the HTTP parser reject contradictory or invalid framing before API dispatch', async () => {
    let calls = 0;
    const base = await listen({ close: () => Promise.resolve(), dispatch: () => { calls++; return Promise.resolve({ status: 204 }); } });
    const url = new URL(base);
    for (const headers of [
      'Content-Length: invalid',
      'Content-Length: 1\r\nContent-Length: 2',
      'Content-Length: 2\r\nTransfer-Encoding: chunked',
    ]) {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const socket = connect(Number(url.port), '127.0.0.1');
      let response = '';
      socket.on('data', part => { response += part.toString(); });
      socket.once('error', reject); socket.once('close', () => { resolve(response); });
      socket.once('connect', () => socket.write(`POST /api/v1/drafts HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\nConnection: close\r\n\r\n{}`));
      expect(await promise).toMatch(/^HTTP\/1\.1 400 /);
    }
    expect(calls).toBe(0);
  });

  it('expires stalled chunked reads without dispatching the body', async () => {
    let called = false;
    const base = await listen({ close: () => Promise.resolve(), dispatch: () => { called = true; return Promise.resolve({ status: 204 }); } }, { bodyTimeoutMs: 20 });
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const req = httpRequest(`${base}/api/v1/drafts`, { method: 'POST' }, response => {
      response.resume(); response.once('end', () => {
        const status = response.statusCode;
        if (status === undefined) { reject(new Error('missing response status')); return; }
        resolve(status);
      });
    });
    req.once('error', reject); req.write('{');
    expect(await promise).toBe(408); req.destroy(); expect(called).toBe(false);
  });
});

describe('trusted proxy quotas', () => {
  const runtime: WebRuntime = { close: () => Promise.resolve(), dispatch: () => Promise.resolve({ status: 204 }) };
  it('separates clients behind an explicitly trusted relay and selects the rightmost untrusted hop', async () => {
    const base = await listen(runtime, { trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/24'] }, new RequestThrottle(1));
    const get = (forwarded: string) => fetch(`${base}/api/v1/session`, { headers: { 'x-forwarded-for': forwarded } });
    expect((await get('203.0.113.1, 10.0.0.2')).status).toBe(204);
    expect((await get('203.0.113.2, 10.0.0.2')).status).toBe(204);
    expect((await get('198.51.100.99, 203.0.113.1, 10.0.0.2')).status).toBe(429);
    expect((await get('::ffff:203.0.113.2, 10.0.0.2')).status).toBe(429);
  });
  it('ignores spoofed headers without trust and falls back on every malformed chain', async () => {
    const base = await listen(runtime, {}, new RequestThrottle(1));
    expect((await fetch(`${base}/api/v1/session`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(204);
    expect((await fetch(`${base}/api/v1/session`, { headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(429);
  });
  it('cannot bypass the socket bucket through malformed forwarded chains', async () => {
    const base = await listen(runtime, { trustedProxyCidrs: ['127.0.0.1/32'] }, new RequestThrottle(1));
    for (const [index, header] of ['203.0.113.1, nope', '203.0.113.2:123', ',203.0.113.3', 'fe80::1%eth0'].entries()) {
      const response = await fetch(`${base}/api/v1/session`, { headers: { 'x-forwarded-for': header } });
      expect(response.status).toBe(index === 0 ? 204 : 429);
    }
  });
});
