import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe,expect,it } from 'vitest';
import { PostgresDecisionPersistence, attemptId, type OutcomePersistence } from '@hypermail/agent';
import { createPostgresClient } from '@hypermail/db';
import { PostgresAgentJobStore } from '../src/production.js';
import { withPostgresSchemas } from './postgres-test.js';
const url=process.env.DATABASE_URL;
describe('question continuation PostgreSQL history',()=>{
  it.skipIf(!url)('answers by event plus continuation Run and fails closed after authority revocation',async()=>withPostgresSchemas(url??'',async seed=>{
    const user=randomUUID(),account=randomUUID(),assignment=randomUUID(),grant=randomUUID(),message=randomUUID(),activity=randomUUID(),run=randomUUID(),job=randomUUID(),decision=randomUUID(),question=randomUUID();
    await seed.begin(async tx=>{
      await tx`insert into app.users(id,email,password_hash) values(${user},${`${user}@example.test`},'h')`;
      await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${user},'microsoft',${account},${`${account}@example.test`},'ready')`;
      await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;
      await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignment},${user},${account},'mastra',true)`;
      await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grant},${user},${account},'mastra',array['mail.read']::text[],array['automatic']::text[],'active',now())`;
      await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${message},${account},'m','{"address":"sender@example.test"}','[]',now())`;
      await tx`insert into app.activities(id,account_id,message_id,state) values(${activity},${account},${message},'waiting_question')`;
      await tx`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id,state,revision) values(${activity},${user},${account},'arrival',${message},${`arrival:${activity}`},'waiting_for_answer',2)`;
      await tx`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,created_at,started_at,completed_at) values(${run},${activity},${user},${account},1,'mastra',${assignment},1,${grant},1,1,'automatic',${tx.json({kind:'arrival',messageId:message})},${'a'.repeat(64)},${`run:${run}`},'completed','question_asked',now(),now(),now())`;
      await tx`insert into app.agent_jobs(id,activity_id,idempotency_key,state,agent_run_id) values(${job},${activity},${`job:${activity}`},'suspended',${run})`;
      const output = {schemaVersion:2,state:'question',rationale:'ask',question:'Proceed?'};
      await tx`insert into app.decisions(id,activity_id,user_id,account_id,run_id,schema_version,evidence_snapshot,attempt,state,rationale,model_provider,model_name,input_digest,output) values(${decision},${activity},${user},${account},${run},2,'[]',1,'question','ask','test','test',${'b'.repeat(64)},${tx.json(output)})`;
      await tx`insert into app.questions(id,activity_id,decision_id,prompt) values(${question},${activity},${decision},'Proceed?')`;
    });
    const managed = createPostgresClient(url??'');
    try {
      const inputStore = new PostgresAgentJobStore(managed,90,{retryBaseDelaySeconds:5,retryMaximumDelaySeconds:900,claimLeaseSeconds:60,schedulerIntervalSeconds:5});
      const scopedJob = {id:job,activityId:activity,userId:user,accountId:account,accountEmail:`${account}@example.test`,messageId:message,providerMessageId:'m',sender:'sender@example.test',subject:'Mail',receivedAt:new Date(),attachments:[],attempt:1,runId:run};
      const relevantDraftIds: string[] = [];
      for(let index=0;index<25;index++) {
        const draftId=randomUUID(); relevantDraftIds.push(draftId);
        await seed`insert into app.drafts(id,account_id,source_message_id,created_by,state,recipients,subject,body,body_format,updated_at)
          values(${draftId},${account},${message},'user','editing','[{"kind":"to","address":"owner@example.test"}]',${`Reply ${String(index)}`},${`Body ${String(index)}`},'markdown',${new Date(1700000000000+index*1000)})`;
      }
      await seed`insert into app.drafts(account_id,created_by,state,recipients,subject,body) values(${account},'user','editing','[{"kind":"to","address":"owner@example.test"}]','Unrelated','Private')`;
      const first = await inputStore.contextualInputs(scopedJob,[{id:'provider-work',displayName:'Work'}]);
      expect(first.availableDrafts.map(draft=>draft.id)).toEqual(relevantDraftIds.slice(5).reverse());
      const newest=first.availableDrafts[0];
      expect(newest).toMatchObject({version:1,subject:'Reply 24',body:'Body 24',bodyFormat:'markdown'});
      const refreshed = await inputStore.contextualInputs(scopedJob,[{id:'provider-work',displayName:'Renamed'}]);
      expect(refreshed.availableFolders).toEqual([{id:first.availableFolders[0]?.id,displayName:'Renamed'}]);
      expect(await seed`select id from app.activities where account_id=${account}`).toEqual([{id:activity}]);
    } finally { await managed.close(); }
    const sql=postgres(url??''); try { const persistence=new PostgresDecisionPersistence(sql);
      await expect(persistence.claimQuestion(question,'yes',user,account)).resolves.toBe('claimed');
      expect(await seed`select sequence,trigger->>'kind' as trigger,state from app.agent_runs where activity_id=${activity} order by sequence`).toEqual([{sequence:1,trigger:'arrival',state:'completed'},{sequence:2,trigger:'question_answer',state:'running'}]);
      expect(await seed`select detail->>'type' as type from app.agent_activity_events where activity_id=${activity}`).toEqual([{type:'question_answered'}]);
      await expect(persistence.claimQuestion(question,'yes',user,account)).resolves.toBe('answered');
      await expect(persistence.claimQuestion(question,'yes',randomUUID(),account)).resolves.toBe('missing');
      const [continuation] = await seed<{id:string}[]>`select id from app.agent_runs where activity_id=${activity} and sequence=2`;
      if (!continuation) throw new Error('CONTINUATION_MISSING');
      const historical: OutcomePersistence = {
        decision:{id:decision,activityId:activity,attempt:1,runId:run,decision:{schemaVersion:2,state:'question',rationale:'ask',question:'Proceed?'},output:{schemaVersion:2,state:'question',rationale:'ask',question:'Proceed?'},evidenceSnapshot:[],modelProvider:'test',modelName:'test',inputDigest:'b'.repeat(64)},
        activityState:'waiting_question',jobState:'suspended',
      };
      await persistence.persistOutcome(historical);
      expect(await seed`select state from app.agent_runs where id=${continuation.id}`).toEqual([{state:'running'}]);
      expect(await seed`select state,agent_run_id from app.agent_jobs where id=${job}`).toEqual([{state:'running',agent_run_id:continuation.id}]);
      const decision2=attemptId(activity,2,'decision'),question2=attemptId(activity,2,'question');
      const output2 = {schemaVersion:2 as const,state:'question' as const,rationale:'ask',question:'Again?'};
      const evidenceSnapshot = [{id:`instruction:${message}`,provenance:'user' as const,scope:'mailbox' as const,text:'yes'}];
      const outcome: OutcomePersistence = {
        decision:{id:decision2,activityId:activity,attempt:2,runId:continuation.id,decision:output2,output:output2,evidenceSnapshot,modelProvider:'test',modelName:'test',inputDigest:'c'.repeat(64)},
        question:{id:question2,activityId:activity,decisionId:decision2,prompt:'Again?'},activityState:'waiting_question',jobState:'suspended',
      };
      const [first,replay] = await Promise.all([persistence.persistOutcome(outcome),persistence.persistOutcome(outcome)]);
      expect(first).toEqual(output2); expect(replay).toEqual(first);
      expect(await seed`select run_id,evidence_snapshot,schema_version from app.decisions where id=${decision2}`).toEqual([{run_id:continuation.id,evidence_snapshot:evidenceSnapshot,schema_version:2}]);
      expect(await seed`select id from app.questions where id=${question2}`).toEqual([{id:question2}]);
      await expect(persistence.persistOutcome({...outcome,decision:{...outcome.decision,inputDigest:'d'.repeat(64)}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await seed`update app.agent_capability_grants set state='revoked',revision=revision+1,updated_at=now() where id=${grant}`;
      await expect(persistence.claimQuestion(question2,'yes',user,account)).rejects.toThrow('CANONICAL_CONTINUATION_AUTHORITY_UNAVAILABLE');
      expect(await seed`select state from app.questions where id=${question2}`).toEqual([{state:'open'}]);
    } finally { await sql.end(); }
  }), 30_000);
});
