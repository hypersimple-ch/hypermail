import type * as AuthModule from '@hypermail/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authStore = vi.hoisted(() => {
  let users = 0;
  return {
    reset: () => { users = 0; },
    store: {
      countUsers: () => Promise.resolve(users),
      createFirstUser: (email: string, passwordHash: string) => {
        if (users) return Promise.resolve(null);
        users += 1;
        return Promise.resolve({ id: 'user', email, passwordHash });
      },
      findUserByEmail: () => Promise.resolve(null),
      findUserById: () => Promise.resolve(null),
      createSession: (input: Record<string, unknown>) => Promise.resolve({ ...input, id: 'session', createdAt: new Date(), revokedAt: null }),
      findSessionByTokenHash: () => Promise.resolve(null),
      revokeSession: () => Promise.resolve(),
      revokeSessionsForUser: () => Promise.resolve(),
      createRecoveryToken: () => Promise.resolve({ id: 'recovery' }),
      consumeRecoveryToken: () => Promise.resolve(null),
      updatePassword: () => Promise.resolve(),
      takeRateLimit: () => Promise.resolve(true),
      audit: () => Promise.resolve(),
    },
  };
});

vi.mock('@hypermail/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return { ...actual, createPostgresAuthStore: () => authStore.store };
});

import { createWebRuntimeFromEnvironment } from '../src/runtime.js';

const environment = { DATABASE_URL: 'postgresql://localhost/hypermail', APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: 'https://hypermail.internal/mcp', HYPERMAIL_KEY: 'b'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated', VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments' };

describe('runtime recovery delivery', () => {
  beforeEach(() => { authStore.reset(); });

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
});
