/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-type-conversion */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ManagedSqlClient } from '@hypermail/db';
import { DurableNotificationRecovery } from '../src/runtime.js';
import { DispatchRecovery, IngestionWorker, type DeliveryQueue, type MailProvider } from '../src/ingestion.js';
import { PostgresIngestionStore, type SqlClient } from '../src/postgres-store.js';
import { PostgresLifecycleStore } from '../src/lifecycle/postgres-store.js';
import { DurablePolicyRecovery, PgBossPolicyDispatcher } from '../src/policy.js';
import { PostgresNotificationDispatchStore, composeWorkerRuntime } from '../src/production.js';
import { parseWorkerEnvironment } from '../src/runtime.js';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
const now = new Date('2026-04-01T00:00:00.000Z');

const client = (sql: SqlClient): ManagedSqlClient => ({ ...sql, close: () => Promise.resolve() });
const environment = (port: number) => parseWorkerEnvironment({
  DATABASE_URL: databaseUrl, HYPERMAIL_URL: 'http://127.0.0.1:9/mcp', HYPERMAIL_KEY: 'a'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'test',
  MODEL_PROVIDER: 'openai', MODEL_NAME: 'test', MODEL_API_KEY: 'b'.repeat(16), VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), AGENT_GLOBAL_CONSTRAINTS: 'Never send mail.', HEALTH_PORT: port,
});

async function unusedPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function seedActivity(sql: { unsafe(query: string, values?: readonly unknown[]): Promise<readonly { id: string }[]> }, accountId: string, suffix: string) {
  const messageId = randomUUID(); const activityId = randomUUID(); const decisionId = randomUUID();
  await sql.unsafe(`insert into app.messages (id, account_id, provider_message_id, sender, recipients, received_at) values ($1, $2, $3, '{"address":"sender@example.test"}', '[]', $4)`, [messageId, accountId, `provider-${suffix}`, now]);
  await sql.unsafe(`insert into app.activities (id, account_id, message_id) values ($1, $2, $3)`, [activityId, accountId, messageId]);
  await sql.unsafe(`insert into app.decisions (id, activity_id, attempt, state, rationale, model_provider, model_name, input_digest, output) values ($1, $2, 1, 'actionable', 'test', 'test', 'test', 'digest', '{}')`, [decisionId, activityId]);
  return { messageId, activityId, decisionId };
}

describe('worker PostgreSQL runtime integration', () => {
  it.skipIf(!databaseUrl)('replays durable work, isolates provider faults, runs lifecycle, and shuts down not-ready safely', async () => {
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl, async sql => {
      const adapter: SqlClient = {
        query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) => ({ rows: await (values === undefined ? sql.unsafe(statement) : sql.unsafe(statement, values as never[])) as Row[] }),
        transaction: async <T>(work: (transaction: SqlClient) => Promise<T>) => sql.begin(async transaction => work({ query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) => ({ rows: await (values === undefined ? transaction.unsafe(statement) : transaction.unsafe(statement, values as never[])) as Row[] }), transaction: async <U>(nested: (client: SqlClient) => Promise<U>) => nested(adapter) })),
      };
      const database = client(adapter); const ingestion = new PostgresIngestionStore(adapter); const accountA = randomUUID(); const accountB = randomUUID(); const userId = randomUUID();
      await sql.unsafe(`insert into app.users (id, email, password_hash) values ($1, $2, 'test')`, [userId, `${userId}@example.test`]);
      await sql.begin(async transaction => {
        for (const [id, email] of [[accountA, 'a@example.test'], [accountB, 'b@example.test']] as const) {
          await transaction.unsafe(`insert into app.accounts (id, user_id, provider, provider_account_id, email, state, baseline_completed_at) values ($1, $5, 'gmail', $2, $3, 'ready', $4)`, [id, id, email, now, userId]);
          await transaction.unsafe(`insert into app.user_accounts (user_id, account_id) values ($1, $2)`, [userId, id]);
        }
      });

      const sent: string[] = [];
      const queue: DeliveryQueue = { send: async (_name, payload) => { sent.push(payload.jobId); return `queue:${payload.jobId}`; } };
      const provider: MailProvider = {
        establishBaseline: async () => undefined,
        recentInbox: async () => [],
        pollNewInbox: async account => account === 'a@example.test'
          ? [{ id: 'wrong-account', account: 'b@example.test' }]
          : [{ id: 'b-message', account: 'b@example.test', subject: 'B' }],
      };
      await new IngestionWorker(ingestion, provider, new DispatchRecovery(ingestion, queue), { now: () => now, sleep: async () => undefined }).runCycle();
      expect((await sql.unsafe(`select count(*)::int as count from app.messages where account_id = $1`, [accountA]))[0]?.count).toBe(0);
      expect((await sql.unsafe(`select state from app.account_health where account_id = $1`, [accountA]))[0]?.state).toBe('degraded');
      expect((await sql.unsafe(`select count(*)::int as count from app.messages where account_id = $1`, [accountB]))[0]?.count).toBe(1);
      expect(sent).toHaveLength(1);

      const replay = await ingestion.recordArrival({ accountId: accountA, message: { id: 'replay', account: 'a@example.test' }, observedAt: now });
      if (!replay) throw new Error('expected durable replay job');
      const planned = await seedActivity(sql, accountA, 'planned');
      await sql.unsafe(`insert into app.actions (activity_id, decision_id, kind, state, idempotency_key, target, precondition) values ($1, $2, 'mark_read', 'planned', $3, $4::jsonb, '{}'::jsonb)`, [planned.activityId, planned.decisionId, `planned-${randomUUID()}`, JSON.stringify({ accountId: accountA, messageId: planned.messageId })]);
      const replayed: string[] = [];
      await new DispatchRecovery(ingestion, { send: async (_name, payload) => { replayed.push(`agent:${payload.jobId}`); return 'replayed'; } }).dispatch();
      await new DurableNotificationRecovery(new PostgresNotificationDispatchStore(database), { dispatch: async id => { replayed.push(`notification:${id}`); } }).recover();
      await new DurablePolicyRecovery(database, new PgBossPolicyDispatcher({ send: async (_name, data) => { replayed.push(`policy:${String((data as { actionId: string }).actionId)}`); return 'replayed'; } })).recover();
      expect(replayed).toEqual(expect.arrayContaining([`agent:${replay.jobId}`]));
      expect(replayed.some(value => value.startsWith('notification:'))).toBe(true);
      expect(replayed.some(value => value.startsWith('policy:'))).toBe(true);

      await sql.unsafe(`insert into app.message_bodies (message_id, text_body, cached_at, purge_after) values ($1, 'private', $2, $2)`, [planned.messageId, new Date(now.valueOf() - 90 * 86_400_000)]);
      const subscriptionId = randomUUID();
      await sql.unsafe(`insert into app.push_subscriptions (id, user_id, endpoint_hash, endpoint_ciphertext, p256dh_ciphertext, auth_ciphertext, expires_at) values ($1, $2, $3, 'endpoint', 'key', 'auth', $4)`, [subscriptionId, userId, randomUUID(), now]);
      const lifecycle = new PostgresLifecycleStore(adapter);
      expect(await lifecycle.purgeCachedBodies(new Date(now.valueOf() - 90 * 86_400_000), now, 10)).toBe(1);
      expect(await lifecycle.disableExpiredPushSubscriptions(now, 10)).toBe(1);

      const port = await unusedPort(); let initializations = 0;
      const rawBoss = new (await import('pg-boss')).default({ connectionString: databaseUrl });
      const runtime = composeWorkerRuntime(environment(port), {
        createDatabase: () => database,
        createBoss: () => rawBoss as never,
        createHypermail: () => ({ initialize: async () => { initializations += 1; }, establishBaseline: async () => undefined, pollNewInbox: async () => [], inbox: async () => ({ messages: [] }), readMessage: async () => ({ body: '' }) }) as never,
        createTriageService: () => ({ triage: async () => ({ decision: { state: 'handled', rationale: 'test' } }) }) as never,
        createNotificationTransport: () => ({ send: async () => ({ ok: true }) }), holderId: () => 'postgres-runtime-test',
      });
      await runtime.start();
      expect((await fetch(`http://127.0.0.1:${String(port)}/live`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${String(port)}/ready`)).status).toBe(503);
      expect(runtime.dependencyState).toMatchObject({ database: true, queue: true, policy: false });
      expect(initializations).toBe(1);
      await runtime.shutdown();
      await expect(fetch(`http://127.0.0.1:${String(port)}/live`)).rejects.toThrow();
    });
  }, 60_000);
});
