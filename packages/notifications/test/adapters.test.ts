/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-parameters -- deterministic async adapter doubles */
import { describe, expect, it } from 'vitest';
import { PostgresNotificationPersistence, type PostgreSqlClient, type PushSubscriptionCryptoCodec, WebPushVapidTransport, type WebPushClient } from '../src/index.js';

class Codec implements PushSubscriptionCryptoCodec {
  encrypted: string[] = [];
  decrypted: string[] = [];
  hashes: string[] = [];
  async encrypt(value: string) { this.encrypted.push(value); return `encrypted-${String(this.encrypted.length)}`; }
  async decrypt(value: string) { this.decrypted.push(value); return value.replace('cipher:', ''); }
  async hashEndpoint(value: string) { this.hashes.push(value); return `endpoint-digest-${String(this.hashes.length)}`; }
}

class QueryRecorder implements PostgreSqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  results: Array<readonly Record<string, unknown>[]> = [];
  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    return { rows: (this.results.shift() ?? []) as readonly Row[] };
  }
}

describe('PostgresNotificationPersistence', () => {
  it('uses parameterized deduplicating SQL and only ciphertext for subscription persistence', async () => {
    const db = new QueryRecorder(); const codec = new Codec();
    db.results.push([{ id: 'sub-1' }]);
    const persistence = new PostgresNotificationPersistence(db, codec);
    await persistence.upsertSubscription({ userId: 'u1', endpoint: 'https://push.example/private', p256dh: 'public-material', auth: 'secret-auth' });
    const call = db.calls[0];
    expect(call?.text).toContain('ON CONFLICT (endpoint_hash) DO UPDATE');
    expect(call?.text).not.toContain('https://push.example/private');
    expect(call?.values).toEqual(['u1', 'endpoint-digest-1', 'encrypted-1', 'encrypted-2', 'encrypted-3', null]);
    expect(JSON.stringify(call?.values)).not.toContain('https://push.example/private');
    expect(JSON.stringify(call?.values)).not.toContain('secret-auth');
    expect(codec.hashes).toEqual(['https://push.example/private']);
    expect(codec.encrypted).toEqual(['https://push.example/private', 'public-material', 'secret-auth']);
  });

  it('claims sequential attempts with a single guarded SQL statement', async () => {
    const db = new QueryRecorder(); const persistence = new PostgresNotificationPersistence(db, new Codec());
    db.results.push([{ attempt: 2 }]);
    await expect(persistence.claimDelivery('n1', 's1', 3)).resolves.toEqual({ notificationId: 'n1', subscriptionId: 's1', attempt: 2 });
    const call = db.calls[0];
    expect(call?.values).toEqual(['n1', 's1', 3]);
    expect(call?.text).toContain('FOR UPDATE');
    expect(call?.text).toContain("state IN ('succeeded', 'permanent_failure')");
    expect(call?.text).toContain('ON CONFLICT (notification_id, subscription_id, attempt) DO NOTHING');
    db.results.push([]);
    await expect(persistence.claimDelivery('n1', 's1', 3)).resolves.toBeNull();
  });

  it('decrypts enabled rows only at the provider boundary and disables by endpoint hash', async () => {
    const db = new QueryRecorder(); const codec = new Codec(); const persistence = new PostgresNotificationPersistence(db, codec);
    db.results.push([{ id: 's1', endpoint_ciphertext: 'cipher:endpoint', p256dh_ciphertext: 'cipher:key', auth_ciphertext: 'cipher:auth' }]);
    await expect(persistence.listEnabledSubscriptions('u1')).resolves.toEqual([{ id: 's1', endpoint: 'endpoint', p256dh: 'key', auth: 'auth' }]);
    expect(db.calls[0]?.text).toContain('disabled_at IS NULL');
    expect(db.calls[0]?.text).toContain('expires_at IS NULL OR expires_at > NOW()');
    await persistence.unsubscribe('endpoint');
    expect(db.calls[1]?.values).toEqual(['endpoint-digest-1']);
    expect(db.calls[1]?.text).toContain('disabled_at = COALESCE(disabled_at, NOW())');
  });
});

describe('WebPushVapidTransport', () => {
  it('configures VAPID and serializes only the redacted push payload', async () => {
    const configured: string[][] = []; const sent: Array<{ subscription: unknown; payload: string }> = [];
    const client: WebPushClient = {
      setVapidDetails(...values) { configured.push(values); },
      async sendNotification(subscription, payload) { sent.push({ subscription, payload }); return { statusCode: 201 }; },
    };
    const transport = new WebPushVapidTransport({ subject: 'mailto:push@example.test', publicKey: 'public', privateKey: 'private' }, client);
    await expect(transport.send({ id: 's1', endpoint: 'https://endpoint', p256dh: 'p256dh', auth: 'auth' }, { notificationId: 'n1', activityId: 'a1', senderLabel: 'Alice', subject: 'Subject', statusLabel: 'waiting', ...{ body: 'must-not-send' } })).resolves.toEqual({ ok: true, statusCode: 201 });
    expect(configured).toEqual([['mailto:push@example.test', 'public', 'private']]);
    expect(JSON.parse(sent[0]?.payload ?? '{}')).toEqual({ notificationId: 'n1', activityId: 'a1', senderLabel: 'Alice', subject: 'Subject', statusLabel: 'waiting' });
    expect(sent[0]?.payload).not.toContain('must-not-send');
  });

  it('preserves stale provider status for subscription cleanup', async () => {
    const client: WebPushClient = {
      setVapidDetails() { /* configured in constructor */ },
      async sendNotification() { throw Object.assign(new Error('gone'), { statusCode: 410, code: 'gone' }); },
    };
    const transport = new WebPushVapidTransport({ subject: 'mailto:push@example.test', publicKey: 'public', privateKey: 'private' }, client);
    await expect(transport.send({ id: 's1', endpoint: 'endpoint', p256dh: 'key', auth: 'auth' }, { notificationId: 'n1', activityId: 'a1', senderLabel: 'A', subject: 'S', statusLabel: 'new' })).resolves.toEqual({ ok: false, failure: { statusCode: 410, code: 'gone' } });
  });
});
