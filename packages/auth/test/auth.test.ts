import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuthService, createBetterAuth, createBetterAuthOptions, expiredSessionCookie, readSessionToken, sessionCookie, type AuthStore, type RecoveryMailAdapter, type RecoveryToken, type Session, type User } from '../src/index.js';

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Expected fixture value.'); return value; }

class Store implements AuthStore {
  users: User[] = []; sessions: Session[] = []; recovery: RecoveryToken[] = []; audits: string[] = []; limits = new Map<string, number>();
  countUsers() { return Promise.resolve(this.users.length); }
  createFirstUser(email: string, passwordHash: string) { if (this.users.length) return Promise.resolve(null); const user = { id: 'user', email, passwordHash }; this.users.push(user); return Promise.resolve(user); }
  findUserByEmail(email: string) { return Promise.resolve(this.users.find((user) => user.email === email) ?? null); }
  findUserById(id: string) { return Promise.resolve(this.users.find((user) => user.id === id) ?? null); }
  createSession(input: Omit<Session, 'id' | 'revokedAt'>) { const value = { ...input, id: `s${String(this.sessions.length)}`, revokedAt: null }; this.sessions.push(value); return Promise.resolve(value); }
  findSessionByTokenHash(hash: string) { return Promise.resolve(this.sessions.find((session) => session.tokenHash === hash) ?? null); }
  revokeSession(id: string) { const session = this.sessions.find((value) => value.id === id); if (session) Object.assign(session, { revokedAt: new Date() }); return Promise.resolve(); }
  revokeSessionsForUser(userId: string) { for (const session of this.sessions.filter((value) => value.userId === userId)) Object.assign(session, { revokedAt: new Date() }); return Promise.resolve(); }
  createRecoveryToken(input: Omit<RecoveryToken, 'id' | 'consumedAt'>) { const value = { ...input, id: `r${String(this.recovery.length)}`, consumedAt: null }; this.recovery.push(value); return Promise.resolve(value); }
  consumeRecoveryToken(hash: string, now: Date) { const token = this.recovery.find((value) => value.tokenHash === hash && !value.consumedAt && value.expiresAt > now) ?? null; if (token) Object.assign(token, { consumedAt: now }); return Promise.resolve(token); }
  async updatePassword(id: string, passwordHash: string) { const user = await this.findUserById(id); if (user) Object.assign(user, { passwordHash }); }
  takeRateLimit({ bucket, subjectHash, limit }: { bucket: string; subjectHash: string; limit: number }) { const key = `${bucket}:${subjectHash}`; const count = this.limits.get(key) ?? 0; this.limits.set(key, count + 1); return Promise.resolve(count < limit); }
  audit(event: { event: string }) { this.audits.push(event.event); return Promise.resolve(); }
}

describe('Better Auth factory', () => {
  it('creates a PostgreSQL-backed handler with the required hardened options without connecting', async () => {
    const pool = new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused', connectionTimeoutMillis: 1 });
    const delivered: Parameters<RecoveryMailAdapter['deliver']>[0][] = [];
    const mail: RecoveryMailAdapter = { deliver: (message) => { delivered.push(message); return Promise.resolve(); } };
    try {
      const options = createBetterAuthOptions({
        pool,
        secret: 'a sufficiently long test secret that is never sent anywhere',
        baseURL: 'https://app.example.test',
        trustedOrigins: ['https://app.example.test', 'https://admin.example.test'],
        mail,
      });
      const auth = createBetterAuth({
        pool,
        secret: 'a sufficiently long test secret that is never sent anywhere',
        baseURL: 'https://app.example.test',
        mail,
      });

      expect(auth.handler).toBeTypeOf('function');
      expect(options.database).toBe(pool);
      expect(options.user.modelName).toBe('auth_users');
      expect(options.session.modelName).toBe('auth_sessions');
      expect(options.account.modelName).toBe('auth_accounts');
      expect(options.verification.modelName).toBe('auth_verifications');
      expect(options.emailAndPassword.disableSignUp).toBe(true);
      expect(options.emailAndPassword.resetPasswordTokenExpiresIn).toBe(15 * 60);
      expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
      expect(options.advanced.defaultCookieAttributes).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
      expect(options.trustedOrigins).toEqual(['https://app.example.test', 'https://admin.example.test']);
      await options.emailAndPassword.sendResetPassword({ user: { email: 'owner@example.test' }, url: 'https://app.example.test/reset?token=never-log-this' });
      expect(delivered).toEqual([expect.objectContaining({
        to: 'owner@example.test',
        tags: ['recovery', 'exclude-autonomous-ingestion'],
        autonomousIngestionExcluded: true,
      })]);
    } finally {
      await pool.end();
    }
  });

  it('rejects non-HTTPS Better Auth origins', () => {
    const pool = new Pool();
    const mail: RecoveryMailAdapter = { deliver: () => Promise.resolve() };
    try {
      expect(() => createBetterAuthOptions({ pool, secret: 'test secret', baseURL: 'http://app.example.test', mail })).toThrow(/HTTPS origin/);
    } finally {
      void pool.end();
    }
  });
});

describe('session cookies', () => {
  it('uses the secure host cookie and never reads the insecure local cookie by default', () => {
    expect(sessionCookie('secure token')).toBe('__Host-hypermail_session=secure%20token; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax');
    expect(expiredSessionCookie()).toBe('__Host-hypermail_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    expect(readSessionToken('hypermail_session=local-token; __Host-hypermail_session=secure-token')).toBe('secure-token');
    expect(readSessionToken('hypermail_session=local-token')).toBeNull();
  });

  it('uses and expires a separate insecure cookie only with explicit local-development options', () => {
    const options = { insecureLocalDevelopment: true };
    expect(sessionCookie('local token', options)).toBe('hypermail_session=local%20token; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax');
    expect(expiredSessionCookie(options)).toBe('hypermail_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(readSessionToken('__Host-hypermail_session=secure-token; hypermail_session=local-token', options)).toBe('local-token');
    expect(readSessionToken('hypermail_session=malformed%ZZ', options)).toBeNull();
  });
});

describe('AuthService', () => {
  it('reports bootstrap availability before and after a successful bootstrap', async () => {
    const store = new Store(); const service = createService(store);
    expect(await service.bootstrapAvailable()).toBe(true);
    await service.bootstrap('OWNER@example.com', 'correct horse battery staple', 'c1');
    expect(await service.bootstrapAvailable()).toBe(false);
  });

  it('locks bootstrap, hashes passwords, and issues a session', async () => {
    const store = new Store(); const service = createService(store);
    const first = await service.bootstrap('OWNER@example.com', 'correct horse battery staple', 'c1');
    expect(first.ok).toBe(true); expect(store.users[0]?.email).toBe('owner@example.com'); expect(store.users[0]?.passwordHash).not.toContain('correct horse');
    expect((await service.bootstrap('other@example.com', 'correct horse battery staple', 'c2')).reason).toBe('bootstrap_locked');
    expect((await service.signIn('owner@example.com', 'wrong password xx', 'ip', 'c3')).reason).toBe('invalid_credentials');
  });
  it('delivers a tagged recovery message once and revokes existing sessions when consumed', async () => {
    const store = new Store(); const delivered: string[] = []; const service = createService(store, delivered);
    await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c1');
    const oldSession = await service.signIn('owner@example.com', 'correct horse battery staple', 'ip', 'c2');
    await service.requestRecovery('owner@example.com', 'ip', 'c3');
    expect(delivered[0]).toMatch(/exclude-autonomous-ingestion/);
    const reset = await service.resetPassword('fixed-token', 'new correct horse battery staple', 'c4');
    expect(reset.ok).toBe(true); expect(oldSession.ok && await service.getSession(oldSession.token)).toBeNull();
    expect((await service.resetPassword('fixed-token', 'new correct horse battery staple', 'c5')).reason).toBe('invalid_recovery');
  });
  it('does not disclose an unknown recovery recipient and throttles login', async () => {
    const store = new Store(); const delivered: string[] = []; const service = createService(store, delivered);
    await service.requestRecovery('nobody@example.com', 'ip', 'c1'); expect(delivered).toEqual([]);
    await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c2');
    for (let index = 0; index < 5; index++) await service.signIn('owner@example.com', 'nope-nope-nope', 'ip', `c${String(index)}`);
    expect((await service.signIn('owner@example.com', 'nope-nope-nope', 'ip', 'late')).reason).toBe('throttled');
  });

  it('projects only an active session and safe account identity', async () => {
    const store = new Store(); const service = createService(store);
    const bootstrap = await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c1');
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(await service.getAuthenticatedSession(bootstrap.token)).toEqual({
      session: bootstrap.session,
      user: { id: 'user', email: 'owner@example.com' },
    });
    expect(await service.getAuthenticatedSession('unknown-token')).toBeNull();
    Object.assign(required(store.sessions[0]), { expiresAt: new Date('2024-12-31T23:59:59Z') });
    expect(await service.getAuthenticatedSession(bootstrap.token)).toBeNull();
  });

  it('rejects invalid, short, unchanged, and incorrect password rotations without changing credentials', async () => {
    const store = new Store(); const service = createService(store);
    const bootstrap = await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c1');
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    const originalHash = required(store.users[0]).passwordHash;
    expect(await service.rotatePassword('unknown-token', 'correct horse battery staple', 'new correct horse battery staple', 'ip-invalid', 'c2')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(await service.rotatePassword(bootstrap.token, 'correct horse battery staple', 'too short', 'ip-short', 'c3')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(await service.rotatePassword(bootstrap.token, 'correct horse battery staple', 'correct horse battery staple', 'ip-same', 'c4')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(await service.rotatePassword(bootstrap.token, 'wrong current password', 'new correct horse battery staple', 'ip-wrong', 'c5')).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(required(store.users[0]).passwordHash).toBe(originalHash);
    expect(await service.getSession(bootstrap.token)).toEqual(bootstrap.session);
    expect(store.audits.filter((event) => event === 'auth.password_rotation_failed')).toHaveLength(4);
  });

  it('replaces the hash and all prior sessions with one fresh session when rotating a password', async () => {
    const store = new Store(); const tokens = ['bootstrap-token', 'second-token', 'fresh-token', 'post-rotation-sign-in-token']; const service = createService(store, [], () => required(tokens.shift()));
    const bootstrap = await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c1');
    const second = await service.signIn('owner@example.com', 'correct horse battery staple', 'other-ip', 'c2');
    expect(bootstrap.ok && second.ok).toBe(true);
    if (!bootstrap.ok || !second.ok) return;
    const originalHash = required(store.users[0]).passwordHash;
    const rotation = await service.rotatePassword(bootstrap.token, 'correct horse battery staple', 'new correct horse battery staple', 'ip', 'c3');
    expect(rotation.ok).toBe(true);
    if (!rotation.ok) return;
    expect(rotation.token).toBe('fresh-token');
    expect(required(store.users[0]).passwordHash).not.toBe(originalHash);
    expect(store.sessions.filter((session) => !session.revokedAt)).toEqual([rotation.session]);
    expect(await service.getSession(bootstrap.token)).toBeNull();
    expect(await service.getSession(second.token)).toBeNull();
    expect(await service.getSession(rotation.token)).toEqual(rotation.session);
    expect((await service.signIn('owner@example.com', 'correct horse battery staple', 'old-password-ip', 'c4')).reason).toBe('invalid_credentials');
    expect((await service.signIn('owner@example.com', 'new correct horse battery staple', 'new-password-ip', 'c5')).ok).toBe(true);
    expect(store.audits).toContain('auth.password_rotation_completed');
  });

  it('throttles repeated password rotation failures and audits the throttle', async () => {
    const store = new Store(); const service = createService(store);
    const bootstrap = await service.bootstrap('owner@example.com', 'correct horse battery staple', 'c1');
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    for (let index = 0; index < 5; index++) {
      expect((await service.rotatePassword(bootstrap.token, 'wrong current password', 'new correct horse battery staple', 'ip', `c${String(index)}`)).reason).toBe('invalid_credentials');
    }
    expect((await service.rotatePassword(bootstrap.token, 'wrong current password', 'new correct horse battery staple', 'ip', 'late')).reason).toBe('throttled');
    expect(store.audits).toContain('auth.password_rotation_throttled');
  });
});
function createService(store: Store, delivered: string[] = [], tokens: () => string = () => 'fixed-token') {
  const mail: RecoveryMailAdapter = { deliver(message) { delivered.push(`${message.tags.join(',')}:${message.resetUrl}`); return Promise.resolve(); } };
  return new AuthService({ store, mail, appOrigin: 'https://app.example.test', now: () => new Date('2025-01-01T00:00:00Z'), tokens });
}
