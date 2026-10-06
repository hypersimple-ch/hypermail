import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { AgentProposalStore, aggregateAgentActivityInTransaction } from '@hypermail/db';
import { describe,expect,it } from 'vitest';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
import { PostgresActivityRepository,type SqlClient } from '../../src/activity/postgres-repository.js';

const databaseUrl=process.env.DATABASE_URL;
const client=(sql:Sql):SqlClient=>({query:async(text,values)=>({rows:await sql.unsafe(text,values as never[])}),transaction:async work=>sql.begin(tx=>work(client(tx)))});

describe('canonical Activity PostgreSQL projection',()=>{
  it.skipIf(!databaseUrl)('projects canonical owner state/events and fences acknowledgement by revision and tenant',async()=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const userId=randomUUID(),otherUser=randomUUID(),accountId=randomUUID(),messageId=randomUUID(),activityId=randomUUID(),interactiveId=randomUUID(),assignmentId=randomUUID(),grantId=randomUUID(),runId=randomUUID(),actionId=randomUUID();
      await sql.begin(async tx=>{
        await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@test`},'h'),(${otherUser},${`${otherUser}@test`},'h')`;
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'microsoft',${accountId},${`${accountId}@test`},'ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
        await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
        await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.mark_read']::text[],array['automatic']::text[],'active',now())`;
        await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,received_at) values(${messageId},${accountId},'m','{"address":"s@test"}','[]','Canonical subject',now())`;
        await tx`insert into app.activities(id,account_id,message_id,state,version) values(${activityId},${accountId},${messageId},'new',1)`;
        await tx`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id,state,revision) values(${activityId},${userId},${accountId},'arrival',${messageId},${`arrival:${activityId}`},'resolved',3)`;
        await tx`insert into app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,occurred_at,detail) values(${activityId},${userId},${accountId},1,${`arrival:${activityId}`},now(),${tx.json({type:'no_action',runId:randomUUID(),reason:'done'})})`;
        await tx`insert into app.agent_activities(id,user_id,account_id,kind,correlation_id,state,revision) values(${interactiveId},${userId},${accountId},'interactive_request',${`interactive:${interactiveId}`},'resolved',1)`;
        await tx`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,created_at,started_at,completed_at) values(${runId},${interactiveId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${tx.json({kind:'interactive_request',requestId:interactiveId})},${'d'.repeat(64)},${`run:${runId}`},'completed','action_requests_emitted',now(),now(),now())`;
        await tx`insert into app.agent_authorized_actions(id,activity_id,run_id,user_id,account_id,correlation_id,causation_id,manager_kind,mode,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,kind,target,authorization_revision,idempotency_key,attempt,state,authorized_at,started_at,provider_reported_at,completed_at) values(${actionId},${interactiveId},${runId},${userId},${accountId},${`action:${actionId}`},${runId},'mastra','automatic',${assignmentId},1,${grantId},1,1,'mark_read',${tx.json({messageId})},1,${`action-key:${actionId}`},1,'verified',now(),now(),now(),now())`;
        await tx`insert into app.agent_action_verifications(action_id,user_id,account_id,verifier,evidence_digest,observed_at) values(${actionId},${userId},${accountId},'hypermail_provider_readback',${'e'.repeat(64)},now())`;
      });
      const repository=new PostgresActivityRepository(client(sql)); const scope={subjectId:userId,accountIds:[accountId]};
      const page=await repository.list(scope,{filter:'new',limit:10}); expect(page.items.find(item=>item.id===activityId)).toMatchObject({id:activityId,state:'handled',version:3,title:'Canonical subject'}); expect(page.items.find(item=>item.id===activityId)?.timeline[0]?.label).toBe('agent.no_action');
      expect(page.items.find(item=>item.id===interactiveId)).toMatchObject({messageId:null,title:'Interactive request',state:'handled'});
      const detail=await repository.get(scope,interactiveId); expect(detail?.runs).toHaveLength(1); expect(detail?.runs[0]).toMatchObject({id:runId,sequence:1,assignmentRevision:1,grantRevision:1,safetyRevision:1}); expect(detail?.actions).toHaveLength(1); expect(detail?.actions[0]).toMatchObject({id:actionId,runId,state:'verified'}); expect(detail?.actions[0]?.verification?.verifier).toBe('hypermail_provider_readback');
      await expect(repository.get({subjectId:otherUser,accountIds:[accountId]},interactiveId)).resolves.toBeNull();
      await expect(repository.acknowledge(scope,activityId,2)).resolves.toEqual({kind:'conflict',currentVersion:3});
      await expect(repository.acknowledge({subjectId:otherUser,accountIds:[accountId]},activityId,3)).resolves.toEqual({kind:'not_found'});
      await expect(repository.acknowledge(scope,activityId,3)).resolves.toMatchObject({kind:'updated',activity:{state:'acknowledged',version:4}});
      expect(await sql`select count(*)::integer as count from app.audits where actor_type='user' and metadata->>'canonicalActivityId'=${activityId}`).toEqual([{count:0}]);
      await expect(repository.acknowledge(scope,interactiveId,1)).resolves.toMatchObject({kind:'updated',activity:{state:'acknowledged',version:2}});
      expect(await sql`select count(*)::integer as count from app.audits where actor_type='user' and correlation_id=${`activity:${interactiveId}`}`).toEqual([{count:1}]);
    });
  });
  it.skipIf(!databaseUrl)('keeps review and dependency failures visible and resolves only after every item is finished',async()=>{
    await withPostgresSchemas(databaseUrl??'',async sql=>{
      const userId=randomUUID(),accountId=randomUUID(),assignmentId=randomUUID(),grantId=randomUUID();
      await sql`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@test`},'h')`;
      await sql.begin(async tx=>{
        await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'gmail',${accountId},'aggregation@test','ready')`;
        await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
      });
      await sql`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
      await sql`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'mastra',array['mail.archive','draft.create'],array['automatic'],'active',now())`;
      const adapter=client(sql),store=new AgentProposalStore(adapter),repository=new PostgresActivityRepository(adapter),scope={subjectId:userId,accountIds:[accountId]};
      const seed=async(dependent=false)=>{
        const messageId=randomUUID(),activityId=randomUUID(),runId=randomUUID(),decisionId=randomUUID();
        await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${messageId},${accountId},${messageId},'{"address":"s@test"}','[]',now())`;
        await sql`insert into app.activities(id,account_id,message_id) values(${activityId},${accountId},${messageId})`;
        await sql`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id) values(${activityId},${userId},${accountId},'arrival',${messageId},${activityId})`;
        await sql`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,started_at,completed_at) values(${runId},${activityId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic','{"kind":"arrival"}',${'a'.repeat(64)},${runId},'completed','action_requests_emitted',now(),now())`;
        const actions=[{key:'classify',kind:'archive',target:{accountId,messageId},confidence:0.4,reason:'Ask first',evidenceIds:[],dependsOn:[]},...(dependent?[{key:'reply',kind:'draft_create',target:{accountId,messageId},confidence:0.9,reason:'After classification',evidenceIds:[],dependsOn:['classify'],draft:{recipients:[{kind:'to',address:'r@test.example'}],subject:'Reply',body:'Body',bodyFormat:'markdown'}}]:[])];
        await sql`insert into app.decisions(id,activity_id,user_id,account_id,run_id,schema_version,attempt,state,rationale,model_provider,model_name,input_digest,output) values(${decisionId},${activityId},${userId},${accountId},${runId},2,1,'actionable','test','test','test','digest',${sql.json({schemaVersion:2,state:'actionable',rationale:'test',actions})})`;
        await store.materializeDecision(decisionId);
        const proposals=await repository.get(scope,activityId);
        const proposal=proposals?.proposals?.find(p=>p.kind==='archive');
        if(!proposal)throw new Error('Missing review proposal');
        return {activityId,proposal};
      };
      const pending=await seed();
      const waiting=await repository.get(scope,pending.activityId);
      expect(waiting?.state).toBe('waiting_question');
      expect(await repository.acknowledge(scope,pending.activityId,waiting?.version??0)).toMatchObject({kind:'blocked'});
      await expect(sql`update app.agent_activities set state='resolved',revision=revision+1 where id=${pending.activityId}`).rejects.toThrow('unresolved work');
      await expect(sql`update app.agent_activities set state='acknowledged',revision=revision+1 where id=${pending.activityId}`).rejects.toThrow();
      await store.review({userId,accountIds:[accountId]},pending.proposal.id,{expectedRevision:1,idempotencyKey:randomUUID(),decision:'reject'});
      const rejected=await repository.get(scope,pending.activityId);
      expect(rejected).toMatchObject({state:'handled',proposals:[{state:'rejected'}]});
      expect(await repository.acknowledge(scope,pending.activityId,rejected?.version??0)).toMatchObject({kind:'updated',activity:{state:'acknowledged'}});

      const dependency=await seed(true);
      await store.review({userId,accountIds:[accountId]},dependency.proposal.id,{expectedRevision:1,idempotencyKey:randomUUID(),decision:'reject'});
      const blocked=await repository.get(scope,dependency.activityId);
      expect(blocked?.state).toBe('failed');
      expect(await repository.requestRetry(scope,dependency.activityId,blocked?.version??0)).toMatchObject({kind:'blocked'});
      expect(blocked?.proposals?.find(proposal => proposal.kind === 'draft_create')?.state).toBe('blocked');
      await expect(sql`update app.agent_activities set state='resolved',revision=revision+1 where id=${dependency.activityId}`).rejects.toThrow('unresolved work');

      const failed=await seed();
      await store.review({userId,accountIds:[accountId]},failed.proposal.id,{expectedRevision:1,idempotencyKey:randomUUID(),decision:'approve'});
      const actionId=await store.authorizeReadyProposal(failed.proposal.id);
      if(!actionId)throw new Error('Missing authorized action');
      await sql`update app.agent_authorized_actions set state='failed',error_code='PROVIDER_FAILURE',completed_at=now() where id=${actionId}`;
      await adapter.transaction(tx=>aggregateAgentActivityInTransaction(tx,failed.activityId));
      const verified=await seed();
      await store.review({userId,accountIds:[accountId]},verified.proposal.id,{expectedRevision:1,idempotencyKey:randomUUID(),decision:'approve'});
      const verifiedAction=await store.authorizeReadyProposal(verified.proposal.id);
      if(!verifiedAction)throw new Error('Missing action to verify');
      const inProgress=await repository.get(scope,verified.activityId);
      expect(await repository.acknowledge(scope,verified.activityId,inProgress?.version??0)).toMatchObject({kind:'blocked'});
      await sql.begin(async tx=>{
        await tx`update app.agent_authorized_actions set state='executing',started_at=now() where id=${verifiedAction}`;
        await tx`update app.agent_authorized_actions set state='verified',completed_at=now() where id=${verifiedAction}`;
        await tx`insert into app.agent_action_verifications(action_id,user_id,account_id,verifier,evidence_digest,observed_at) values(${verifiedAction},${userId},${accountId},'hypermail_provider_readback',${'e'.repeat(64)},now())`;
        await tx`update app.actions set state='succeeded',finished_at=now() where id=${verifiedAction}`;
        await aggregateAgentActivityInTransaction(client(tx),verified.activityId);
      });
      const completed=await repository.get(scope,verified.activityId);
      expect(completed).toMatchObject({state:'handled',actions:[{state:'verified'}],proposals:[{state:'authorized',action:{state:'verified'}}]});
      expect(await repository.acknowledge(scope,verified.activityId,completed?.version??0)).toMatchObject({kind:'updated',activity:{state:'acknowledged'}});

      expect(await repository.get(scope,failed.activityId)).toMatchObject({state:'failed'});
      await expect(sql`update app.agent_activities set state='acknowledged',revision=revision+1 where id=${failed.activityId}`).rejects.toThrow('unresolved work');

      const emptyId=randomUUID();
      await sql`insert into app.agent_activities(id,user_id,account_id,kind,correlation_id,state) values(${emptyId},${userId},${accountId},'interactive_request',${emptyId},'waiting_for_answer')`;
      const noActionRun=randomUUID();
      await sql`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,started_at,completed_at) values(${noActionRun},${emptyId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${sql.json({kind:'interactive_request',requestId:emptyId})},${'a'.repeat(64)},${noActionRun},'completed','no_action',now(),now())`;
      await adapter.transaction(tx=>aggregateAgentActivityInTransaction(tx,emptyId));
      expect(await repository.get(scope,emptyId)).toMatchObject({state:'handled'});
      const outstandingRun=randomUUID();
      await sql`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state) values(${outstandingRun},${emptyId},${userId},${accountId},2,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${sql.json({kind:'interactive_request',requestId:emptyId})},${'a'.repeat(64)},${outstandingRun},'created')`;
      const stale=await repository.get(scope,emptyId);
      expect(stale?.state).toBe('handled');
      expect(await repository.acknowledge(scope,emptyId,stale?.version??0)).toMatchObject({kind:'blocked'});
      await expect(sql`update app.agent_activities set state='acknowledged',revision=revision+1 where id=${emptyId}`).rejects.toThrow('unresolved work');
    });
  });
});
