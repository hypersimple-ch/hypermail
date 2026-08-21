/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-parameters */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { agentTaskSchema } from '@hypermail/contracts';
import { describe, expect, it } from 'vitest';
import { PostgresLifecycleStore } from '../../src/lifecycle/postgres-store.js';
import type { SqlClient } from '../../src/postgres-store.js';
import { withPostgresSchemas } from '../postgres-test.js';

class CapturingSql implements SqlClient {
  readonly statements: Array<{ statement: string; values: readonly unknown[] | undefined }> = [];
  async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
    this.statements.push({ statement, values });
    return { rows: [{ count: 1 }] as Row[] };
  }
  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return operation(this); }
}

describe('PostgreSQL lifecycle store', () => {
  it('uses an atomic, account-scoped cache-only purge with an audit row', async () => {
    const sql = new CapturingSql(); const store = new PostgresLifecycleStore(sql);
    const at = new Date('2026-04-01T00:00:00.000Z'); const cutoff = new Date('2026-01-01T00:00:00.000Z');
    await expect(store.purgeCachedBodies(cutoff, at, 100)).resolves.toBe(1);
    const query = sql.statements[0]?.statement ?? '';
    expect(query).toContain('DELETE FROM app.message_bodies');
    expect(query).toContain('JOIN app.messages m ON m.id = b.message_id');
    expect(query).toContain('b.cached_at <= $1 AND b.purge_after <= $2');
    expect(query).toContain('LIMIT $3');
    expect(query).toContain('FOR UPDATE OF b SKIP LOCKED');
    expect(query).toContain("'message_body_purged'");
    expect(query).not.toContain('DELETE FROM app.messages');
    expect(sql.statements[0]?.values).toEqual([cutoff, at, 100]);
  });

  it('disables, rather than deletes, expired subscriptions and audits the change', async () => {
    const sql = new CapturingSql(); const store = new PostgresLifecycleStore(sql);
    await store.disableExpiredPushSubscriptions(new Date('2026-04-01T00:00:00.000Z'), 10);
    const query = sql.statements[0]?.statement ?? '';
    expect(query).toContain('UPDATE app.push_subscriptions');
    expect(query).toContain('SET disabled_at = $1');
    expect(query).toContain("'push_subscription_expired'");
    expect(query).not.toContain('DELETE FROM app.push_subscriptions');
  });

  it('bounds and audits OAuth/session deletion and task/log minimization without payload metadata', async () => {
    const sql = new CapturingSql(); const store = new PostgresLifecycleStore(sql);
    const at = new Date('2026-04-01T00:00:00Z'); const cutoff = new Date('2026-03-01T00:00:00Z');
    await store.purgeExpiredOAuth(cutoff,at,7);
    await store.purgeExpiredSessions(cutoff,at,7);
    await store.minimizeTerminalTaskPayloads(cutoff,at,7);
    await store.purgeOperationalText(cutoff,at,7);
    expect(sql.statements).toHaveLength(4);
    for (const entry of sql.statements) {
      expect(entry.statement).toContain('LIMIT $3');
      expect(entry.statement).toContain('INSERT INTO app.audits');
      expect(entry.values).toEqual([cutoff,at,7]);
      expect(entry.statement).not.toMatch(/last_error\s*[,)]/);
    }
    expect(sql.statements[2]?.statement).toContain("SET result=jsonb_build_object('kind','redacted')");
    expect(sql.statements[2]?.statement).toContain('UPDATE app.agent_task_reports');
    expect(sql.statements[2]?.statement).toContain("#>> '{task,state}'='completed'");
    expect(sql.statements[3]?.statement).toContain('SET last_error=NULL');
  });

  it.skipIf(!process.env.DATABASE_URL)('purges only cache rows while PostgreSQL retains related history and foreign keys', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl, async sql => {
      const client = (connection: Sql): SqlClient => ({
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => ({ rows: await connection.unsafe(text, values as never[]) as Row[] }),
        transaction: async <T>(work: (transaction: SqlClient) => Promise<T>) => connection.begin((transaction) => work(client(transaction))),
      });
      const userId = randomUUID(); const accountId = randomUUID(); const messageId = randomUUID();
      const activityId = randomUUID(); const subscriptionId = randomUUID(); const at = new Date('2026-04-01T00:00:00.000Z');
      await sql.unsafe(`INSERT INTO app.users (id, email, password_hash) VALUES ($1, $2, 'test')`, [userId, `user-${userId}@example.test`]);
      await sql.begin(async transaction => {
        await transaction.unsafe(`INSERT INTO app.accounts (id, user_id, provider, provider_account_id, email) VALUES ($1, $4, 'gmail', $2, $3)`, [accountId, accountId, `account-${accountId}@example.test`, userId]);
        await transaction.unsafe(`INSERT INTO app.user_accounts (user_id, account_id) VALUES ($1, $2)`, [userId, accountId]);
      });
      await sql.unsafe(`INSERT INTO app.messages (id, account_id, provider_message_id, sender, recipients, received_at) VALUES ($1, $2, 'message', '{"address":"sender@example.test"}', '[]', $3)`, [messageId, accountId, at]);
      await sql.unsafe(`INSERT INTO app.activities (id, account_id, message_id) VALUES ($1, $2, $3)`, [activityId, accountId, messageId]);
      await sql.unsafe(`INSERT INTO app.logical_notifications (activity_id, sender_label, subject, status_label) VALUES ($1, 'Sender', 'Subject', 'New email')`, [activityId]);
      await sql.unsafe(`INSERT INTO app.message_bodies (message_id, text_body, cached_at, purge_after) VALUES ($1, 'private body', $2, $2)`, [messageId, new Date(at.valueOf() - 90 * 86_400_000)]);
      await sql.unsafe(`INSERT INTO app.push_subscriptions (id, user_id, endpoint_hash, endpoint_ciphertext, p256dh_ciphertext, auth_ciphertext, expires_at) VALUES ($1, $2, 'hash', 'endpoint', 'key', 'auth', $3)`, [subscriptionId, userId, at]);
      const store = new PostgresLifecycleStore(client(sql));
      expect(await store.purgeCachedBodies(new Date(at.valueOf() - 90 * 86_400_000), at, 10)).toBe(1);
      expect(await store.disableExpiredPushSubscriptions(at, 10)).toBe(1);
      expect((await sql.unsafe('SELECT count(*)::int AS count FROM app.message_bodies'))[0]?.count).toBe(0);
      expect((await sql.unsafe('SELECT count(*)::int AS count FROM app.messages'))[0]?.count).toBe(1);
      expect((await sql.unsafe('SELECT count(*)::int AS count FROM app.activities'))[0]?.count).toBe(1);
      expect((await sql.unsafe('SELECT count(*)::int AS count FROM app.logical_notifications'))[0]?.count).toBe(1);
      expect((await sql.unsafe('SELECT disabled_at IS NOT NULL AS disabled FROM app.push_subscriptions WHERE id = $1', [subscriptionId]))[0]?.disabled).toBe(true);
      expect((await sql.unsafe(`SELECT count(*)::int AS count FROM app.audits WHERE event IN ('message_body_purged', 'push_subscription_expired')`))[0]?.count).toBe(2);
    });
  });
  it.skipIf(!process.env.DATABASE_URL)('retains a valid completed Task marker and redacts replay snapshots', async () => {
    const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl,async sql=>{
      const client=(connection:Sql):SqlClient=>({query:async<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>({rows:await connection.unsafe(text,values as never[]) as Row[]}),transaction:async<T>(work:(transaction:SqlClient)=>Promise<T>)=>connection.begin(tx=>work(client(tx)))});
      const user=randomUUID(),account=randomUUID(),assignment=randomUUID(),grant=randomUUID(),activity=randomUUID(),task=randomUUID(),report=randomUUID();
      const created='2026-01-01T00:00:00.000Z',completed='2026-01-01T00:01:00.000Z',deadline='2026-01-02T00:00:00.000Z';
      await sql.begin(async tx=>{
        await tx`insert into app.users(id,email,password_hash) values(${user},${`${user}@example.test`},'hash')`;
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${user},'gmail',${account},${`${account}@example.test`},'ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;
        await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignment},${user},${account},'mastra',true)`;
        await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grant},${user},${account},'mastra',array['mail.read']::text[],array['automatic']::text[],'active',${completed})`;
      });
      await sql`insert into app.agent_activities(id,user_id,account_id,kind,correlation_id,state,revision,created_at,updated_at) values(${activity},${user},${account},'interactive_request','retention-test','resolved',1,${created},${completed})`;
      await sql`insert into app.agent_tasks(id,enqueue_key,activity_id,user_id,account_id,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,state,version,attempt_count,max_attempts,lease_generation,result,available_at,deadline_at,created_at,updated_at,completed_at) values(${task},${`retention:${task}`},${activity},${user},${account},'mastra',${assignment},1,${grant},1,1,'completed',1,1,5,1,${sql.json({kind:'action_requests_emitted',actionIds:[randomUUID()]} )},${created},${deadline},${created},${completed},${completed})`;
      const snapshot={id:task,activityId:activity,userId:user,mailboxId:account,manager:{kind:'mastra'},managerLifecycleRevision:null,assignmentId:assignment,assignmentRevision:1,grantId:grant,grantRevision:1,safetyRevision:1,state:'completed',pendingReason:null,version:1,attemptCount:1,maxAttempts:5,leaseGeneration:1,lease:null,currentRunId:null,result:{kind:'action_requests_emitted',actionIds:[randomUUID()]},lastErrorCode:null,availableAt:created,deadlineAt:deadline,createdAt:created,updatedAt:completed,completedAt:completed,obsoleteAt:null};
      await sql`insert into app.agent_task_reports(id,task_id,lease_generation,kind,request_id,request_digest,accepted,occurred_at,response_snapshot) values(${report},${task},1,'result','retention-report-1',${'a'.repeat(64)},true,${completed},${sql.json({task:snapshot})})`;
      expect(await new PostgresLifecycleStore(client(sql)).minimizeTerminalTaskPayloads(new Date('2026-02-01T00:00:00Z'),new Date('2026-02-02T00:00:00Z'),10)).toBe(1);
      expect((await sql<{result:{kind:string}}[]>`select result from app.agent_tasks where id=${task}`)[0]?.result).toEqual({kind:'redacted'});
      const redacted=(await sql<{response_snapshot:{task:unknown}}[]>`select response_snapshot from app.agent_task_reports where id=${report}`)[0]?.response_snapshot.task;
      expect(agentTaskSchema.parse(redacted).result).toEqual({kind:'redacted'});
    });
  });

});
