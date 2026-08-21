import { describe, expect, it, vi } from 'vitest';
import { PrivateApprovedSendError, PrivateApprovedSendHttpProvider, type ApprovedSend } from '../src/index.js';

const approved: ApprovedSend = { approvalId: 'approval-1', accountId: 'account-1', draftId: 'draft-1', draftVersion: 2, idempotencyKey: 'send:approval-1:draft-1:2', recipients: [{ kind: 'to', address: 'to@example.com' }, { kind: 'cc', address: 'cc@example.com' }, { kind: 'bcc', address: 'bcc@example.com' }], subject: 'Subject', body: 'Body' };

describe('PrivateApprovedSendHttpProvider', () => {
  it('maps recipients and passes the deterministic approval key to the trusted endpoint', async () => {
    let body = ''; let authorization = ''; let idempotencyKey = '';
    const request = vi.fn((...args: Parameters<typeof fetch>) => {
      const init = args[1];
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      body = init.body;
      const headers = new Headers(init.headers);
      authorization = headers.get('authorization') ?? '';
      idempotencyKey = headers.get('idempotency-key') ?? '';
      return Promise.resolve(new Response(JSON.stringify({ providerMessageId: 'provider-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const provider = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: request });
    await expect(provider.send(approved)).resolves.toEqual({ providerMessageId: 'provider-1' });
    expect(request).toHaveBeenCalledOnce();
    expect({ authorization, idempotencyKey }).toEqual({ authorization: 'Bearer secret', idempotencyKey: approved.idempotencyKey });
    expect(JSON.parse(body) as unknown).toEqual({ approvalId: approved.approvalId, accountId: approved.accountId, draftId: approved.draftId, draftVersion: 2, idempotencyKey: approved.idempotencyKey, message: { to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject', body: 'Body' } });
  });
  it('rejects malformed results and transport errors without claiming exactly-once delivery', async () => {
    const malformed = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) });
    await expect(malformed.send(approved)).rejects.toBeInstanceOf(PrivateApprovedSendError);
    const unavailable = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')) });
    await expect(unavailable.send(approved)).rejects.toThrow('Trusted send request failed');
    const rejected = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })) });
    await expect(rejected.send(approved)).rejects.toMatchObject({ status: 503 });
  });
  it('reconciles by fixed status path and header without leaking the key in the URL', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ state: 'verified', providerMessageId: 'provider-1', observedAt: '2025-01-01T00:00:00.000Z', evidence: { source: 'hypermail_readback' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved?unsafe=old', authorization: 'Bearer secret', fetch: request });
    await expect(provider.status(approved.idempotencyKey)).resolves.toMatchObject({ state: 'verified', providerMessageId: 'provider-1' });
    const [url, init] = request.mock.calls[0] ?? [];
    const requestedUrl = url instanceof URL ? url.toString() : typeof url === 'string' ? url : url?.url ?? '';
    expect(requestedUrl).toBe('https://send.internal.test/approved/status');
    expect(requestedUrl).not.toContain(approved.idempotencyKey);
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(approved.idempotencyKey);
  });
  it('cancels a chunked trusted response once the byte cap is crossed', async () => {
    let cancelled = false; const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(33_000)); controller.enqueue(new Uint8Array(33_000)); }, cancel() { cancelled = true; } });
    const provider = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) });
    await expect(provider.send(approved)).rejects.toThrow('too large'); expect(cancelled).toBe(true);
  });
  it('bounds trusted response bodies', async () => {
    const provider = new PrivateApprovedSendHttpProvider({ endpoint: 'https://send.internal.test/approved', authorization: 'Bearer secret', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '64001' } })) });
    await expect(provider.send(approved)).rejects.toThrow('too large');
  });

});
