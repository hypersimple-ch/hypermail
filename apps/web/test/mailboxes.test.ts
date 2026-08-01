import type { AddAccountResult, CompleteAddAccountResult } from '@hypermail/hypermail';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxRoutes } from '../src/mailboxes/routes.js';
import { MailboxService } from '../src/mailboxes/service.js';

const origin = 'https://mail.example.test';
const auth = { subjectId: 'owner-1' } as const;
const readyProjection = { id: 'account-1', provider: 'gmail', email: 'owner@example.test', displayName: 'Owner', state: 'ready' } as const;

function harness() {
  const provider = {
    initialize: vi.fn(() => Promise.resolve({})),
    addAccount: vi.fn<(_: Parameters<MailboxService['start']>[1]) => Promise<AddAccountResult>>(),
    completeAddAccount: vi.fn<(_: Parameters<MailboxService['complete']>[1]) => Promise<CompleteAddAccountResult>>(),
  };
  const projector = { projectReadyAccount: vi.fn(() => Promise.resolve(readyProjection)) };
  const service = new MailboxService(provider, projector);
  return { provider, projector, routes: createMailboxRoutes(service, { expectedOrigin: origin }) };
}

const request = (body: Readonly<Record<string, unknown>>, overrides: Partial<{ method: string; origin: string | null; auth: typeof auth | null }> = {}) => ({
  method: overrides.method ?? 'POST',
  origin: overrides.origin === undefined ? origin : overrides.origin,
  auth: overrides.auth === undefined ? auth : overrides.auth,
  body,
});

describe('owner mailbox routes', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('starts Outlook device-code verification without projecting a pending account', async () => {
    const { provider, projector, routes } = harness();
    provider.addAccount.mockResolvedValue({
      status: 'pending',
      handle: 'opaque-handle',
      verification: { type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2030-01-01T00:00:00.000Z', message: 'Continue with Microsoft.' },
    });

    const response = await routes.start(request({ provider: 'outlook', email: ' Owner@Example.test ' }));

    expect(response).toMatchObject({ status: 202, body: { status: 'pending', handle: 'opaque-handle' } });
    expect(provider.addAccount).toHaveBeenCalledWith({ provider: 'outlook', email: 'owner@example.test' });
    expect(projector.projectReadyAccount).not.toHaveBeenCalled();
  });

  it('projects only safe public metadata after synchronous IMAP readiness', async () => {
    const { provider, projector, routes } = harness();
    const credential = ['test', 'credential'].join('-');
    provider.addAccount.mockResolvedValue({ status: 'ready', account: { provider: 'imap', email: 'owner@example.test', displayName: 'Owner', state: 'ready' } });
    projector.projectReadyAccount.mockResolvedValue({ ...readyProjection, provider: 'imap' });

    const response = await routes.start(request({ provider: 'imap', email: 'owner@example.test', config: { host: 'imap.example.test', port: 993, secure: true, user: 'owner@example.test', password: credential, smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true } }));

    expect(response).toMatchObject({ status: 201, body: { status: 'ready', account: { provider: 'imap', email: 'owner@example.test' } } });
    expect(projector.projectReadyAccount).toHaveBeenCalledWith('owner-1', { provider: 'imap', email: 'owner@example.test', displayName: 'Owner' });
    expect(JSON.stringify(response)).not.toContain(credential);
  });

  it('completes Gmail with request-only callback data and returns no callback values', async () => {
    const { provider, routes } = harness();
    const callbackCode = ['callback', 'value'].join('-');
    provider.completeAddAccount.mockResolvedValue({ status: 'ready', account: { provider: 'gmail', email: 'owner@example.test', displayName: 'Owner' } });

    const response = await routes.complete(request({ provider: 'gmail', handle: 'opaque-handle', code: callbackCode, state: 'opaque-state' }));

    expect(response.status).toBe(200);
    expect(provider.completeAddAccount).toHaveBeenCalledWith({ provider: 'gmail', handle: 'opaque-handle', code: callbackCode, state: 'opaque-state' });
    expect(JSON.stringify(response)).not.toContain(callbackCode);
    expect(JSON.stringify(response)).not.toContain('opaque-state');
  });

  it('maps pending, expired, and provider error completion states without raw errors', async () => {
    const { provider, routes } = harness();
    provider.completeAddAccount.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'expired' }).mockResolvedValueOnce({ status: 'error', reason: 'provider_configuration' });
    const body = { provider: 'outlook', handle: 'opaque-handle' };

    await expect(routes.complete(request(body))).resolves.toEqual({ status: 202, body: { status: 'pending' } });
    await expect(routes.complete(request(body))).resolves.toEqual({ status: 410, body: { status: 'expired' } });
    await expect(routes.complete(request(body))).resolves.toEqual({ status: 502, body: { status: 'error', reason: 'provider_configuration' } });
  });

  it('rejects wrong method, cross-origin, unauthenticated, extra fields, and invalid IMAP input before provider I/O', async () => {
    const { provider, routes } = harness();

    await expect(routes.start(request({ provider: 'gmail' }, { method: 'GET' }))).resolves.toMatchObject({ status: 405 });
    await expect(routes.start(request({ provider: 'gmail' }, { origin: 'https://evil.example' }))).resolves.toMatchObject({ status: 403 });
    await expect(routes.start(request({ provider: 'gmail' }, { auth: null }))).resolves.toMatchObject({ status: 401 });
    await expect(routes.start(request({ provider: 'gmail', unexpected: true }))).resolves.toMatchObject({ status: 400 });
    await expect(routes.start(request({ provider: 'imap', email: 'owner@example.test', config: { host: 'bad host', user: 'owner', password: 'x' } }))).resolves.toMatchObject({ status: 400 });
    expect(provider.addAccount).not.toHaveBeenCalled();
  });

  it('initializes once and replaces provider exceptions with a bounded response', async () => {
    const { provider, routes } = harness();
    provider.addAccount.mockRejectedValue(new Error('remote detail must not escape'));

    const first = await routes.start(request({ provider: 'gmail' }));
    const second = await routes.start(request({ provider: 'gmail' }));

    expect(first).toEqual({ status: 503, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mailbox provider is unavailable.' } } });
    expect(JSON.stringify(first)).not.toContain('remote detail');
    expect(second.status).toBe(503);
    expect(provider.initialize).toHaveBeenCalledTimes(1);
  });
});
