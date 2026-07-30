import type { Sql } from 'postgres';
import type { AuthStore, RecoveryToken, Session, User } from './index.js';

type UserRow = { id: string; email: string; password_hash: string };
type SessionRow = { id: string; user_id: string; token_hash: string; expires_at: Date; created_at: Date; revoked_at: Date | null };
type RecoveryRow = { id: string; user_id: string; token_hash: string; expires_at: Date; consumed_at: Date | null };
type RateLimitRow = { count: number; window_started_at: Date; blocked_until: Date | null };

/** PostgreSQL implementation for the pre-existing app auth tables; it never stores raw secrets. */
export function createPostgresAuthStore(sql: Sql): AuthStore {
  return {
    async countUsers() { const rows = await sql<{ count: string }[]>`select count(*) from app.users`; return Number(rows[0]?.count ?? 0); },
    async createFirstUser(email, passwordHash) {
      return sql.begin(async (tx) => {
        // A transaction-scoped advisory lock makes the one-user bootstrap invariant global.
        await tx`select pg_advisory_xact_lock(743091)`;
        const rows = await tx<UserRow[]>`insert into app.users (email, password_hash) select ${email}, ${passwordHash} where not exists (select 1 from app.users) returning id, email, password_hash`;
        return rows[0] ? user(rows[0]) : null;
      });
    },
    async findUserByEmail(email) { const rows = await sql<UserRow[]>`select id, email, password_hash from app.users where email = ${email}`; return rows[0] ? user(rows[0]) : null; },
    async findUserById(id) { const rows = await sql<UserRow[]>`select id, email, password_hash from app.users where id = ${id}`; return rows[0] ? user(rows[0]) : null; },
    async createSession(input) { const rows = await sql<SessionRow[]>`insert into app.sessions (user_id, token_hash, expires_at) values (${input.userId}, ${input.tokenHash}, ${input.expiresAt}) returning id, user_id, token_hash, expires_at, created_at, revoked_at`; const row = rows[0]; if (!row) throw new Error('Session creation did not return a row'); return session(row); },
    async findSessionByTokenHash(tokenHash) { const rows = await sql<SessionRow[]>`select id, user_id, token_hash, expires_at, created_at, revoked_at from app.sessions where token_hash = ${tokenHash}`; return rows[0] ? session(rows[0]) : null; },
    async revokeSession(id) { await sql`update app.sessions set revoked_at = now() where id = ${id} and revoked_at is null`; },
    async revokeSessionsForUser(userId) { await sql`update app.sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`; },
    async createRecoveryToken(input) { const rows = await sql<RecoveryRow[]>`insert into app.recovery_tokens (user_id, token_hash, expires_at) values (${input.userId}, ${input.tokenHash}, ${input.expiresAt}) returning id, user_id, token_hash, expires_at, consumed_at`; const row = rows[0]; if (!row) throw new Error('Recovery token creation did not return a row'); return recovery(row); },
    async consumeRecoveryToken(tokenHash, now) { const rows = await sql<RecoveryRow[]>`update app.recovery_tokens set consumed_at = ${now} where token_hash = ${tokenHash} and consumed_at is null and expires_at > ${now} returning id, user_id, token_hash, expires_at, consumed_at`; return rows[0] ? recovery(rows[0]) : null; },
    async updatePassword(userId, passwordHash) { await sql`update app.users set password_hash = ${passwordHash}, updated_at = now() where id = ${userId}`; },
    async takeRateLimit({ bucket, subjectHash, limit, windowMs, now }) {
      return sql.begin(async (tx) => {
        const rows = await tx<RateLimitRow[]>`select count, window_started_at, blocked_until from app.rate_limits where bucket = ${bucket} and subject_hash = ${subjectHash} for update`;
        const current = rows[0];
        if (!current) { await tx`insert into app.rate_limits (bucket, subject_hash, count, window_started_at, updated_at) values (${bucket}, ${subjectHash}, 1, ${now}, ${now})`; return true; }
        if (current.blocked_until && current.blocked_until > now) return false;
        if (now.getTime() - current.window_started_at.getTime() >= windowMs) { await tx`update app.rate_limits set count = 1, window_started_at = ${now}, blocked_until = null, updated_at = ${now} where bucket = ${bucket} and subject_hash = ${subjectHash}`; return true; }
        const count = current.count + 1;
        const allowed = count <= limit;
        await tx`update app.rate_limits set count = ${count}, blocked_until = ${allowed ? null : new Date(now.getTime() + windowMs)}, updated_at = ${now} where bucket = ${bucket} and subject_hash = ${subjectHash}`;
        return allowed;
      });
    },
    async audit(event) { await sql`insert into app.audits (actor_type, actor_id, event, correlation_id, metadata) values (${event.actorType}, ${event.actorId}, ${event.event}, ${event.correlationId}, ${JSON.stringify(event.metadata)}::jsonb)`; },
  };
}
function user(row: UserRow): User { return { id: row.id, email: row.email, passwordHash: row.password_hash }; }
function session(row: SessionRow): Session { return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at, createdAt: row.created_at, revokedAt: row.revoked_at }; }
function recovery(row: RecoveryRow): RecoveryToken { return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at, consumedAt: row.consumed_at }; }
