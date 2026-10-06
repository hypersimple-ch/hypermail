/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-type-conversion */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AgentProposalStore, createPostgresClient, proposalUuid, validateAuthorizedProposalInTransaction, type SqlClient as DatabaseSqlClient } from '@hypermail/db';
import type { PlannedAction } from '@hypermail/contracts';
import { DurableNotificationRecovery } from '../src/runtime.js';
import { DispatchRecovery, IngestionWorker, type DeliveryQueue, type MailProvider } from '../src/ingestion.js';
import { PostgresIngestionStore, type SqlClient } from '../src/postgres-store.js';
import { PostgresLifecycleStore } from '../src/lifecycle/postgres-store.js';
import { DurablePolicyRecovery, PgBossPolicyDispatcher } from '../src/policy.js';
import { composeWorkerRuntime } from '../src/production.js';
import { PostgresNotificationDispatchStore } from '../src/notification-dispatch-store.js';
import { parseWorkerEnvironment } from '../src/runtime.js';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
const now = new Date('2026-04-01T00:00:00.000Z');

const workerSql = (database: DatabaseSqlClient): SqlClient => ({
  query: async <Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> => ({ rows: [...(await database.query<Row>(statement, values)).rows] }),
  transaction: async <T>(work: (transaction: SqlClient) => Promise<T>): Promise<T> => database.transaction((transaction) => work(workerSql(transaction))),
});
const environment = (port: number, hindsightUrl: string) => parseWorkerEnvironment({
  DATABASE_URL: databaseUrl, HYPERMAIL_URL: 'http://127.0.0.1:9/mcp', HYPERMAIL_KEY: 'a'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'test',
  HINDSIGHT_URL: hindsightUrl, HINDSIGHT_EXPECTED_VERSION: '0.9.1', MODEL_PROVIDER: 'openai', MODEL_NAME: 'test', MODEL_API_KEY: 'b'.repeat(16), VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), AGENT_GLOBAL_CONSTRAINTS: 'Never send mail.', ATTACHMENT_TEMP_DIRECTORY: '/private/attachments', HEALTH_PORT: port,
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

/** Readiness-only HTTP fixture: unexpected memory operations fail rather than fabricate data. */
async function hindsightReadinessFixture() {
  const responses: Readonly<Record<string, unknown>> = {
    '/health/ready': { status: 'ready' },
    '/version': { api_version: '0.9.1', features: {
      observations: true, worker: true, bank_config_api: true, file_upload_api: true, store_document_text: true,
    } },
    '/openapi.json': { openapi: '3.1.0', paths: {
      '/v1/default/banks/{bank_id}': { put: { responses: {} }, delete: { responses: {} } },
      '/v1/default/banks/{bank_id}/memories': { post: { responses: {} } },
      '/v1/default/banks/{bank_id}/memories/recall': { post: { responses: {} } },
      '/v1/default/banks/{bank_id}/files/retain': { post: { responses: {} } },
      '/v1/default/banks/{bank_id}/operations/{operation_id}': { get: { responses: {} } },
    } },
  };
  const server = createServer((request, response) => {
    const body = request.method === 'GET' ? responses[request.url ?? ''] : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { error: 'Unexpected Hindsight fixture request' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate Hindsight fixture port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }),
  };
}

async function seedActivity(sql: { unsafe(query: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> }, accountId: string, userId: string, suffix: string, actions?: (messageId:string)=>PlannedAction[]) {
  const messageId = randomUUID(), activityId = randomUUID(), decisionId = randomUUID(), runId = randomUUID(), assignmentId = randomUUID(), grantId = randomUUID();
  await sql.unsafe(`insert into app.messages (id, account_id, provider_message_id, sender, recipients, received_at) values ($1, $2, $3, '{"address":"sender@example.test"}', '[]', $4)`, [messageId, accountId, `provider-${suffix}`, now]);
  await sql.unsafe(`insert into app.activities (id, account_id, message_id) values ($1, $2, $3)`, [activityId, accountId, messageId]);
  await sql.unsafe(`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id) values($1,$2,$3,'arrival',$4,$5)`,[activityId,userId,accountId,messageId,`arrival:${activityId}`]);
  await sql.unsafe(`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values($1,$2,$3,'mastra',true)`,[assignmentId,userId,accountId]);
  await sql.unsafe(`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values($1,$2,$3,'mastra',array['mail.archive','mail.move','draft.create','draft.edit'],array['automatic'],'active',now())`,[grantId,userId,accountId]);
  await sql.unsafe(`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,started_at,completed_at,outcome) values($1,$2,$3,$4,1,'mastra',$5,1,$6,1,1,'automatic',$9::text::jsonb,$7,$8,'completed',now(),now(),'action_requests_emitted')`,[runId,activityId,userId,accountId,assignmentId,grantId,'a'.repeat(64),`run:${runId}`,JSON.stringify({kind:'arrival',messageId})]);
  const output={schemaVersion:2,state:'actionable',rationale:'test',actions:actions?.(messageId)??[{key:'archive',kind:'archive',target:{accountId,messageId},confidence:0.60,reason:'Archive this test message.',evidenceIds:[],dependsOn:[]}]};
  await sql.unsafe(`insert into app.decisions(id,activity_id,user_id,account_id,run_id,schema_version,attempt,state,rationale,model_provider,model_name,input_digest,output) values($1,$2,$3,$4,$5,2,1,'actionable','test','test','test',$7,$6::text::jsonb)`,[decisionId,activityId,userId,accountId,runId,JSON.stringify(output),'b'.repeat(64)]);
  return { messageId, activityId, decisionId };
}

describe('worker PostgreSQL runtime integration', () => {
  it.skipIf(!databaseUrl)('replays durable work, isolates provider faults, runs lifecycle, and shuts down not-ready safely', async () => {
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    await withPostgresSchemas(databaseUrl, async sql => {
      const database = createPostgresClient(databaseUrl); const adapter = workerSql(database);
      const ingestion = new PostgresIngestionStore(adapter); const accountA = randomUUID(); const accountB = randomUUID(); const userId = randomUUID();
      try {
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
      const planned = await seedActivity(sql, accountA, userId, 'planned');
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
      const hindsight = await hindsightReadinessFixture();
      const runtime = composeWorkerRuntime(environment(port, hindsight.url), {
        createDatabase: () => database,
        createBoss: () => rawBoss as never,
        createHypermail: () => ({ initialize: async () => { initializations += 1; }, establishBaseline: async () => undefined, pollNewInbox: async () => [], inbox: async () => ({ messages: [] }), readMessage: async () => ({ body: '' }) }) as never,
        createTriageService: () => ({ triage: async () => ({ decision: { schemaVersion: 2, state: 'no_action', rationale: 'test' } }) }) as never,
        createNotificationTransport: () => ({ send: async () => ({ ok: true }) }), holderId: () => 'postgres-runtime-test',
      });
      try {
        await runtime.start();
        expect((await fetch(`http://127.0.0.1:${String(port)}/live`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${String(port)}/ready`)).status).toBe(503);
        expect(runtime.dependencyState).toMatchObject({ database: true, queue: true, hindsight: true, policy: false });
        expect(initializations).toBe(1);
        await runtime.shutdown();
        await expect(fetch(`http://127.0.0.1:${String(port)}/live`)).rejects.toThrow();
      } finally {
        try { await runtime.shutdown(); } finally { await hindsight.close(); }
      }
      } finally { await database.close(); }
    });
  }, 60_000);
  it.skipIf(!databaseUrl)('advances independent proposals once and redirects corrections without replaying siblings',async()=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const userId=randomUUID(),accountId=randomUUID(),folderId=randomUUID();
      await sql`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'test')`;
      await sql.begin(async tx => {
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'gmail',${accountId},'proposal@example.test','ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
      });
      await sql`insert into app.folders(id,account_id,provider_folder_id,name,selectable) values(${folderId},${accountId},'destination','Destination',true)`;
      const content={recipients:[{kind:'to' as const,address:'recipient@example.test'}],subject:'Prepared reply',body:'Reply body',bodyFormat:'markdown' as const};
      const fixture=await seedActivity(sql,accountId,userId,'mixed',messageId=>[
        {key:'reply',kind:'draft_create',target:{accountId,messageId},draft:content,confidence:0.60,reason:'Prepare a reply.',evidenceIds:[],dependsOn:[]},
        {key:'move',kind:'move',target:{accountId,messageId,destinationFolderId:folderId},confidence:0.5999,reason:'Move after review.',evidenceIds:[],dependsOn:[]},
        {key:'dependent_reply',kind:'draft_create',target:{accountId,messageId},draft:content,confidence:0.9,reason:'Wait for classification.',evidenceIds:[],dependsOn:['move','declined_reply']},
        {key:'review_reply',kind:'draft_create',target:{accountId,messageId},draft:content,confidence:0.4,reason:'Ask before preparing.',evidenceIds:[],dependsOn:[]},
        {key:'declined_reply',kind:'draft_create',target:{accountId,messageId},draft:content,confidence:0.4,reason:'Ask before another draft.',evidenceIds:[],dependsOn:[]},
      ]);
      const client=createPostgresClient(databaseUrl??''); const store=new AgentProposalStore(client);const scope={userId,accountIds:[accountId]};
      try {
        await Promise.all([store.materializeDecision(fixture.decisionId),store.materializeDecision(fixture.decisionId)]);
        const rows=await sql<{id:string;action_key:string;state:string;revision:number}[]>`select id,action_key,state,revision from app.agent_action_proposals where decision_id=${fixture.decisionId}`;
        const reply=rows.find(p=>p.action_key==='reply'),move=rows.find(p=>p.action_key==='move'),dependent=rows.find(p=>p.action_key==='dependent_reply');
        if(!reply||!move||!dependent)throw new Error('Missing proposals');
        expect(reply.state).toBe('ready');expect(move.state).toBe('waiting_review');
        expect(await store.authorizeReadyProposal(dependent.id)).toBeNull();
        const actions=await Promise.all([store.authorizeReadyProposal(reply.id),store.authorizeReadyProposal(reply.id)]);
        expect(actions.filter(Boolean)).toHaveLength(1);
        expect(await sql`select version,body,created_by from app.drafts where id=${proposalUuid(`draft:${reply.id}`)}`).toEqual([{version:1,body:content.body,created_by:'agent'}]);
        expect(await sql`select state from app.activities where id=${fixture.activityId}`).toEqual([{state:'waiting_question'}]);
        const correction={kind:'archive' as const,target:{accountId,messageId:fixture.messageId},reason:'Use Archive instead.'};
        const input={expectedRevision:1,idempotencyKey:randomUUID(),decision:'correct' as const,correction};
        const review=await store.review(scope,move.id,input);expect(review.kind).toBe('reviewed');
        expect(await store.review(scope,move.id,input)).toEqual(review);
        expect(await store.review(scope,move.id,{...input,reason:'Different digest'})).toMatchObject({kind:'conflict',reasonCode:'IDEMPOTENCY_KEY_REUSED'});
        if(review.kind!=='reviewed'||!review.successorProposalId)throw new Error('Missing successor');
        expect(await sql`select depends_on_id from app.agent_proposal_dependencies where proposal_id=${dependent.id}`).toEqual(expect.arrayContaining([{depends_on_id:review.successorProposalId}]));
        expect(await store.authorizeReadyProposal(dependent.id)).toBeNull();
        expect(await store.authorizeReadyProposal(review.successorProposalId)).not.toBeNull();
        expect(await sql`select confidence,state from app.agent_action_proposals where id=${review.successorProposalId}`).toEqual([{confidence:null,state:'authorized'}]);
        const replyAction=actions.find((id):id is string=>id!==null);if(!replyAction)throw new Error('Missing reply action');
        expect(await client.transaction(tx=>validateAuthorizedProposalInTransaction(tx,replyAction))).toEqual({allowed:true});
        await sql`update app.drafts set body='Owner change',version=version+1 where id=${proposalUuid(`draft:${reply.id}`)}`;
        expect(await client.transaction(tx=>validateAuthorizedProposalInTransaction(tx,replyAction))).toMatchObject({allowed:false,reasonCode:'DRAFT_VERSION_CONFLICT'});
        expect(await sql`select count(*)::integer as count from app.draft_revisions where draft_id=${proposalUuid(`draft:${reply.id}`)}`).toEqual([{count:1}]);
        const pending=rows.find(p=>p.action_key==='review_reply'),declined=rows.find(p=>p.action_key==='declined_reply');
        if(!pending||!declined)throw new Error('Missing review proposals');
        const approve={expectedRevision:1,idempotencyKey:randomUUID(),decision:'approve' as const};
        const approvals=await Promise.all([store.review(scope,pending.id,approve),store.review(scope,pending.id,{...approve,idempotencyKey:randomUUID()})]);
        expect(approvals.filter(r=>r.kind==='reviewed')).toHaveLength(1);expect(approvals.filter(r=>r.kind==='conflict')).toHaveLength(1);
        const approvedActions=await Promise.all([store.authorizeReadyProposal(pending.id),store.authorizeReadyProposal(pending.id)]);
        expect(approvedActions.filter(Boolean)).toHaveLength(1);
        expect(await sql`select count(*)::integer as count from app.draft_revisions where draft_id=${proposalUuid(`draft:${pending.id}`)}`).toEqual([{count:1}]);
        expect(await store.review(scope,declined.id,{expectedRevision:1,idempotencyKey:randomUUID(),decision:'reject'})).toMatchObject({kind:'reviewed'});
        expect(await sql`select state from app.agent_action_proposals where id=${dependent.id}`).toEqual([{state:'blocked'}]);
        expect(await sql`select id from app.drafts where id=${proposalUuid(`draft:${declined.id}`)}`).toEqual([]);
        const editDecisionId=randomUUID(),draftId=proposalUuid(`draft:${reply.id}`);
        const editOutput={schemaVersion:2,state:'actionable',rationale:'Edit test',actions:[{key:'edit_reply',kind:'draft_edit',target:{accountId,draftId},expectedVersion:1,draft:content,confidence:0.9,reason:'Update prepared draft.',evidenceIds:[],dependsOn:[]}]};
        await sql`insert into app.decisions(id,activity_id,user_id,account_id,run_id,schema_version,attempt,state,rationale,model_provider,model_name,input_digest,output) select ${editDecisionId},activity_id,user_id,account_id,run_id,2,2,'actionable','Edit test','test','test',${'c'.repeat(64)},${JSON.stringify(editOutput)}::text::jsonb from app.decisions where id=${fixture.decisionId}`;
        await store.materializeDecision(editDecisionId);
        const editProposalId=proposalUuid(`proposal:${editDecisionId}:edit_reply`);
        expect(await store.authorizeReadyProposal(editProposalId)).toBeNull();
        expect(await sql`select state,error_code from app.agent_action_proposals where id=${editProposalId}`).toEqual([{state:'blocked',error_code:'DRAFT_VERSION_CONFLICT'}]);
        expect(await sql`select version,body from app.drafts where id=${draftId}`).toEqual([{version:2,body:'Owner change'}]);
      } finally {await client.close();}
    });
  },60_000);
});
