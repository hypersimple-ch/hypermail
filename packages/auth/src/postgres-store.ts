import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import type { AuthStore, Session, User } from './index.js';
import type { RecoveryPayloadCodec } from './recovery-delivery.js';

type UserRow = { id: string; email: string; password_hash: string };
type SessionRow = { id: string; user_id: string; token_hash: string; expires_at: Date; created_at: Date; revoked_at: Date | null };
type RateLimitRow = { count: number; window_started_at: Date; blocked_until: Date | null };

/** PostgreSQL implementation for the pre-existing app auth tables; it never stores raw secrets. */
export function createPostgresAuthStore(sql: Sql, codec: RecoveryPayloadCodec): AuthStore {
  return {
    async countUsers() { const rows = await sql<{ count: string }[]>`select count(*) from app.users`; return Number(rows[0]?.count ?? 0); },
    async createFirstUser(email, passwordHash) {
      return sql.begin(async (tx) => {
        // A transaction-scoped advisory lock makes the one-user bootstrap invariant global.
        await tx`select pg_advisory_xact_lock(743091)`;
        const rows = await tx<UserRow[]>`insert into app.users (email, password_hash) select ${email}, ${passwordHash} where not exists (select 1 from app.users) returning id, email, password_hash`;
        const row = rows[0];
        if (!row) return null;
        // The existing local deployment explicitly uses embedded Mastra. Hosted
        // onboarding can replace this choice before attaching its first Mailbox.
        await tx`insert into app.user_agent_preferences (user_id, default_manager_kind, revision) values (${row.id}, 'mastra', 1)`;
        return user(row);
      });
    },
    async findUserByEmail(email) { const rows = await sql<UserRow[]>`select id, email, password_hash from app.users where email = ${email}`; return rows[0] ? user(rows[0]) : null; },
    async findUserById(id) { const rows = await sql<UserRow[]>`select id, email, password_hash from app.users where id = ${id}`; return rows[0] ? user(rows[0]) : null; },
    async createSession(input) {
      return sql.begin(async (tx) => {
        const owners = await tx<{ password_hash: string }[]>`select password_hash from app.users where id=${input.userId} for update`;
        if (owners[0]?.password_hash !== input.expectedPasswordHash) return null;
        const rows = await tx<SessionRow[]>`insert into app.sessions (user_id, token_hash, expires_at) values (${input.userId}, ${input.tokenHash}, ${input.expiresAt}) returning id, user_id, token_hash, expires_at, created_at, revoked_at`;
        return rows[0] ? session(rows[0]) : null;
      });
    },
    async findSessionByTokenHash(tokenHash) { const rows = await sql<SessionRow[]>`select id, user_id, token_hash, expires_at, created_at, revoked_at from app.sessions where token_hash = ${tokenHash}`; return rows[0] ? session(rows[0]) : null; },
    async revokeSession(id) { await sql`update app.sessions set revoked_at = now() where id = ${id} and revoked_at is null`; },
    async issueRecovery(input) {
      const encrypted = await codec.encrypt(input.resetUrl);
      const messageId = `<${randomUUID()}@hypermail-recovery.invalid>`;
      await sql.begin(async (tx) => {
        const rows = await tx<{ id: string; email: string }[]>`select id,email from app.users where id=${input.userId} for update`;
        const owner = rows[0]; if (!owner) return;
        const tokens = await tx<{ id: string }[]>`insert into app.recovery_tokens(user_id,token_hash,expires_at) values(${owner.id},${input.tokenHash},${input.expiresAt}) returning id`;
        const recoveryId = tokens[0]?.id; if (!recoveryId) throw new Error('Recovery issuance failed');
        await tx`insert into app.recovery_mail_deliveries(owner_id,recovery_id,recipient,encrypted_payload,nonce,provider_message_id,expires_at) values(${owner.id},${recoveryId},${owner.email},${encrypted},${encrypted.split('.')[1] ?? ''},${messageId},${input.expiresAt})`;
        await tx`insert into app.recovery_mail_identifiers(recovery_id,owner_id,token_hash,provider_message_id,canonical_origin) values(${recoveryId},${owner.id},${input.tokenHash},${messageId},${new URL(input.resetUrl).origin})`;
      });
    },
    async resetRecovery(tokenHash, passwordHash, now) {
      return sql.begin(async (tx) => {
        const candidates = await tx<{ user_id: string }[]>`select user_id from app.recovery_tokens where token_hash=${tokenHash}`;
        const owner = candidates[0]?.user_id; if (!owner) return null;
        await tx`select id from app.users where id=${owner} for update`;
        const rows = await tx<{ user_id: string }[]>`update app.recovery_tokens set consumed_at=${now} where token_hash=${tokenHash} and consumed_at is null and expires_at>${now} returning user_id`;
        if (!rows[0]) return null;
        await tx`update app.users set password_hash=${passwordHash},updated_at=${now} where id=${owner}`;
        await tx`update app.sessions set revoked_at=${now} where user_id=${owner} and revoked_at is null`;
        await tx`update app.send_approvals set state='expired' where user_id=${owner} and state='pending'`;
        await tx`update app.recovery_tokens set consumed_at=${now} where user_id=${owner} and consumed_at is null`;
        return owner;
      });
    },
    async rotatePassword(input) {
      return sql.begin(async (tx) => {
        // Recovery and session issuance use the same owner-first lock order.
        const owners = await tx<{ password_hash: string }[]>`select password_hash from app.users where id=${input.userId} for update`;
        if (owners[0]?.password_hash !== input.expectedPasswordHash) return false;
        await tx`select id from app.sessions where id=${input.sessionId} and user_id=${input.userId} for update`;
        // Check wall-clock expiry after lock waits, not at transaction start.
        const changed = await tx<{ id: string }[]>`update app.users set password_hash=${input.passwordHash},updated_at=clock_timestamp()
          where id=${input.userId} and password_hash=${input.expectedPasswordHash}
          and exists (select 1 from app.sessions where id=${input.sessionId} and user_id=${input.userId} and revoked_at is null and expires_at>clock_timestamp())
          returning id`;
        if (!changed[0]) return false;
        await tx`update app.sessions set revoked_at=clock_timestamp() where user_id=${input.userId} and revoked_at is null`;
        return true;
      });
    },
    async takeRateLimit({ bucket, subjectHash, limit, windowMs, now }) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${bucket}:${subjectHash}`},0))`;
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
