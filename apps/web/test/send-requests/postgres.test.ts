import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe,expect,it,vi } from 'vitest';
import { IntegratedApprovedSendProvider, type SendSql, type ProviderSendStatus } from '@hypermail/send';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
import { PostgresOwnerSendApprovalRequests,type TenantAuthority } from '../../src/mcp/index.js';
import { OwnerSendRequestService,PostgresOwnerSendRequestRepository,SendRequestNotFoundError } from '../../src/send-requests/index.js';
import { PostgresLifecycleStore } from '../../../worker/src/lifecycle/postgres-store.js';
import type { SqlClient as WorkerSqlClient } from '../../../worker/src/postgres-store.js';
import { DraftService, PostgresDraftRepository, hashSendConfirmation } from '../../src/drafts/index.js';
import type { SqlClient, SqlRow } from '../../src/activity/postgres-repository.js';
const url=process.env['DATABASE_URL']??'';
async function seed(sql:Sql){
 const userId=randomUUID(),accountId=randomUUID(),connectionId=randomUUID(),assignmentId=randomUUID(),grantId=randomUUID(),draftId=randomUUID(),sessionId=randomUUID();const now=new Date();
 await sql.begin(async tx=>{
  await tx`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
  await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${accountId},${userId},'microsoft',${accountId},${`${accountId}@example.test`},'ready')`;
  await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
  await tx`insert into app.sessions(id,user_id,token_hash,created_at,expires_at) values(${sessionId},${userId},${randomUUID()},${now}::timestamptz+interval '321 microseconds',${new Date(now.getTime()+3600000)})`;
  await tx`insert into app.agent_connections(id,user_id,adapter,external_profile_id,display_name,state,verified_at) values(${connectionId},${userId},'test','profile','Agent','connected',now())`;
  await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,agent_connection_id) values(${assignmentId},${userId},${accountId},'agent_connection',${connectionId})`;
  await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,agent_connection_id,capabilities,invocation_modes,state,approved_at) values(${grantId},${userId},${accountId},'agent_connection',${connectionId},array['send.request']::text[],array['interactive']::text[],'active',now())`;
  await tx`insert into app.drafts(id,account_id,created_by,state,recipients,subject,body,body_format,version) values(${draftId},${accountId},'agent','editing','[{"kind":"to","address":"to@example.test"}]'::jsonb,'subject','body','markdown',1)`;
 });
 const authority:TenantAuthority={authorizationDecisionId:randomUUID(),credentialId:'digest',userId,connectionId,mailboxId:accountId,mode:'interactive',lifecycleRevision:1,assignmentRevision:1,grantRevision:1,safetyRevision:1};
 const pending=await new PostgresOwnerSendApprovalRequests(sql,()=>Promise.resolve(true)).requestPending(authority,{draftId,expectedVersion:1});
 const scope={subjectId:userId,accountIds:[accountId],freshAuthAt:now.toISOString(),sessionId};
 const adapter:SendSql={query:async(query,parameters)=>({rows:await sql.unsafe(query,parameters as never) as Record<string,unknown>[]})};
 return {userId,accountId,draftId,sessionId,now,pending,scope,adapter,authority};
}
describe.skipIf(!url)('durable owner send submissions PostgreSQL',{timeout:30_000},()=>{
 it('settles an expired undispatched owner request and fences a submit paused before its dispatch CAS',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql),repository=new PostgresOwnerSendRequestRepository(sql,()=>f.now),confirmation='p'.repeat(16);
  const begun=await repository.begin(f.scope,f.pending.requestId,1,confirmation);if(!begun.approvalId)throw new Error('approval missing');
  const claim=await repository.claim(f.scope,f.pending.requestId,begun.approvalId,confirmation);if(!('message' in claim))throw new Error('claim missing');
  const submit=vi.fn(),verify=vi.fn();
  const provider=new IntegratedApprovedSendProvider(f.adapter,f.userId,{submit,verify});
  const service=new OwnerSendRequestService(repository,provider,()=>f.now);
  expect((await service.reconcile(f.scope,f.pending.requestId,begun.approvalId,1)).state).toBe('sending');
  // Pause a genuine stale submit after loading its approved snapshot, before the CAS.
  let loaded!:()=>void;const loadedPromise=new Promise<void>(resolve=>{loaded=resolve;});
  let resume!:()=>void;const resumePromise=new Promise<void>(resolve=>{resume=resolve;});
  const delayedAdapter:SendSql={query:async(query,parameters)=>{
   const result=await f.adapter.query(query,parameters);
   if(query.startsWith('SELECT s.*,a.email')){loaded();await resumePromise;}
   return result;
  }};
  const delayed=new IntegratedApprovedSendProvider(delayedAdapter,f.userId,{submit,verify});
  const stale=delayed.submit({approvalId:begun.approvalId,idempotencyKey:claim.idempotencyKey,...claim.message});
  await loadedPromise;
  await sql`update app.send_approvals set expires_at=now()-interval '1 second' where id=${begun.approvalId}`;
  const result=await service.reconcile(f.scope,f.pending.requestId,begun.approvalId,1);
  expect(result).toMatchObject({state:'failed',reasonCode:'approval_expired_undispatched',snapshot:{state:'failed',version:2},submission:{state:'rejected',reasonCode:'APPROVAL_EXPIRED_UNDISPATCHED',dispatchMayHaveOccurred:false}});
  resume();expect(await stale).toMatchObject({state:'unknown',reasonCode:'SUBMISSION_ALREADY_CLAIMED'});
  expect(submit).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  expect((await sql`select state,started_at from app.approved_send_submissions where approval_id=${begun.approvalId}`)[0]).toMatchObject({state:'rejected',started_at:null});
  expect(await sql`select state,consumed_at is not null consumed from app.send_approvals where id=${begun.approvalId}`).toEqual([{state:'consumed',consumed:true}]);
  expect((await sql`select a.state,a.error_code,r.state run_state,r.outcome from app.agent_authorized_actions a join app.agent_runs r on r.id=a.run_id where a.id=${result.actionId}`)[0]).toMatchObject({state:'failed',error_code:'approval_expired_undispatched',run_state:'completed',outcome:'failed'});
 }));
 it('releases an ordinary draft after the real confirmation claim crashes before submit',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql);
  const client=(connection:Sql):SqlClient=>({
   // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- required by SqlClient.
   query:async<Row extends SqlRow=SqlRow>(query:string,parameters?:readonly unknown[])=>({rows:await connection.unsafe(query,parameters as never) as readonly Row[]}),
   transaction:async<T>(work:(transaction:SqlClient)=>Promise<T>)=>connection.begin(tx=>work(client(tx))),
  });
  const repository=new PostgresDraftRepository(client(sql)),submit=vi.fn(),verify=vi.fn();
  const provider=new IntegratedApprovedSendProvider(f.adapter,f.userId,{submit,verify});
  const service=new DraftService(repository,provider,{read:()=>Promise.resolve(null)},()=>f.now);
  const draft=await service.createUser(f.scope,{accountId:f.accountId,recipients:[{kind:'to',address:'to@example.test'}],subject:'ordinary',body:'approved body',bodyFormat:'markdown'});
  const confirmation='o'.repeat(16),approved=await service.beginApproval(f.scope,draft.id,1,confirmation);
  expect(await repository.claimApproval(f.scope,approved.approvalId,hashSendConfirmation(approved.approvalId,confirmation),f.now.toISOString())).toMatchObject({kind:'claimed'});
  await expect(sql`update app.approved_send_submissions set state='rejected',error_code='APPROVAL_EXPIRED_UNDISPATCHED',finished_at=now(),version=version+1 where approval_id=${approved.approvalId}`).rejects.toThrow('submission cannot be resent');
  expect(await service.reconcile(f.scope,draft.id,approved.approvalId,1)).toMatchObject({state:'sending'});
  await sql`update app.send_approvals set expires_at=now()-interval '1 second' where id=${approved.approvalId}`;
  const failed=await service.reconcile(f.scope,draft.id,approved.approvalId,1);
  expect(failed).toMatchObject({state:'failed',version:2,submission:{state:'rejected',reasonCode:'APPROVAL_EXPIRED_UNDISPATCHED',dispatchMayHaveOccurred:false}});
  expect(await provider.status(approved.approvalId)).toEqual({state:'rejected',reasonCode:'APPROVAL_EXPIRED_UNDISPATCHED',dispatchMayHaveOccurred:false});
  expect(submit).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  const next=await service.beginApproval(f.scope,draft.id,2,'n'.repeat(16));
  expect(next.approvalId).not.toBe(approved.approvalId);
  expect(await sql`select state,consumed_at is not null consumed from app.send_approvals where id=${approved.approvalId}`).toEqual([{state:'consumed',consumed:true}]);
 }));
 it('commits one dispatch before I/O, preserves ambiguity across restart, and keeps manual review separate',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql),repository=new PostgresOwnerSendRequestRepository(sql,()=>f.now),confirmation='c'.repeat(16);
  const begun=await repository.begin(f.scope,f.pending.requestId,1,confirmation);if(!begun.approvalId)throw new Error('approval missing');
  const submit=vi.fn(async()=>{const row=(await sql`select state from app.approved_send_submissions where approval_id=${begun.approvalId}`)[0];expect(row?.['state']).toBe('dispatching');return {state:'reported' as const,reference:{kind:'native_id' as const,value:'exact-provider-id'}};});
  let status:ProviderSendStatus={state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'};
  const verify=vi.fn(()=>Promise.resolve(status));const provider=new IntegratedApprovedSendProvider(f.adapter,f.userId,{submit,verify});
  const service=new OwnerSendRequestService(repository,provider,()=>f.now);
  await Promise.all([service.confirm(f.scope,f.pending.requestId,begun.approvalId,confirmation),service.confirm(f.scope,f.pending.requestId,begun.approvalId,confirmation)]);
  expect(submit).toHaveBeenCalledOnce();expect((await repository.detail(f.scope,f.pending.requestId)).state).toBe('unverifiable');
  expect((await sql`select state,provider_reference_type,provider_message_id from app.approved_send_submissions where approval_id=${begun.approvalId}`)[0]).toMatchObject({state:'unknown',provider_reference_type:'native_id',provider_message_id:'exact-provider-id'});
  const restarted=new OwnerSendRequestService(repository,new IntegratedApprovedSendProvider(f.adapter,f.userId,{submit,verify}),()=>f.now);
  await restarted.reconcile(f.scope,f.pending.requestId,begun.approvalId,1);expect(submit).toHaveBeenCalledOnce();
  await restarted.manualReview(f.scope,f.pending.requestId,begun.approvalId,1,'observed_sent','Checked my provider UI');
  const reviewed=await repository.detail(f.scope,f.pending.requestId);expect(reviewed.submission).toMatchObject({state:'unknown',manualReview:{outcome:'observed_sent'}});expect(reviewed.state).toBe('unverifiable');
  await expect(restarted.reconcile(f.scope,f.pending.requestId,begun.approvalId,2)).rejects.toThrow('stale');
  await expect(repository.detail({subjectId:randomUUID(),accountIds:[f.accountId]},f.pending.requestId)).rejects.toBeInstanceOf(SendRequestNotFoundError);
  status={state:'verified',providerMessageId:'exact-provider-id',observedAt:new Date().toISOString(),evidence:{folderId:'sentitems',reference:'exact-provider-id'}};
  expect((await restarted.reconcile(f.scope,f.pending.requestId,begun.approvalId,1)).state).toBe('approved');expect(submit).toHaveBeenCalledOnce();
  expect((await sql`select * from app.agent_action_verifications where action_id=(select action_id from app.public_mcp_send_requests where id=${f.pending.requestId})`).length).toBe(1);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- WorkerSqlClient requires a generic query port.
  const workerSql:WorkerSqlClient={query:async<Row extends Record<string,unknown>>(query:string,parameters?:readonly unknown[])=>({rows:await sql.unsafe(query,parameters as never) as Row[]}),transaction:async work=>work(workerSql)};
  const future=new Date(Date.now()+91*86400000);
  expect(await new PostgresLifecycleStore(workerSql).purgeCachedBodies(new Date(future.getTime()-90*86400000),future,10)).toBe(1);
  const [retained]=await sql<{payload:null;state:string;request_digest:string}[]>`select payload,state,request_digest from app.approved_send_submissions where approval_id=${begun.approvalId}`;
  expect(retained).toMatchObject({payload:null,state:'verified'});expect(retained?.request_digest).toMatch(/^[a-f0-9]{64}$/);
  const checks=verify.mock.calls.length;
  expect(await provider.status(begun.approvalId)).toMatchObject({state:'verified',providerMessageId:'exact-provider-id'});expect(verify.mock.calls).toHaveLength(checks);
 }));
 it('never dispatches a stranded dispatching approval again',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql),repository=new PostgresOwnerSendRequestRepository(sql,()=>f.now),confirmation='d'.repeat(16);
  const begun=await repository.begin(f.scope,f.pending.requestId,1,confirmation);if(!begun.approvalId)throw new Error('approval missing');
  const claim=await repository.claim(f.scope,f.pending.requestId,begun.approvalId,confirmation);if(!('message' in claim))throw new Error('claim missing');
  await sql`update app.approved_send_submissions set state='dispatching',started_at=now()-interval '3 minutes',version=version+1 where approval_id=${begun.approvalId}`;
  await sql`update app.send_approvals set expires_at=now()-interval '1 second' where id=${begun.approvalId}`;
  const submit=vi.fn(),verify=vi.fn();const provider=new IntegratedApprovedSendProvider(f.adapter,f.userId,{submit,verify});
  expect(await provider.submit({approvalId:begun.approvalId,idempotencyKey:claim.idempotencyKey,...claim.message})).toMatchObject({state:'unknown'});
  expect(await provider.status(begun.approvalId)).toMatchObject({state:'unknown'});expect(submit).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  expect((await sql`select state from app.approved_send_submissions where approval_id=${begun.approvalId}`)[0]?.['state']).toBe('unknown');
  expect((await repository.detail(f.scope,f.pending.requestId)).submission).toMatchObject({state:'unknown',dispatchMayHaveOccurred:true});
 }));
 it('revoked sessions and changed draft versions cannot consume approvals',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql),repository=new PostgresOwnerSendRequestRepository(sql,()=>f.now),confirmation='e'.repeat(16);
  const begun=await repository.begin(f.scope,f.pending.requestId,1,confirmation);if(!begun.approvalId)throw new Error('approval missing');
  await sql`update app.sessions set revoked_at=now() where id=${f.sessionId}`;
  await expect(repository.claim(f.scope,f.pending.requestId,begun.approvalId,confirmation)).rejects.toThrow('Recent authentication');
  expect((await sql`select count(*)::int n from app.approved_send_submissions`)[0]?.['n']).toBe(0);
  const second=await seed(sql),secondRepository=new PostgresOwnerSendRequestRepository(sql,()=>second.now);
  const approved=await secondRepository.begin(second.scope,second.pending.requestId,1,confirmation);if(!approved.approvalId)throw new Error('approval missing');
  await sql`update app.drafts set version=2,body='Edited after preparation' where id=${second.draftId}`;
  await expect(secondRepository.claim(second.scope,second.pending.requestId,approved.approvalId,confirmation)).rejects.toThrow('Draft changed');
  expect((await sql`select count(*)::int n from app.approved_send_submissions`)[0]?.['n']).toBe(0);
 }));
 it('retains bounded rejection context without submitting or changing source content',async()=>withPostgresSchemas(url,async sql=>{
  const f=await seed(sql),repository=new PostgresOwnerSendRequestRepository(sql,()=>f.now);
  const body=`<p>${'\u0001'.repeat(1_999_993)}</p>`;
  await sql`update app.drafts set body=${body},body_format='html' where id=${f.draftId}`;
  expect((await repository.reject(f.scope,f.pending.requestId)).state).toBe('rejected');
  expect((await repository.reject(f.scope,f.pending.requestId)).state).toBe('rejected');
  const rows=await sql`select kind,octet_length(content_payload::text) payload_bytes from app.mailbox_memory_events where source_id=${f.pending.requestId}`;
  expect(rows).toMatchObject([{kind:'send_owner_rejected'}]);expect(Number(rows[0]?.['payload_bytes'])).toBeLessThanOrEqual(64*1024);
  expect((await sql`select body from app.drafts where id=${f.draftId}`)[0]?.['body']).toBe(body);
  expect((await sql`select count(*)::int n from app.approved_send_submissions`)[0]?.['n']).toBe(0);
 }));
});
