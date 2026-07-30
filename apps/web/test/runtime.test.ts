import { describe, expect, it } from 'vitest';
import { createWebRuntimeFromEnvironment } from '../src/runtime.js';

const environment = { DATABASE_URL: 'postgresql://localhost/hypermail', APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: 'https://hypermail.internal/mcp', HYPERMAIL_KEY: 'b'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated', VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments' };

describe('runtime recovery delivery', () => {
  it('uniformly refuses recovery until an ingestion-excluded delivery adapter exists', async () => {
    const runtime = createWebRuntimeFromEnvironment(environment);
    await expect(runtime.dispatch({ method: 'POST', pathname: '/api/v1/auth/recovery', query: {}, origin: 'https://mail.example.test', cookie: null, remoteAddress: '', correlationId: 'test', apiVersion: null, body: { email: 'known@example.test' } })).resolves.toEqual({ status: 503, body: { error: 'recovery_delivery_unavailable' } });
    await runtime.close();
  });
});
