import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env['DATABASE_URL'];
const journalUrl = new URL('../drizzle/meta/_journal.json', import.meta.url);
async function migrate(sql: Sql, from: number, through: number): Promise<void> {
  const journal = JSON.parse(await readFile(journalUrl, 'utf8')) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries.filter(({ idx }) => idx >= from && idx <= through)) {
    const source = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
    for (const statement of source.split('--> statement-breakpoint')) if (statement.trim()) await sql.unsafe(statement);
  }
}
const reset = (sql: Sql) => sql.unsafe('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mastra CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE');

// DATABASE_URL must be the disposable acceptance database: this scenario resets its schemas.
describe('durable decision migration', () => {
  it.skipIf(!databaseUrl)('migrates fresh and preserves non-executable version-one history on upgrade', async () => {
    const sql = postgres(databaseUrl ?? '', { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe('SELECT pg_advisory_lock(825649471)');
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await reset(sql);
      await migrate(sql, 0, 19);
      const tables = await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='app'`;
      for (const name of ['agent_action_proposals', 'agent_proposal_dependencies', 'agent_action_reviews', 'agent_conversations', 'agent_conversation_messages', 'agent_conversation_turns', 'policy_safety_samples', 'notification_targets', 'approved_send_submissions', 'recovery_mail_deliveries']) {
        expect(tables.some((table) => table.name === name)).toBe(true);
      }
      await reset(sql);
      await migrate(sql, 0, 14);
      const userId = randomUUID(); const accountId = randomUUID(); const messageId = randomUUID();
      const activityId = randomUUID(); const decisionId = randomUUID(); const actionId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`insert into app.users(id,email,password_hash) values(${userId},'owner@example.test','hash')`;
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'imap','migration-fixture','box@example.test','ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
      });
      await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,preview,received_at) values(${messageId},${accountId},'historical',${sql.json({ address: 'sender@example.test' })},${sql.json([])},'Historical','preview',now())`;
      await sql`insert into app.activities(id,message_id,account_id,state) values(${activityId},${messageId},${accountId},'handled')`;
      const output = { state: 'actionable', rationale: 'Historical plan', actions: [{ kind: 'archive', target: { accountId, messageId }, reason: 'Historical plan' }] };
      await sql`insert into app.decisions(id,activity_id,attempt,state,rationale,model_provider,model_name,input_digest,output) values(${decisionId},${activityId},1,'actionable','Historical plan','fixture','fixture',${'a'.repeat(64)},${sql.json(output)})`;
      await sql`insert into app.actions(id,activity_id,decision_id,kind,state,idempotency_key,target,precondition) values(${actionId},${activityId},${decisionId},'archive','planned','historical-action-key',${sql.json({ accountId, messageId })},'{}')`;
      const assignmentId = randomUUID(); const grantId = randomUUID(); const runId = randomUUID(); const interruptedId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
        await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.archive'],array['automatic'],'active',now())`;
      });
      await sql`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id,state,revision) values(${activityId},${userId},${accountId},'arrival',${messageId},'migration-activity','open',1)`;
      await sql`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,started_at,completed_at)
        values(${runId},${activityId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${sql.json({ kind: 'arrival', messageId })},${'a'.repeat(64)},'migration-run','completed','action_requests_emitted',now(),now())`;
      for (const [id, key] of [[actionId, 'historical-action-key'], [interruptedId, 'historical-interrupted-key']] as const) {
        await sql`insert into app.agent_authorized_actions(id,activity_id,run_id,user_id,account_id,correlation_id,causation_id,manager_kind,mode,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,kind,target,authorization_revision,idempotency_key,attempt,state)
          values(${id},${activityId},${runId},${userId},${accountId},'migration-action',${decisionId},'mastra','automatic',${assignmentId},1,${grantId},1,1,'archive',${sql.json({ messageId })},1,${key},1,'authorized')`;
      }
      await sql`update app.agent_authorized_actions set state='executing',started_at=now() where id=${interruptedId}`;
      await sql`insert into app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,occurred_at,detail)
        values(${activityId},${userId},${accountId},1,'migration-send-history',now(),${sql.json({ type: 'send_rejected', requestId: randomUUID() })})`;
      await migrate(sql, 15, 19);
      expect(await sql`select schema_version,output from app.decisions where id=${decisionId}`).toEqual([{ schema_version: 1, output }]);
      const [action] = await sql`select state,error_code from app.actions where id=${actionId}`;
      expect(action?.['state']).not.toBe('planned');
      expect(action?.['error_code']).toBe('DECISION_SCHEMA_UPGRADE_REQUIRED');
      expect(await sql`select state from app.activities where id=${activityId}`).toEqual([{ state: 'failed' }]);
      expect(await sql`select state,error_code from app.agent_authorized_actions where id=${actionId}`).toEqual([{ state: 'cancelled', error_code: 'DECISION_SCHEMA_UPGRADE_REQUIRED' }]);
      expect(await sql`select state from app.agent_authorized_actions where id=${interruptedId}`).toEqual([{ state: 'executing' }]);
      expect(await sql`select state from app.agent_activities where id=${activityId}`).toEqual([{ state: 'attention_required' }]);
      expect(await sql`select detail->>'type' as type from app.agent_activity_events where activity_id=${activityId}`).toEqual([{ type: 'send_rejected' }]);
      expect(await sql`select count(*)::integer as count from app.agent_action_proposals`).toEqual([{ count: 0 }]);
      await expect(sql`update app.decisions set schema_version=2 where id=${decisionId}`).rejects.toThrow();
    } finally {
      await reset(sql);
      await sql.unsafe('SELECT pg_advisory_unlock(825649471)');
      await sql.end();
    }
  }, 30_000);
});
