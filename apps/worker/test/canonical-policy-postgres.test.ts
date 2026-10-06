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
    await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.mark_read','mail.archive']::text[],array['interactive']::text[],'active',${at})`;
    await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${messageId},${accountId},'provider-message','{"address":"sender@example.test"}','[]',${at})`;
  });
  return {userId,accountId,assignmentId,grantId,messageId};
}

const transport=(mutate:()=>Promise<Readonly<Record<string,unknown>>>):PrivateMutationTransport => ({
  archive:async()=>({}),recoverableTrash:async()=>({}),move:async()=>({}),markRead:mutate,markUnread:async()=>({}),draftCreate:async()=>({}),draftEdit:async()=>({}),read:async()=>({isRead:true}),
});

describe('canonical policy PostgreSQL execution',()=>{
  it.skipIf(!databaseUrl).each([0,1] as const)('deduplicates safety samples with %i incorrect in 100, excluding expired and unknown results',async incorrectCount=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const ids=await seed(sql),client=createPostgresClient(databaseUrl??''),store=new AgentWorkStore(client);
      try{
        const activity:AgentActivity={id:randomUUID(),userId:ids.userId,mailboxId:ids.accountId,kind:'interactive_request',sourceMessageId:null,correlationId:`safety-test-${randomUUID()}`,causationId:null,state:'open',revision:1,createdAt:at,updatedAt:at};
        await store.createActivity(activity);
        const run:AgentRun={id:randomUUID(),activityId:activity.id,userId:ids.userId,mailboxId:ids.accountId,sequence:1,manager:{kind:'mastra'},managerLifecycleRevision:null,assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,mode:'interactive',trigger:{kind:'interactive_request',requestId:randomUUID()},inputDigest:'b'.repeat(64),correlationId:`safety-run-${randomUUID()}`,causationId:activity.id,state:'created',outcome:null,errorCode:null,createdAt:at,startedAt:null,completedAt:null};
        await store.createRun(run);await store.startRun(ids.userId,ids.accountId,run.id,at);await store.completeRun(ids.userId,ids.accountId,run.id,'action_requests_emitted',at);
        const persistence=new PostgresPolicyPersistence(client);
        const complete=async(outcome:'succeeded'|'incorrect'|'unverifiable',expired=false)=>{
          const action:AgentAction={id:randomUUID(),activityId:activity.id,runId:run.id,userId:ids.userId,mailboxId:ids.accountId,correlationId:`safety-action-${randomUUID()}`,causationId:run.id,manager:run.manager,managerLifecycleRevision:null,mode:'interactive',assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,kind:'archive',target:{messageId:ids.messageId},authorizationRevision:1,idempotencyKey:`safety-${randomUUID()}`,attempt:1,retryOfActionId:null,state:'authorized',errorCode:null,authorizedAt:at,startedAt:null,providerReportedAt:null,completedAt:null,verification:null};
          await store.authorizeAction(action);await store.startAction(ids.userId,ids.accountId,action.id,at);
          if(expired){
            await sql`update app.agent_authorized_actions set state='failed',error_code='VERIFICATION_MISMATCH',completed_at=now() where id=${action.id}`;
            await sql`insert into app.policy_safety_samples(action_id,user_id,account_id,outcome,observed_at) values(${action.id},${ids.userId},${ids.accountId},'incorrect',now()-interval '2 hours')`;
            return action.id;
          }
          const completion={outcome,observed:{folderRole:outcome==='succeeded'?'archive':'inbox'}};
          await Promise.all([persistence.complete(action.id,ids.accountId,completion,{windowMs:3_600_000,maxIncorrectRate:.01}),persistence.complete(action.id,ids.accountId,completion,{windowMs:3_600_000,maxIncorrectRate:.01})]);
          return action.id;
        };
        await complete('incorrect',true);
        const unknownId=await complete('unverifiable');
        expect(await sql`select action_id from app.policy_safety_samples where action_id=${unknownId}`).toEqual([]);
        for(let index=0;index<100-incorrectCount;index++)await complete('succeeded');
        expect(await sql`select autonomy_paused_at is null as running from app.accounts where id=${ids.accountId}`).toEqual([{running:true}]);
        if(incorrectCount===1)await complete('incorrect');
        expect(await sql`select count(*)::integer total,count(*) filter(where outcome='incorrect')::integer incorrect from app.policy_safety_samples where account_id=${ids.accountId} and observed_at>now()-interval '1 hour'`).toEqual([{total:100,incorrect:incorrectCount}]);
        expect(await sql`select verified_mutations,incorrect_mutations from app.safety_windows where account_id=${ids.accountId}`).toEqual([{verified_mutations:100,incorrect_mutations:incorrectCount}]);
        expect(await sql`select autonomy_paused_at is not null as paused from app.accounts where id=${ids.accountId}`).toEqual([{paused:incorrectCount===1}]);
        expect(await sql`select count(*)::integer count from app.audits where account_id=${ids.accountId} and event='policy.safety_paused'`).toEqual([{count:incorrectCount}]);
        expect(await sql`select count(*)::integer count from app.logical_notifications n join app.activities a on a.id=n.activity_id where a.account_id=${ids.accountId}`).toEqual([{count:incorrectCount}]);
        expect(await sql`select kind,source_message_id,state from app.agent_activities where account_id=${ids.accountId} and kind='safety_event'`).toEqual(incorrectCount===1?[{kind:'safety_event',source_message_id:null,state:'attention_required'}]:[]);
        if(incorrectCount===1){
          const blocked:AgentAction={id:randomUUID(),activityId:activity.id,runId:run.id,userId:ids.userId,mailboxId:ids.accountId,correlationId:`paused-action-${randomUUID()}`,causationId:run.id,manager:run.manager,managerLifecycleRevision:null,mode:'interactive',assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,kind:'mark_read',target:{messageId:ids.messageId},authorizationRevision:1,idempotencyKey:`paused-${randomUUID()}`,attempt:1,retryOfActionId:null,state:'authorized',errorCode:null,authorizedAt:at,startedAt:null,providerReportedAt:null,completedAt:null,verification:null};
          await store.authorizeAction(blocked);let mutations=0;
          await expect(persistence.claimImmediatelyBeforeMutation(blocked.id,ids.accountId,()=>false)).resolves.toBe('paused');
          const executor=new PolicyExecutor({persistence,transport:transport(async()=>{mutations++;return {};}),isGloballyPaused:()=>false});
          await expect(executor.execute({actionId:blocked.id,runId:run.id,userId:ids.userId,activityId:activity.id,decisionId:run.id,idempotencyKey:blocked.idempotencyKey,kind:blocked.kind,target:{accountId:ids.accountId,messageId:ids.messageId},precondition:{}})).resolves.toMatchObject({outcome:'paused'});
          expect(mutations).toBe(0);
        }
        await complete('succeeded');
        expect(await sql`select count(*)::integer count from app.audits where account_id=${ids.accountId} and event='policy.safety_paused'`).toEqual([{count:incorrectCount}]);
        expect(await sql`select count(*)::integer count from app.logical_notifications n join app.activities a on a.id=n.activity_id where a.account_id=${ids.accountId}`).toEqual([{count:incorrectCount}]);
      }finally{await client.close();}
    });
  },60_000);
  it.skipIf(!databaseUrl)('records real reports separately and verifies interrupted execution without fabricating one',async()=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const ids=await seed(sql); const client=createPostgresClient(databaseUrl??''); const store=new AgentWorkStore(client);
      try {
        const activity:AgentActivity={id:randomUUID(),userId:ids.userId,mailboxId:ids.accountId,kind:'interactive_request',sourceMessageId:null,correlationId:`activity-${randomUUID()}`,causationId:null,state:'open',revision:1,createdAt:at,updatedAt:at};
        await store.createActivity(activity);
        const run:AgentRun={id:randomUUID(),activityId:activity.id,userId:ids.userId,mailboxId:ids.accountId,sequence:1,manager:{kind:'mastra'},managerLifecycleRevision:null,assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,mode:'interactive',trigger:{kind:'interactive_request',requestId:randomUUID()},inputDigest:'a'.repeat(64),correlationId:`run-${randomUUID()}`,causationId:activity.id,state:'created',outcome:null,errorCode:null,createdAt:at,startedAt:null,completedAt:null};
        await store.createRun(run); await store.startRun(ids.userId,ids.accountId,run.id,at); await store.completeRun(ids.userId,ids.accountId,run.id,'action_requests_emitted',at);
        const makeAction=():AgentAction=>({id:randomUUID(),activityId:activity.id,runId:run.id,userId:ids.userId,mailboxId:ids.accountId,correlationId:`action-${randomUUID()}`,causationId:run.id,manager:run.manager,managerLifecycleRevision:null,mode:'interactive',assignmentId:ids.assignmentId,assignmentRevision:1,grantId:ids.grantId,grantRevision:1,safetyRevision:1,kind:'mark_read',target:{messageId:ids.messageId},authorizationRevision:1,idempotencyKey:`policy-${randomUUID()}`,attempt:1,retryOfActionId:null,state:'authorized',errorCode:null,authorizedAt:at,startedAt:null,providerReportedAt:null,completedAt:null,verification:null});
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
        const disabled=makeAction(); await store.authorizeAction(disabled); await sql`update app.accounts set state='disabled' where id=${ids.accountId}`;
        let disabledMutations=0; await expect(execute(disabled,async()=>{disabledMutations++;return {};})).resolves.toMatchObject({outcome:'paused'});
        expect(disabledMutations).toBe(0); await sql`update app.accounts set state='ready' where id=${ids.accountId}`;
        for (const pauseScope of ['owner', 'mailbox'] as const) {
          const paused = makeAction(); await store.authorizeAction(paused);
          if (pauseScope === 'owner') await sql`update app.users set autonomy_paused_at=now() where id=${ids.userId}`;
          else await sql`update app.accounts set autonomy_paused_at=now() where id=${ids.accountId}`;
          let pausedMutations = 0;
          await expect(execute(paused, async () => { pausedMutations += 1; return {}; })).resolves.toMatchObject({ outcome: 'paused' });
          expect(pausedMutations).toBe(0);
          if (pauseScope === 'owner') await sql`update app.users set autonomy_paused_at=null where id=${ids.userId}`;
          else await sql`update app.accounts set autonomy_paused_at=null where id=${ids.accountId}`;
        }
        const revoked = makeAction(); await store.authorizeAction(revoked);
        const persistence = new PostgresPolicyPersistence(client);
        const input: PolicyActionInput = { actionId: revoked.id, runId: run.id, userId: ids.userId, activityId: activity.id, decisionId: run.id, idempotencyKey: revoked.idempotencyKey, kind: 'mark_read', target: { accountId: ids.accountId, messageId: ids.messageId }, precondition: {} };
        expect((await persistence.claim(input, () => false)).run).toBe(true);
        await sql`update app.agent_capability_grants set state='revoked',revision=revision+1 where id=${ids.grantId}`;
        await expect(persistence.claimImmediatelyBeforeMutation(revoked.id, ids.accountId, () => false)).resolves.toBe('finished');
        expect(await sql`select state from app.agent_authorized_actions where id=${revoked.id}`).toEqual([{ state: 'cancelled' }]);
        expect(await sql<{source_id:string;kind:string}[]>`select source_id,kind from app.mailbox_memory_events
          where source_id in (${reported.id},${concurrent.id},${interrupted.id}) order by source_id`).toEqual(
          [reported.id,concurrent.id,interrupted.id].sort().map(source_id=>({source_id,kind:'mailbox_action_verified'})));
      } finally { await client.close(); }
    });
  }, 30_000);
});
