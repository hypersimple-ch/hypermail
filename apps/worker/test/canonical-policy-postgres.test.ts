/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentActivity, AgentRun } from '@hypermail/contracts';
import { AgentWorkStore, createPostgresClient } from '@hypermail/db';
import { PolicyExecutor, PostgresPolicyPersistence, type PolicyActionInput, type PrivateMutationTransport } from '@hypermail/policy';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl=process.env.DATABASE_URL;
const at='2026-08-16T12:00:00.000Z';

async function seed(sql:Sql) {
  const userId=randomUUID(), accountId=randomUUID(), assignmentId=randomUUID(), grantId=randomUUID(), messageId=randomUUID();
  await sql.begin(async tx => {
    await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'microsoft',${accountId},${`${accountId}@example.test`},'ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
    await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
    await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.mark_read']::text[],array['automatic']::text[],'active',${at})`;
    await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${messageId},${accountId},'provider-message','{"address":"sender@example.test"}','[]',${at})`;
  });
  return {userId,accountId,assignmentId,grantId,messageId};
}

const transport=(mutate:()=>Promise<Readonly<Record<string,unknown>>>):PrivateMutationTransport => ({
  archive:async()=>({}),recoverableTrash:async()=>({}),move:async()=>({}),markRead:mutate,markUnread:async()=>({}),draftCreate:async()=>({}),draftEdit:async()=>({}),read:async()=>({isRead:true}),
});

describe('canonical policy PostgreSQL execution',()=>{
  it.skipIf(!databaseUrl)('records real reports separately and verifies interrupted execution without fabricating one',async()=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const ids=await seed(sql); const client=createPostgresClient(databaseUrl??''); const store=new AgentWorkStore(client);
      try {
        const activity:AgentActivity={id:randomUUID(),userId:ids.userId,mailboxId:ids.accountId,kind:'interactive_request',sourceMessageId:null,correlationId:`activity-${randomUUID()}`,causationId:null,state:'open',revision:1,createdAt:at,updatedAt:at};
        await store.createActivity(activity);
        const run:AgentRun={id:randomUUID(),activityId:activity.id,userId:ids.userId,mailboxId:ids.accountId,sequence:1,manager:{kind:'mastra'},managerLifecycleRevision:null,assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,mode:'automatic',trigger:{kind:'interactive_request',requestId:randomUUID()},inputDigest:'a'.repeat(64),correlationId:`run-${randomUUID()}`,causationId:activity.id,state:'created',outcome:null,errorCode:null,createdAt:at,startedAt:null,completedAt:null};
        await store.createRun(run); await store.startRun(ids.userId,ids.accountId,run.id,at); await store.completeRun(ids.userId,ids.accountId,run.id,'action_requests_emitted',at);
        const makeAction=():AgentAction=>({id:randomUUID(),activityId:activity.id,runId:run.id,userId:ids.userId,mailboxId:ids.accountId,correlationId:`action-${randomUUID()}`,causationId:run.id,manager:run.manager,managerLifecycleRevision:null,mode:'automatic',assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,kind:'mark_read',target:{messageId:ids.messageId},authorizationRevision:1,idempotencyKey:`policy-${randomUUID()}`,attempt:1,retryOfActionId:null,state:'authorized',errorCode:null,authorizedAt:at,startedAt:null,providerReportedAt:null,completedAt:null,verification:null});
        const execute=async(action:AgentAction,mutation:()=>Promise<Readonly<Record<string,unknown>>>)=>new PolicyExecutor({persistence:new PostgresPolicyPersistence(client),transport:transport(mutation),isGloballyPaused:()=>false}).execute({actionId:action.id,runId:run.id,userId:ids.userId,activityId:activity.id,decisionId:run.id,idempotencyKey:action.idempotencyKey,kind:'mark_read',target:{accountId:ids.accountId,messageId:ids.messageId},precondition:{}} satisfies PolicyActionInput);
        const unproven=makeAction(); await store.authorizeAction(unproven); await store.startAction(ids.userId,ids.accountId,unproven.id,at);
        await expect(sql`update app.agent_authorized_actions set state='verified',completed_at=now() where id=${unproven.id}`).rejects.toThrow(/evidence/i);
        expect(await sql`select state from app.agent_authorized_actions where id=${unproven.id}`).toEqual([{state:'executing'}]);
        await store.failAction(ids.userId,ids.accountId,unproven.id,'cancelled',at);
        const reported=makeAction(), concurrent=makeAction(); await store.authorizeAction(reported); await store.authorizeAction(concurrent);
        await expect(Promise.all([execute(reported,async()=>({id:'provider-report'})),execute(concurrent,async()=>({id:'provider-report-2'}))])).resolves.toEqual([expect.objectContaining({outcome:'succeeded'}),expect.objectContaining({outcome:'succeeded'})]);
        expect(await sql`select state,provider_reported_at is not null as reported from app.agent_authorized_actions where id=${reported.id}`).toEqual([{state:'verified',reported:true}]);
        const sequences=await sql<{sequence:number}[]>`select sequence from app.agent_activity_events where activity_id=${activity.id} order by sequence`;
        expect(new Set(sequences.map(row=>row.sequence)).size).toBe(sequences.length);
        const interrupted=makeAction(); await store.authorizeAction(interrupted); await store.startAction(ids.userId,ids.accountId,interrupted.id,at); let mutations=0;
        await expect(execute(interrupted,async()=>{mutations+=1;return {};})).resolves.toMatchObject({outcome:'succeeded'}); expect(mutations).toBe(0);
        expect(await sql`select state,provider_reported_at is null as no_report from app.agent_authorized_actions where id=${interrupted.id}`).toEqual([{state:'verified',no_report:true}]);
        const reportEvents=await sql<{count:number}[]>`select count(*)::integer as count from app.agent_activity_events where detail->>'type'='action_provider_reported' and detail->>'actionId'=${interrupted.id}`;
        expect(reportEvents).toEqual([{count:0}]);
      } finally { await client.close(); }
    });
  });
});
