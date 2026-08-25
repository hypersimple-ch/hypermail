import type * as AuthModule from '@hypermail/auth';
import type * as DbModule from '@hypermail/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => {
  let user: { id: string; email: string; passwordHash: string } | null = null;
  let session: Record<string, unknown> | null = null;
  return {
    reset: () => { user = null; session = null; },
    store: {
      countUsers: () => Promise.resolve(user ? 1 : 0),
      createFirstUser: (email: string, passwordHash: string) => {
        if (user) return Promise.resolve(null);
        user = { id: 'user', email, passwordHash };
        return Promise.resolve(user);
      },
      findUserByEmail: () => Promise.resolve(null),
      findUserById: (id: string) => Promise.resolve(user?.id === id ? user : null),
      createSession: (input: Record<string, unknown>) => {
        session = { ...input, id: 'session', createdAt: new Date(), revokedAt: null };
        return Promise.resolve(session);
      },
      findSessionByTokenHash: () => Promise.resolve(session),
      revokeSession: () => { session = null; return Promise.resolve(); },
      revokeSessionsForUser: () => { session = null; return Promise.resolve(); },
      createRecoveryToken: () => Promise.resolve({ id: 'recovery' }),
      consumeRecoveryToken: () => Promise.resolve(null),
      updatePassword: () => Promise.resolve(),
      takeRateLimit: () => Promise.resolve(true),
      audit: () => Promise.resolve(),
    },
  };
});

const database = vi.hoisted(() => ({
  query: vi.fn(() => Promise.resolve({ rows: [] })),
  transaction: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
}));

vi.mock('@hypermail/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, createPostgresAuthStore: () => authStore.store };
});
vi.mock('@hypermail/db', async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, createPostgresClient: () => database };
});

import { createWebRuntimeFromEnvironment } from '../src/runtime.js';

const environment = { DATABASE_URL: 'postgresql://localhost/hypermail', APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32), RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: 'https://hypermail.internal/mcp', HYPERMAIL_KEY: 'b'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated', VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments' };

describe('runtime recovery delivery', () => {
  beforeEach(() => { authStore.reset(); database.query.mockClear(); database.close.mockClear(); });

  it('uniformly refuses recovery until an ingestion-excluded delivery adapter exists', async () => {
    const runtime = createWebRuntimeFromEnvironment(environment);
    await expect(runtime.dispatch({ method: 'POST', pathname: '/api/v1/auth/recovery', query: {}, origin: 'https://mail.example.test', cookie: null, remoteAddress: '', correlationId: 'test', apiVersion: null, body: { email: 'known@example.test' } })).resolves.toEqual({ status: 503, body: { error: 'recovery_delivery_unavailable' } });
    await runtime.close();
  });

  it('returns only the unauthenticated error and bootstrap availability from the session route', async () => {
    const runtime = createWebRuntimeFromEnvironment(environment);
    const request = { query: {}, origin: null, cookie: null, remoteAddress: '', correlationId: 'test', apiVersion: null, body: {} } as const;
    await expect(runtime.dispatch({ ...request, method: 'GET', pathname: '/api/v1/session' })).resolves.toEqual({ status: 401, body: { error: 'unauthenticated', bootstrapAvailable: true } });
    await expect(runtime.dispatch({ ...request, method: 'POST', pathname: '/api/v1/auth/bootstrap', origin: 'https://mail.example.test', body: { email: 'owner@example.test', password: 'correct horse battery staple' } })).resolves.toMatchObject({ status: 201 });
    await expect(runtime.dispatch({ ...request, method: 'GET', pathname: '/api/v1/session' })).resolves.toEqual({ status: 401, body: { error: 'unauthenticated', bootstrapAvailable: false } });
    await runtime.close();
  });

  it('returns the safe authenticated owner identity and projected mailbox list', async () => {
    const runtime = createWebRuntimeFromEnvironment(environment);
    const base = { query: {}, remoteAddress: '127.0.0.1', correlationId: 'test', apiVersion: null, body: {} } as const;
    const bootstrap = await runtime.dispatch({ ...base, method: 'POST', pathname: '/api/v1/auth/bootstrap', origin: 'https://mail.example.test', cookie: null, body: { email: 'Owner@Example.test', password: 'correct horse battery staple' } });
    const cookie = bootstrap?.setCookie?.split(';')[0] ?? null;

    await expect(runtime.dispatch({ ...base, method: 'GET', pathname: '/api/v1/session', origin: null, cookie })).resolves.toEqual({
      status: 200,
      body: { userId: 'user', user: { id: 'user', email: 'owner@example.test' }, accounts: [], sendEnabled: false },
    });
    await runtime.close();
  });

  it('marks an owned unread message read inside the account scope and refuses unknown messages', async () => {
    const runtime = createWebRuntimeFromEnvironment(environment);
    const base = { query: {}, remoteAddress: '127.0.0.1', correlationId: 'test', apiVersion: null, body: {} } as const;
    const bootstrap = await runtime.dispatch({ ...base, method: 'POST', pathname: '/api/v1/auth/bootstrap', origin: 'https://mail.example.test', cookie: null, body: { email: 'Owner@Example.test', password: 'correct horse battery staple' } });
    const cookie = bootstrap?.setCookie?.split(';')[0] ?? null;
    const pathname = '/api/v1/messages/01234567-89ab-cdef-0123-456789abcdef/read';

    database.query.mockResolvedValueOnce({ rows: [] });
    database.query.mockResolvedValueOnce({ rows: [{ account_id: '00000000-0000-4000-8000-000000000003' }] });
    await expect(runtime.dispatch({ ...base, method: 'POST', pathname, origin: null, cookie })).resolves.toMatchObject({ status: 200 });
    const update = database.query.mock.calls.find(([statement]) => String(statement).includes('is_read = true'));
    expect(String(update?.[0])).toContain('account_id = ANY($2::uuid[])');
    expect(String(update?.[0])).toContain('deleted_at IS NULL');

    database.query.mockResolvedValueOnce({ rows: [] });
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(runtime.dispatch({ ...base, method: 'POST', pathname, origin: null, cookie })).resolves.toMatchObject({ status: 404 });
    await runtime.close();
  });
});
