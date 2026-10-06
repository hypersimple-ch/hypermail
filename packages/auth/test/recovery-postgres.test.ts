import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it } from 'vitest';
import { withPostgresSchemas } from '../../../apps/worker/test/postgres-test.js';
import { PushSubscriptionAesCodec } from '../../notifications/src/crypto-codec.js';
import { AuthService, createPostgresAuthStore, RecoveryDeliveryScheduler, RecoveryMailIdentity, SmtpRecoveryDelivery } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
describe.skipIf(!databaseUrl)('recovery durable SMTP and single-use SQL', { timeout: 30_000 }, () => {
  it('rotates credentials atomically, revokes every old session and issues a usable replacement', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async sql => {
      const store = createPostgresAuthStore(sql, new PushSubscriptionAesCodec('test-encryption-domain-key-at-least-32-characters'));
      const auth = new AuthService({ store, appOrigin: 'https://mail.example.test' });
      const first = await auth.bootstrap('owner@example.test', 'correct horse battery staple', randomUUID());
      const second = await auth.signIn('owner@example.test', 'correct horse battery staple', 'second', randomUUID());
      if (!first.ok || !second.ok) throw new Error('Missing fixture sessions');
      const rotation = await auth.rotatePassword(first.token, 'correct horse battery staple', 'rotated correct horse battery staple', 'rotation', randomUUID());
      expect(rotation.ok).toBe(true); if (!rotation.ok) throw new Error('Rotation failed');
      expect(await auth.getSession(first.token)).toBeNull();
      expect(await auth.getSession(second.token)).toBeNull();
      expect(await auth.getSession(rotation.token)).toEqual(rotation.session);
      expect((await auth.signIn('owner@example.test', 'correct horse battery staple', 'old', randomUUID())).ok).toBe(false);
      expect((await auth.signIn('owner@example.test', 'rotated correct horse battery staple', 'new', randomUUID())).ok).toBe(true);
    });
  });

  it.each(['recovery', 'revoked', 'expired', 'changed_hash'] as const)('rejects a verified rotation when %s wins before its credential transaction', async winner => {
    await withPostgresSchemas(databaseUrl ?? '', async sql => {
      const store = createPostgresAuthStore(sql, new PushSubscriptionAesCodec('test-encryption-domain-key-at-least-32-characters'));
      const ready = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      // Pause after verification and hashing, before the real SQL credential write.
      const auth = new AuthService({ store: { ...store, async rotatePassword(input) { ready.resolve(undefined); await release.promise; return store.rotatePassword(input); } }, appOrigin: 'https://mail.example.test' });
      const first = await auth.bootstrap('owner@example.test', 'correct horse battery staple', randomUUID());
      if (!first.ok) throw new Error('Missing fixture session');
      const pending = auth.rotatePassword(first.token, 'correct horse battery staple', 'stale rotation password chosen here', 'rotation', randomUUID());
      await ready.promise;
      try {
        if (winner === 'recovery') {
          const token = 'deterministic-recovery-token';
          await store.issueRecovery({ userId: first.session.userId, tokenHash: createHash('sha256').update(token).digest('base64url'), expiresAt: new Date(Date.now() + 900000), resetUrl: `https://mail.example.test/auth/recovery/confirm#token=${token}` });
          expect(await auth.resetPassword(token, 'recovery winner password chosen here', randomUUID())).toEqual({ ok: true });
        } else if (winner === 'revoked') {
          await store.revokeSession(first.session.id);
        } else if (winner === 'expired') {
          await sql`update app.sessions set expires_at=clock_timestamp()-interval '1 second' where id=${first.session.id}`;
        } else {
          // Keep the initiating session live to isolate the verified-hash fence.
          await sql`update app.users set password_hash='changed-by-another-credential-operation' where id=${first.session.userId}`;
        }
        const winningHash = (await store.findUserById(first.session.userId))?.passwordHash;
        release.resolve(undefined);
        expect(await pending).toEqual({ ok: false, reason: 'invalid_credentials' });
        expect((await store.findUserById(first.session.userId))?.passwordHash).toBe(winningHash);
        expect(await sql`select id from app.sessions where user_id=${first.session.userId}`).toHaveLength(1);
        expect((await auth.signIn('owner@example.test', 'stale rotation password chosen here', 'stale', randomUUID())).ok).toBe(false);
        if (winner === 'recovery') expect((await auth.signIn('owner@example.test', 'recovery winner password chosen here', 'winner', randomUUID())).ok).toBe(true);
        expect(await sql`select id from app.audits where event='auth.password_rotation_completed'`).toEqual([]);
      } finally {
        release.resolve(undefined);
        await pending;
      }
    });
  });

  it('delivers the owner link, purges ciphertext, retains identification and consumes reset once concurrently', async () => {
    const probe = createServer(); const ready = Promise.withResolvers<undefined>(); probe.listen(0, '127.0.0.1', () => { ready.resolve(undefined); }); await ready.promise;
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('Missing port'); const port = address.port;
    const closed = Promise.withResolvers<undefined>(); probe.close(() => { closed.resolve(undefined); }); await closed.promise;
    const received: string[] = [];
    const server = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _session, callback) { let message = ''; stream.on('data', chunk => { message += String(chunk); }); stream.on('end', () => { received.push(message); callback(); }); } });
    const listening = Promise.withResolvers<undefined>(); server.listen(port, '127.0.0.1', () => { listening.resolve(undefined); }); await listening.promise;
    try {
      await withPostgresSchemas(databaseUrl ?? '', async sql => {
        const codec = new PushSubscriptionAesCodec('test-encryption-domain-key-at-least-32-characters');
        const store = createPostgresAuthStore(sql, codec);
        const auth = new AuthService({ store, appOrigin: 'https://mail.example.test', recoveryResponseFloorMs: 0 });
        const bootstrap = await auth.bootstrap('owner@example.test', 'correct horse battery staple', randomUUID()); expect(bootstrap.ok).toBe(true); if (!bootstrap.ok) throw new Error('Bootstrap failed');
        await auth.requestRecovery('missing@example.test', 'missing', randomUUID());
        const previousPasswordHash = (await store.findUserById(bootstrap.session.userId))?.passwordHash ?? '';
        expect(await sql`select id from app.recovery_mail_deliveries`).toEqual([]);
        await auth.requestRecovery(' OWNER@example.test ', 'known', randomUUID());
        const before = (await sql`select encrypted_payload from app.recovery_mail_deliveries`)[0]; expect(before?.['encrypted_payload']).not.toContain('#token=');
        const smtp = new SmtpRecoveryDelivery({ host: '127.0.0.1', port, secure: false, from: 'recovery@example.test', localDevelopment: true });
        const scheduler = new RecoveryDeliveryScheduler(sql, codec, smtp); await scheduler.recover(); await scheduler.recover(); await scheduler.stop();
        expect(received).toHaveLength(1); const mail = (received[0] ?? '').replaceAll('=\r\n', '').replaceAll('=3D', '='); expect(mail).toContain('To: owner@example.test');
        const row = (await sql`select state,encrypted_payload,provider_message_id from app.recovery_mail_deliveries`)[0]; expect(row?.['state']).toBe('delivered'); expect(row?.['encrypted_payload']).toBeNull();
        const encoded = mail.match(/https:\/\/mail\.example\.test\/auth\/recovery\/confirm#token=([A-Za-z0-9_-]+)/)?.[1]; if (!encoded) throw new Error('Missing reset link');
        const identity = new RecoveryMailIdentity(sql);
        expect(await identity.isRecoveryMail({ userId: bootstrap.session.userId, internetMessageId: String(row?.['provider_message_id']), body: '' })).toBe(true);
        expect(await identity.isRecoveryMail({ userId: bootstrap.session.userId, body: `https://mail.example.test/auth/recovery/confirm#token=${encoded}` })).toBe(true);
        expect(await identity.isRecoveryMail({ userId: bootstrap.session.userId, body: `https://evil.example.test/auth/recovery/confirm#token=${encoded}` })).toBe(false);
        const resets = await Promise.all([auth.resetPassword(encoded, 'new correct horse battery staple', randomUUID()), auth.resetPassword(encoded, 'another correct horse battery staple', randomUUID())]); expect(resets.filter(value => value.ok)).toHaveLength(1); expect(await auth.getSession(bootstrap.token)).toBeNull();
        expect(await store.createSession({ userId: bootstrap.session.userId, tokenHash: 'stale-login', expiresAt: new Date(Date.now() + 60000), expectedPasswordHash: previousPasswordHash })).toBeNull();
        expect(await identity.isRecoveryMail({ userId: bootstrap.session.userId, body: `https://mail.example.test/auth/recovery/confirm#token=${encoded}` })).toBe(true);
        expect(await new RecoveryMailIdentity(sql, 'https://another.example.test').isRecoveryMail({ userId: bootstrap.session.userId, body: `https://mail.example.test/auth/recovery/confirm#token=${encoded}` })).toBe(false);
      });
    } finally { const ended = Promise.withResolvers<undefined>(); server.close(() => { ended.resolve(undefined); }); await ended.promise; }
  });
  it('purges an exhausted expired final claim without a fourth SMTP attempt', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async sql => {
      const codec = new PushSubscriptionAesCodec('test-encryption-domain-key-at-least-32-characters'); const store = createPostgresAuthStore(sql, codec);
      const owner = await store.createFirstUser('owner@example.test', 'unused-hash'); if (!owner) throw new Error('Missing owner');
      await store.issueRecovery({ userId: owner.id, tokenHash: createHash('sha256').update('test').digest('hex'), expiresAt: new Date(Date.now() + 900000), resetUrl: 'https://mail.example.test/auth/recovery/confirm#token=test' });
      // Fixture simulates a crashed process after its final durable claim.
      await sql`alter table app.recovery_mail_deliveries disable trigger recovery_mail_delivery_guard`;
      await sql`update app.recovery_mail_deliveries set state='processing',attempt=3,claim_token=${randomUUID()},claim_expires_at=now()-interval '1 second'`;
      await sql`alter table app.recovery_mail_deliveries enable trigger recovery_mail_delivery_guard`;
      const smtp = new SmtpRecoveryDelivery({ host: '127.0.0.1', port: 1, secure: false, from: 'recovery@example.test', localDevelopment: true }); const scheduler = new RecoveryDeliveryScheduler(sql, codec, smtp); await scheduler.recover(); await scheduler.stop();
      const row = (await sql`select state,attempt,encrypted_payload from app.recovery_mail_deliveries`)[0]; expect(row?.['state']).toBe('failed'); expect(row?.['attempt']).toBe(3); expect(row?.['encrypted_payload']).toBeNull();
    });
  });
  it('retries the same durable token and terminates after three SMTP failures', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async sql => {
      const codec = new PushSubscriptionAesCodec('test-encryption-domain-key-at-least-32-characters');
      const store = createPostgresAuthStore(sql, codec);
      const owner = await store.createFirstUser('owner@example.test', 'unused-hash'); if (!owner) throw new Error('Missing owner');
      await store.issueRecovery({ userId: owner.id, tokenHash: createHash('sha256').update('retry-test').digest('hex'), expiresAt: new Date(Date.now() + 900000), resetUrl: 'https://mail.example.test/auth/recovery/confirm#token=retry-test' });
      const smtp = new SmtpRecoveryDelivery({ host: '127.0.0.1', port: 1, secure: false, from: 'recovery@example.test', localDevelopment: true });
      const scheduler = new RecoveryDeliveryScheduler(sql, codec, smtp);
      for (let attempt = 0; attempt < 3; attempt++) {
        await scheduler.recover();
        // Advance only the fixture clock boundary; production retains its backoff.
        await sql`alter table app.recovery_mail_deliveries disable trigger recovery_mail_delivery_guard`;
        await sql`update app.recovery_mail_deliveries set next_attempt_at=now()`;
        await sql`alter table app.recovery_mail_deliveries enable trigger recovery_mail_delivery_guard`;
      }
      await scheduler.stop();
      const deliveries = await sql`select state,attempt,encrypted_payload from app.recovery_mail_deliveries`;
      expect(deliveries).toHaveLength(1); expect(deliveries[0]?.['state']).toBe('failed'); expect(deliveries[0]?.['attempt']).toBe(3); expect(deliveries[0]?.['encrypted_payload']).toBeNull();
      expect(await sql`select id from app.recovery_tokens`).toHaveLength(1);
    });
  });
});
