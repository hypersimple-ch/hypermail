import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentActivity, AgentActivityEvent, AgentRun } from '@hypermail/contracts';
import { AgentWorkStore, createPostgresClient } from '../src/index.js';
import { withPostgresSchemas } from '../../../apps/worker/test/postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresUrl = databaseUrl ?? '';
const digest = (character: string): string => character.repeat(64);
const at = (minute: number): string => `2026-08-13T12:${String(minute).padStart(2, '0')}:00.000Z`;

async function seed(sql: Sql) {
  const userId = randomUUID(); const accountId = randomUUID(); const assignmentId = randomUUID(); const grantId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'microsoft',${`provider-${accountId}`},${`${accountId}@example.test`},'ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
    await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',false)`;
    await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at)
      values(${grantId},${userId},${accountId},'mastra',array['mail.mark_read']::text[],array['interactive']::text[],'active',${at(0)})`;
  });
  const messageId = randomUUID(); const legacyActivityId = randomUUID();
  await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,preview,received_at)
    values(${messageId},${accountId},${`legacy-${messageId}`},${sql.json({ address: 'sender@example.test' })},${sql.json([])},'legacy','unchanged',${at(0)})`;
  await sql`insert into app.activities(id,message_id,account_id,state,version) values(${legacyActivityId},${messageId},${accountId},'new',1)`;
  return { userId, accountId, assignmentId, grantId, messageId, legacyActivityId };
}

const makeRun = (ids: Awaited<ReturnType<typeof seed>>, activity: AgentActivity, sequence: number, id = randomUUID(), inputDigest = digest('a')): AgentRun => ({
  id, activityId: activity.id, userId: ids.userId, mailboxId: ids.accountId, sequence,
  manager: { kind: 'mastra' }, managerLifecycleRevision: null, assignmentId: ids.assignmentId,
  assignmentRevision: 1, grantId: ids.grantId, grantRevision: 1, safetyRevision: 1,
  mode: 'interactive', trigger: { kind: 'interactive_request', requestId: randomUUID() }, inputDigest,
  correlationId: `run-correlation-${id}`, causationId: activity.id, state: 'created', outcome: null,
  errorCode: null, createdAt: at(1), startedAt: null, completedAt: null,
});
const makeAction = (ids: Awaited<ReturnType<typeof seed>>, activity: AgentActivity, run: AgentRun, overrides: Partial<AgentAction> = {}): AgentAction => ({
  id: randomUUID(), activityId: activity.id, runId: run.id, userId: ids.userId, mailboxId: ids.accountId,
  correlationId: `action-correlation-${randomUUID()}`, causationId: run.id, manager: run.manager,
  managerLifecycleRevision: null, mode: 'interactive', assignmentId: ids.assignmentId, assignmentRevision: 1,
  grantId: ids.grantId, grantRevision: 1, safetyRevision: 1, kind: 'mark_read', target: { messageId: ids.messageId },
  authorizationRevision: 1, idempotencyKey: `action-idempotency-${randomUUID()}`, attempt: 1,
  retryOfActionId: null, state: 'authorized', errorCode: null, authorizedAt: at(4), startedAt: null,
  providerReportedAt: null, completedAt: null, verification: null, ...overrides,
});

// This test is intentionally one serial scenario: the shared migration helper resets schemas.
describe('Agent work PostgreSQL integration', () => {
  it.skipIf(!databaseUrl)('migrates cleanly and enforces canonical work history end to end', async () => {
    await withPostgresSchemas(postgresUrl, async (sql) => {
      const ids = await seed(sql);
      const client = createPostgresClient(postgresUrl); const store = new AgentWorkStore(client);
      try {
        const activity: AgentActivity = { id: randomUUID(), userId: ids.userId, mailboxId: ids.accountId,
          kind: 'interactive_request', sourceMessageId: null, correlationId: `activity-${randomUUID()}`,
          causationId: null, state: 'open', revision: 1, createdAt: at(0), updatedAt: at(0) };
        await expect(store.createActivity(activity)).resolves.toEqual(activity);
        await expect(store.createActivity(activity)).resolves.toEqual(activity);
        await expect(store.createActivity({ ...activity, causationId: randomUUID() })).rejects.toThrow('different payload');

        const run = makeRun(ids, activity, 1);
        await expect(store.createRun(run)).resolves.toEqual(run);
        await expect(store.createRun(run)).resolves.toEqual(run);
        await expect(store.createRun({ ...run, correlationId: `different-${randomUUID()}` })).rejects.toThrow('different payload');
        await expect(store.startRun(ids.userId, ids.accountId, run.id, at(2))).resolves.toMatchObject({ state: 'running' });
        await expect(store.completeRun(ids.userId, ids.accountId, run.id, 'action_requests_emitted', at(3))).resolves.toMatchObject({ state: 'completed' });
        await expect(store.completeRun(ids.userId, ids.accountId, run.id, 'no_action', at(4))).rejects.toThrow();
        await expect(store.createRun(run)).resolves.toMatchObject({ state: 'completed' });

        const action = makeAction(ids, activity, run);
        await expect(store.authorizeAction(action)).resolves.toEqual(action);
        await expect(store.authorizeAction(action)).resolves.toEqual(action);
        await expect(store.authorizeAction({ ...action, authorizationRevision: 2 })).rejects.toThrow('different payload');
        await store.startAction(ids.userId, ids.accountId, action.id, at(5));
        const reported = await store.reportAction(ids.userId, ids.accountId, action.id, at(6));
        expect(reported.state).toBe('verifying');
        expect(await sql`select count(*)::integer as count from app.agent_action_verifications where action_id=${action.id}`).toEqual([{ count: 0 }]);

        const proof = { actionId: action.id, mailboxId: ids.accountId, verifier: 'hypermail_provider_readback' as const,
          providerMutationId: 'provider-mutation-1', evidenceDigest: digest('b'), observedAt: at(7) };
        const event: AgentActivityEvent = { id: randomUUID(), activityId: activity.id, userId: ids.userId,
          mailboxId: ids.accountId, sequence: 1, correlationId: `verification-${randomUUID()}`, causationId: action.id,
          occurredAt: at(7), detail: { type: 'action_verified', runId: run.id, actionId: action.id } };
        const verified = await store.verifyAction(ids.userId, ids.accountId, action.id, proof, event);
        expect(verified).toMatchObject({ state: 'verified', verification: proof });
        expect(await sql<{kind:string;content_payload:Record<string,unknown>}[]>`select kind,content_payload from app.mailbox_memory_events where source_id=${action.id}`)
          .toEqual([{ kind: 'mailbox_action_verified', content_payload: { outcome: 'verified', actionKind: 'mark_read', target: { messageId: ids.messageId } } }]);
        await expect(store.authorizeAction(action)).resolves.toMatchObject({ state: 'verified' });

        await expect(sql`update app.agent_authorized_actions set completed_at=${at(8)} where id=${action.id}`).rejects.toThrow();
        await expect(sql`delete from app.agent_authorized_actions where id=${action.id}`).rejects.toThrow();
        await expect(sql`update app.agent_activity_events set occurred_at=${at(8)} where id=${event.id}`).rejects.toThrow();
        await expect(sql`delete from app.agent_action_verifications where action_id=${action.id}`).rejects.toThrow();
        await expect(sql`update app.agent_safety_ceiling_revisions set changed_at=${at(8)} where revision=1`).rejects.toThrow();

        const sequenceEvents: AgentActivityEvent[] = [1, 2].map((index) => ({ id: randomUUID(), activityId: activity.id,
          userId: ids.userId, mailboxId: ids.accountId, sequence: 2, correlationId: `concurrent-${String(index)}-${randomUUID()}`,
          causationId: null, occurredAt: at(8), detail: { type: 'external_drift', summary: `drift ${String(index)}` } }));
        const concurrent = await Promise.allSettled(sequenceEvents.map((item) => store.appendEvent(item)));
        expect(concurrent.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        expect(await sql`select array_agg(sequence order by sequence) as sequences from app.agent_activity_events where activity_id=${activity.id}`).toEqual([{ sequences: [1, 2] }]);

        await expect(store.transitionActivity(ids.userId, ids.accountId, activity.id, 1, 'resolved', at(9))).resolves.toMatchObject({ revision: 2, state: 'resolved' });
        await expect(store.transitionActivity(ids.userId, ids.accountId, activity.id, 1, 'acknowledged', at(10))).rejects.toThrow('Stale');
        await expect(sql`delete from app.agent_activities where id=${activity.id}`).rejects.toThrow();

        const failed = makeAction(ids, activity, run, { authorizedAt: at(10) });
        await store.authorizeAction(failed); await store.failAction(ids.userId, ids.accountId, failed.id, 'unverifiable', at(11));
        await expect(store.failAction(ids.userId, ids.accountId, failed.id, 'unverifiable', at(11))).rejects.toThrow('Illegal Agent Action transition');
        expect(await sql<{kind:string;content_payload:Record<string,unknown>}[]>`select kind,content_payload from app.mailbox_memory_events where source_id=${failed.id}`)
          .toEqual([{ kind: 'mailbox_action_unverifiable', content_payload: { outcome: 'unverifiable', actionKind: 'mark_read', target: { messageId: ids.messageId } } }]);
        const retry = makeAction(ids, activity, run, { attempt: 2, retryOfActionId: failed.id, authorizedAt: at(12) });
        await expect(store.retryAction(failed.id, retry)).resolves.toMatchObject({ attempt: 2, retryOfActionId: failed.id });
        const invalidRetry = makeAction(ids, activity, run, { attempt: 3, retryOfActionId: failed.id, authorizedAt: at(12) });
        await expect(store.retryAction(failed.id, invalidRetry)).rejects.toThrow('retry');

        const otherUser = randomUUID(); const otherAccount = randomUUID();
        await sql.begin(async (tx) => { await tx`insert into app.users(id,email,password_hash) values(${otherUser},${`${otherUser}@example.test`},'hash')`;
          await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${otherAccount},${otherUser},'microsoft',${`p-${otherAccount}`},${`${otherAccount}@example.test`},'ready')`;
          await tx`insert into app.user_accounts(user_id,account_id) values(${otherUser},${otherAccount})`; });
        await expect(store.startRun(otherUser, otherAccount, run.id, at(12))).rejects.toThrow('tenant');
        await expect(sql`insert into app.agent_activity_events(id,activity_id,user_id,account_id,sequence,correlation_id,occurred_at,detail)
          values(${randomUUID()},${activity.id},${otherUser},${otherAccount},3,'wrong-tenant-correlation',${at(12)},${sql.json({ type: 'external_drift', summary: 'wrong tenant' })})`).rejects.toThrow();

        expect(await sql`select id,state,version from app.activities where id=${ids.legacyActivityId}`).toEqual([{ id: ids.legacyActivityId, state: 'new', version: 1 }]);
      } finally { await client.close(); }
    });
  }, 30_000);
});
