import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe,expect,it } from 'vitest';
import { PostgresDecisionPersistence } from '@hypermail/agent';
import { withPostgresSchemas } from './postgres-test.js';
const url=process.env.DATABASE_URL;
describe('question continuation PostgreSQL history',()=>{
  it.skipIf(!url)('answers by event plus continuation Run and fails closed after authority revocation',async()=>withPostgresSchemas(url??'',async seed=>{
    const user=randomUUID(),account=randomUUID(),assignment=randomUUID(),grant=randomUUID(),message=randomUUID(),activity=randomUUID(),run=randomUUID(),job=randomUUID(),decision=randomUUID(),question=randomUUID();
    await seed.begin(async tx=>{
      await tx`insert into app.users(id,email,password_hash) values(${user},${`${user}@t`},'h')`;
      await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${user},'microsoft',${account},${`${account}@t`},'ready')`;
      await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;
      await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignment},${user},${account},'mastra',true)`;
      await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grant},${user},${account},'mastra',array['mail.read']::text[],array['automatic']::text[],'active',now())`;
      await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${message},${account},'m','{"address":"s@t"}','[]',now())`;
      await tx`insert into app.activities(id,account_id,message_id,state) values(${activity},${account},${message},'waiting_question')`;
      await tx`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id,state,revision) values(${activity},${user},${account},'arrival',${message},${`arrival:${activity}`},'waiting_for_answer',2)`;
      await tx`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,outcome,created_at,started_at,completed_at) values(${run},${activity},${user},${account},1,'mastra',${assignment},1,${grant},1,1,'automatic',${tx.json({kind:'arrival',messageId:message})},${'a'.repeat(64)},${`run:${run}`},'completed','question_asked',now(),now(),now())`;
      await tx`insert into app.agent_jobs(id,activity_id,idempotency_key,state,agent_run_id) values(${job},${activity},${`job:${activity}`},'suspended',${run})`;
      await tx`insert into app.decisions(id,activity_id,attempt,state,rationale,model_provider,model_name,input_digest,output) values(${decision},${activity},1,'question','ask','test','test',${'b'.repeat(64)},${tx.json({state:'question',rationale:'ask',question:'Proceed?'})})`;
      await tx`insert into app.questions(id,activity_id,decision_id,prompt) values(${question},${activity},${decision},'Proceed?')`;
    });
    const sql=postgres(url??''); try { const persistence=new PostgresDecisionPersistence(sql);
      await expect(persistence.claimQuestion(question,'yes',user,account)).resolves.toBe('claimed');
      expect(await seed`select sequence,trigger->>'kind' as trigger,state from app.agent_runs where activity_id=${activity} order by sequence`).toEqual([{sequence:1,trigger:'arrival',state:'completed'},{sequence:2,trigger:'question_answer',state:'running'}]);
      expect(await seed`select detail->>'type' as type from app.agent_activity_events where activity_id=${activity}`).toEqual([{type:'question_answered'}]);
      await expect(persistence.claimQuestion(question,'yes',user,account)).resolves.toBe('answered');
      await expect(persistence.claimQuestion(question,'yes',randomUUID(),account)).resolves.toBe('missing');
      const decision2=randomUUID(),question2=randomUUID(); await seed`insert into app.decisions(id,activity_id,attempt,state,rationale,model_provider,model_name,input_digest,output) values(${decision2},${activity},2,'question','ask','test','test',${'c'.repeat(64)},${seed.json({state:'question',rationale:'ask',question:'Again?'})})`; await seed`insert into app.questions(id,activity_id,decision_id,prompt) values(${question2},${activity},${decision2},'Again?')`; await seed`update app.agent_capability_grants set state='revoked',revision=revision+1,updated_at=now() where id=${grant}`;
      await expect(persistence.claimQuestion(question2,'yes',user,account)).rejects.toThrow('CANONICAL_CONTINUATION_AUTHORITY_UNAVAILABLE');
      expect(await seed`select state from app.questions where id=${question2}`).toEqual([{state:'open'}]);
    } finally { await sql.end(); }
  }));
});
