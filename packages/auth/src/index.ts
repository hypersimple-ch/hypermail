import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export { createPostgresAuthStore } from './postgres-store.js';
export { createBetterAuth, createBetterAuthHandler, createBetterAuthOptions, type BetterAuthFactoryOptions } from './better-auth.js';

const scrypt = (password: string, salt: Buffer, keyLength: number): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, keyLength, SCRYPT_PARAMS, (error, derivedKey) => {
    if (error) reject(error); else resolve(derivedKey);
  });
});
const SESSION_COOKIE = '__Host-hypermail_session';
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 7;
const RECOVERY_LIFETIME_MS = 1000 * 60 * 15;
const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type User = Readonly<{ id: string; email: string; passwordHash: string }>;
export type Session = Readonly<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; revokedAt: Date | null }>;
export type RecoveryToken = Readonly<{ id: string; userId: string; tokenHash: string; expiresAt: Date; consumedAt: Date | null }>;
export type AuditEvent = Readonly<{ event: string; actorType: 'user' | 'system'; actorId: string | null; correlationId: string; metadata: Readonly<Record<string, unknown>> }>;

/** Persistence is deliberately a narrow port over app.users, sessions, recovery_tokens, rate_limits, and audits. */
export interface AuthStore {
  countUsers(): Promise<number>;
  createFirstUser(email: string, passwordHash: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createSession(input: Omit<Session, 'id' | 'createdAt' | 'revokedAt'>): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  revokeSession(id: string): Promise<void>;
  revokeSessionsForUser(userId: string): Promise<void>;
  createRecoveryToken(input: Omit<RecoveryToken, 'id' | 'consumedAt'>): Promise<RecoveryToken>;
  consumeRecoveryToken(tokenHash: string, now: Date): Promise<RecoveryToken | null>;
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  /** Atomically increments a bucket and returns whether the request may proceed. */
  takeRateLimit(input: Readonly<{ bucket: string; subjectHash: string; limit: number; windowMs: number; now: Date }>): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
}

export interface RecoveryMailAdapter {
  deliver(message: Readonly<{
    to: string;
    resetUrl: string;
    tags: readonly ['recovery', 'exclude-autonomous-ingestion'];
    autonomousIngestionExcluded: true;
  }>): Promise<void>;
}

export type AuthResult =
  | Readonly<{ ok: true; session: Session; token: string }>
  | Readonly<{ ok: false; reason: 'invalid_credentials' | 'throttled' | 'bootstrap_locked' | 'invalid_recovery' }>;

export type AuthServiceOptions = Readonly<{
  store: AuthStore;
  mail: RecoveryMailAdapter;
  appOrigin: string;
  now?: () => Date;
  ids?: () => string;
  tokens?: () => string;
}>;

/**
 * Credentials and session orchestration for the existing application schema.
 * Better Auth's current Drizzle adapter requires user/account/verification tables, which are
 * intentionally not present here; this service owns the existing credential/session tables
 * while preserving Better Auth-compatible browser security defaults at the route boundary.
 */
export class AuthService {
  private readonly now: () => Date;
  private readonly ids: () => string;
  private readonly tokens: () => string;

  public constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ids = options.ids ?? (() => randomBytes(16).toString('hex'));
    this.tokens = options.tokens ?? (() => randomBytes(32).toString('base64url'));
  }

  public async bootstrap(email: string, password: string, correlationId: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    if (!validPassword(password)) return { ok: false, reason: 'invalid_credentials' };
    const user = await this.options.store.createFirstUser(normalized, await hashPassword(password));
    if (!user) {
      await this.audit('auth.bootstrap_locked', null, correlationId);
      return { ok: false, reason: 'bootstrap_locked' };
    }
    await this.audit('auth.bootstrap_completed', user.id, correlationId);
    return this.newSession(user, correlationId);
  }

  public async signIn(email: string, password: string, subject: string, correlationId: string): Promise<AuthResult> {
    const now = this.now();
    if (!await this.options.store.takeRateLimit({ bucket: 'login', subjectHash: digest(subject), limit: 5, windowMs: 15 * 60_000, now })) {
      await this.audit('auth.login_throttled', null, correlationId);
      return { ok: false, reason: 'throttled' };
    }
    const user = await this.options.store.findUserByEmail(normalizeEmail(email));
    if (!user || !await verifyPassword(password, user.passwordHash)) {
      await this.audit('auth.login_failed', user?.id ?? null, correlationId);
      return { ok: false, reason: 'invalid_credentials' };
    }
    await this.audit('auth.login_succeeded', user.id, correlationId);
    return this.newSession(user, correlationId);
  }

  public async getSession(token: string): Promise<Session | null> {
    const session = await this.options.store.findSessionByTokenHash(digest(token));
    if (!session || session.revokedAt || session.expiresAt <= this.now()) return null;
    return session;
  }

  public async signOut(token: string, correlationId: string): Promise<void> {
    const session = await this.getSession(token);
    if (!session) return;
    await this.options.store.revokeSession(session.id);
    await this.audit('auth.session_revoked', session.userId, correlationId);
  }

  /** Always returns successfully so account existence is not disclosed. */
  public async requestRecovery(email: string, subject: string, correlationId: string): Promise<void> {
    const now = this.now();
    if (!await this.options.store.takeRateLimit({ bucket: 'recovery', subjectHash: digest(subject), limit: 3, windowMs: 60 * 60_000, now })) {
      await this.audit('auth.recovery_throttled', null, correlationId);
      return;
    }
    const user = await this.options.store.findUserByEmail(normalizeEmail(email));
    if (!user) {
      await this.audit('auth.recovery_requested', null, correlationId);
      return;
    }
    const token = this.tokens();
    await this.options.store.createRecoveryToken({ userId: user.id, tokenHash: digest(token), expiresAt: new Date(now.getTime() + RECOVERY_LIFETIME_MS) });
    await this.options.mail.deliver({
      to: user.email,
      resetUrl: new URL(`/auth/recovery/confirm?token=${encodeURIComponent(token)}`, this.options.appOrigin).toString(),
      tags: ['recovery', 'exclude-autonomous-ingestion'],
      autonomousIngestionExcluded: true,
    });
    await this.audit('auth.recovery_requested', user.id, correlationId);
  }

  public async resetPassword(token: string, password: string, correlationId: string): Promise<AuthResult> {
    if (!validPassword(password)) return { ok: false, reason: 'invalid_recovery' };
    const recovery = await this.options.store.consumeRecoveryToken(digest(token), this.now());
    if (!recovery) {
      await this.audit('auth.recovery_failed', null, correlationId);
      return { ok: false, reason: 'invalid_recovery' };
    }
    await this.options.store.updatePassword(recovery.userId, await hashPassword(password));
    await this.options.store.revokeSessionsForUser(recovery.userId);
    await this.audit('auth.recovery_completed', recovery.userId, correlationId);
    const user = await this.options.store.findUserById(recovery.userId);
    return user ? this.newSession(user, correlationId) : { ok: false, reason: 'invalid_recovery' };
  }

  private async newSession(user: User, correlationId: string): Promise<AuthResult> {
    const token = this.tokens();
    const now = this.now();
    const session = await this.options.store.createSession({ userId: user.id, tokenHash: digest(token), expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS) });
    await this.audit('auth.session_created', user.id, correlationId);
    return { ok: true, session, token };
  }

  private audit(event: string, actorId: string | null, correlationId: string): Promise<void> {
    return this.options.store.audit({ event, actorType: actorId ? 'user' : 'system', actorId, correlationId, metadata: {} });
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${String(SESSION_LIFETIME_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}
export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
export function readSessionToken(cookieHeader: string | null): string | null {
  const value = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}
/** Require an exact configured HTTPS origin for every state-changing browser request. */
export function isTrustedMutationOrigin(origin: string | null, appOrigin: string): boolean {
  return origin === appOrigin && new URL(appOrigin).protocol === 'https:';
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  try {
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), PASSWORD_KEY_LENGTH);
    const expected = Buffer.from(hashValue, 'base64url');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1024; }
