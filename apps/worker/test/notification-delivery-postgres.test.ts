/* eslint-disable @typescript-eslint/require-await -- isolated provider fixtures */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPostgresClient } from '@hypermail/db';
import { NotificationWorker, PostgresNotificationPersistence } from '@hypermail/notifications';
import { PostgresNotificationDispatchStore } from '../src/notification-dispatch-store.js';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
describe('durable multi-device push', () => {
  it.skipIf(!databaseUrl)('freezes targets, fences expired workers, recovers crashes and preserves partial failure counts', async () => {
    if (!databaseUrl) throw new Error('DATABASE_URL required');
    await withPostgresSchemas(databaseUrl, async (sql) => {
      const database = createPostgresClient(databaseUrl);
      try {
        const userId = randomUUID(), accountId = randomUUID(), messageId = randomUUID(), activityId = randomUUID();
        await sql.unsafe("INSERT INTO app.users(id,email,password_hash) VALUES($1,$2,'test')", [userId, `${userId}@example.test`]);
        await sql.begin(async tx => {
          await tx.unsafe("INSERT INTO app.accounts(id,user_id,provider,provider_account_id,email,state) VALUES($1::uuid,$2::uuid,'gmail',$1::uuid::text,'test@example.test','ready')", [accountId, userId]);
          await tx.unsafe('INSERT INTO app.user_accounts(user_id,account_id) VALUES($1,$2)', [userId, accountId]);
        });
        await sql.unsafe(`INSERT INTO app.messages(id,account_id,provider_message_id,sender,recipients,received_at) VALUES($1,$2,'provider','{"address":"sender@example.test"}','[]',now())`, [messageId, accountId]);
        await sql.unsafe('INSERT INTO app.activities(id,account_id,message_id) VALUES($1,$2,$3)', [activityId, accountId, messageId]);
        const store = new PostgresNotificationPersistence(database, { encrypt: async (v) => v, decrypt: async (v) => v, hashEndpoint: async (v) => v });
        const a = await store.upsertSubscription({ userId, endpoint: 'https://push.example.test/a', p256dh: 'a', auth: 'a' });
        const b = await store.upsertSubscription({ userId, endpoint: 'https://push.example.test/b', p256dh: 'b', auth: 'b' });
        const input = { notificationId: randomUUID(), activityId, userId, senderLabel: 'Sender', subject: 'Subject', statusLabel: 'waiting' };
        const notification = await store.ensureLogicalNotification(input); const id = notification.notificationId;
        await Promise.all([store.initializeTargets(id, userId), store.initializeTargets(id, userId)]);
        const late = await store.upsertSubscription({ userId, endpoint: 'https://push.example.test/late', p256dh: 'late', auth: 'late' });
        await store.initializeTargets(id, userId);
        const claims = await Promise.all([store.claimDelivery(id, a, 3), store.claimDelivery(id, a, 3)]);
        const claim = claims.find((v) => v !== null); if (!claim) throw new Error('missing claim');
        expect(claims.filter((v) => v !== null)).toHaveLength(1);
        expect(await store.finishDelivery({ ...claim, claimToken: randomUUID() }, 'succeeded')).toBe(false);
        expect(await store.finishDelivery(claim, 'succeeded')).toBe(true);
        expect(await store.finishDelivery(claim, 'succeeded')).toBe(false);
        const expiredToken = randomUUID();
        await sql.unsafe(`INSERT INTO app.notification_deliveries(notification_id,subscription_id,attempt,state,claim_token,claim_expires_at)
          VALUES($1,$2,1,'pending',$3,now()+interval '1 millisecond')`, [id, b, expiredToken]);
        await sql.unsafe('SELECT pg_sleep(0.01)');
        const recovery = new PostgresNotificationDispatchStore(database);
        expect(await recovery.pendingNotificationIds(100)).toContain(id);
        const replacement = await store.claimDelivery(id, b, 3); if (!replacement) throw new Error('missing replacement');
        expect(replacement.attempt).toBe(2);
        expect(await store.finishDelivery({ notificationId: id, subscriptionId: b, attempt: 1, claimToken: expiredToken }, 'succeeded')).toBe(false);
        expect(await store.finalizeNotification(id)).toBe('delivering');
        expect(await recovery.pendingNotificationIds(100)).not.toContain(id);
        await store.finishDelivery(replacement, 'retryable');
        expect(await store.finalizeNotification(id)).toBe('pending');
        const calls: string[] = [];
        const worker = new NotificationWorker(store, { send: async (s) => { calls.push(s.id); return { ok: false, failure: { statusCode: 503 } }; } });
        await worker.deliver(input); await worker.deliver(input);
        expect(calls).toEqual([b]); expect(calls).not.toContain(a); expect(calls).not.toContain(late);
        expect(await store.ensureLogicalNotification(input)).toMatchObject({ state: 'failed', deliveredCount: 1, failedCount: 1, pendingCount: 0 });
        expect(await recovery.pendingNotificationIds(100)).not.toContain(id);
        const attempts = await sql.unsafe('SELECT attempt,state,error_code FROM app.notification_deliveries WHERE notification_id=$1 AND subscription_id=$2 ORDER BY attempt', [id, b]);
        expect(attempts).toEqual([expect.objectContaining({ attempt: 1, state: 'retryable', error_code: 'DELIVERY_LEASE_EXPIRED' }), expect.objectContaining({ attempt: 2, state: 'retryable' }), expect.objectContaining({ attempt: 3, state: 'permanent_failure' })]);
        await store.disableSubscription(b);
        expect(await store.finalizeNotification(id)).toBe('delivered');
        expect(await store.ensureLogicalNotification(input)).toMatchObject({ deliveredCount: 1, failedCount: 0, pendingCount: 0 });
      } finally { await database.close(); }
    });
  }, 60_000);
});
