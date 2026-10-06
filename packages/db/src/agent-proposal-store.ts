import { createHash } from 'node:crypto';
import { agentDecisionSchema, ownerActionCorrectionSchema, plannedActionSchema, type OwnerActionCorrection, type PlannedAction } from '@hypermail/contracts';
import type { SqlClient } from './postgres-client.js';
import { enqueueMailboxMemoryEventInTransaction, mailboxMemoryTextEvidence } from './mailbox-memory-event-store.js';
import { draftMemoryProjection } from './draft-memory-projection.js';
import { createDraftInTransaction, editDraftInTransaction } from './draft-operations.js';

type Sql = Pick<SqlClient, 'query'>;
type Row = Record<string, unknown>;
type Scope = {userId:string;accountIds:readonly string[]};
export type ProposalReviewInput = {expectedRevision:number;idempotencyKey:string;decision:'approve'|'reject'|'correct';reason?:string;correction?:OwnerActionCorrection};
export type ReviewResult = {kind:'reviewed';proposalId:string;reviewId:string;successorProposalId:string|null} | {kind:'not_found'} | {kind:'conflict';reasonCode:string} | {kind:'blocked';reasonCode:string};
export const proposalUuid = (seed:string):string => { const hex=createHash('sha256').update(seed).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`; };
const canonical = (value:unknown):string => { if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value!==null&&typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v!==undefined).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`; return JSON.stringify(value); };
const capability = (kind:string):string => ({archive:'mail.archive',move:'mail.move',recoverable_trash:'mail.trash_recoverable',draft_create:'draft.create',draft_edit:'draft.edit'} as Record<string,string>)[kind]??'';
const strings = (value:unknown):readonly string[] => Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
const payload = (row:Row):PlannedAction|OwnerActionCorrection => row['origin']==='owner'?ownerActionCorrectionSchema.parse(row['payload']):plannedActionSchema.parse(row['payload']);

export async function appendProposalEventInTransaction(sql:Sql, row:Row, detail:Row):Promise<void> {
  await sql.query(`select id from app.agent_activities where id=$1 for update`,[row['activity_id']]);
  await sql.query(`insert into app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,causation_id,occurred_at,detail) select $1,$2,$3,coalesce(max(sequence),0)+1,$4,$5,clock_timestamp(),$6::text::jsonb from app.agent_activity_events where activity_id=$1`,[row['activity_id'],row['user_id'],row['account_id'],row['correlation_id']??`proposal:${String(row['id'])}`,row['id'],JSON.stringify(detail)]);
}
export async function aggregateAgentActivityInTransaction(sql:Sql, activityId:string):Promise<void> {
  await sql.query(`select a.id from app.accounts a join app.agent_activities activity on activity.account_id=a.id where activity.id=$1 for update of a`,[activityId]);
  const locked=await sql.query(`select id,state from app.agent_activities where id=$1 for update`,[activityId]); if(!locked.rows[0]||locked.rows[0]['state']==='acknowledged') return;
  const blocked=await sql.query(`with recursive blocked_ids(id) as (select p.id from app.agent_action_proposals p join app.agent_proposal_dependencies d on d.proposal_id=p.id join app.agent_action_proposals dependency on dependency.id=d.depends_on_id left join app.agent_authorized_actions action on action.id=dependency.authorized_action_id where p.activity_id=$1 and (dependency.state in ('rejected','blocked') or action.state in ('failed','unverifiable','cancelled')) union select d.proposal_id from app.agent_proposal_dependencies d join blocked_ids b on b.id=d.depends_on_id) update app.agent_action_proposals set state='blocked',error_code='DEPENDENCY_FAILED',revision=revision+1,updated_at=now() where activity_id=$1 and state in ('waiting_review','ready') and id in(select id from blocked_ids) returning *`,[activityId]);
  for(const proposal of blocked.rows)await appendProposalEventInTransaction(sql,proposal,{type:'action_blocked',runId:proposal['run_id'],proposalId:proposal['id'],reasonCode:'DEPENDENCY_FAILED'});
  const result=await sql.query(`select
    exists(select 1 from app.agent_action_proposals where activity_id=$1 and state='waiting_review') or exists(select 1 from app.questions where activity_id=$1 and state='open') as waiting,
    exists(select 1 from app.agent_action_proposals where activity_id=$1 and state='blocked') or exists(select 1 from app.agent_authorized_actions where activity_id=$1 and state in ('failed','unverifiable','cancelled')) or exists(select 1 from app.actions where activity_id=$1 and state in ('failed','unverifiable','incorrect')) or exists(select 1 from app.agent_jobs where activity_id=$1 and state='failed') as attention,
    exists(select 1 from app.agent_action_proposals p left join app.agent_authorized_actions a on a.id=p.authorized_action_id where p.activity_id=$1 and (p.state='ready' or (p.state='authorized' and a.state is distinct from 'verified'))) or exists(select 1 from app.agent_authorized_actions where activity_id=$1 and state in ('authorized','executing','verifying')) or exists(select 1 from app.actions where activity_id=$1 and state in ('planned','executing')) or exists(select 1 from app.agent_runs where activity_id=$1 and state<>'completed') or exists(select 1 from app.agent_jobs where activity_id=$1 and state in ('pending','running','suspended')) as active`,[activityId]);
  const row=result.rows[0]; if(!row)return;
  const state=row['waiting']?'waiting_for_answer':row['attention']?'attention_required':row['active']?'open':'resolved';
  if(locked.rows[0]['state']!==state) await sql.query(`update app.agent_activities set state=$2::app.agent_activity_state,revision=revision+1,updated_at=now() where id=$1`,[activityId,state]);
  const legacy=state==='waiting_for_answer'?'waiting_question':state==='attention_required'?'failed':state==='resolved'?'handled':'new';
  await sql.query(`update app.activities set state=$2::app.activity_state,handled_at=case when $2='handled' then coalesce(handled_at,now()) else null end,version=version+1,updated_at=now() where id=$1 and state::text<>$2`,[activityId,legacy]);
}
export async function materializeDecisionInTransaction(sql:Sql, decisionId:string, threshold=0.60):Promise<void> {
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('INVALID_ACTION_CONFIDENCE_THRESHOLD');
  const found=await sql.query(`select d.*,r.correlation_id from app.decisions d join app.agent_runs r on r.id=d.run_id where d.id=$1 and d.schema_version=2 and r.state='completed' and r.outcome='action_requests_emitted'`,[decisionId]); const row=found.rows[0]; if(!row)return;
  await sql.query(`select id from app.accounts where id=$1 for update`,[row['account_id']]);
  await sql.query(`select id from app.agent_activities where id=$1 for update`,[row['activity_id']]);
  const existing=await sql.query(`select id from app.agent_action_proposals where decision_id=$1 limit 1`,[decisionId]); if(existing.rows[0])return;
  const output=agentDecisionSchema.parse(row['output']); if(output.state!=='actionable')return;
  const evidenceIds=new Set((Array.isArray(row['evidence_snapshot'])?row['evidence_snapshot']:[]).map((item:unknown)=>item!==null&&typeof item==='object'?(item as Row)['id']:undefined).filter((id:unknown):id is string=>typeof id==='string'));
  if(output.actions.some(action=>action.evidenceIds.some(id=>!evidenceIds.has(id))))throw new Error('UNKNOWN_ACTION_EVIDENCE');
  const byKey=new Map(output.actions.map(a=>[a.key,proposalUuid(`proposal:${decisionId}:${a.key}`)]));
  for(const action of output.actions){const id=byKey.get(action.key); await sql.query(`insert into app.agent_action_proposals(id,user_id,account_id,activity_id,run_id,decision_id,action_key,origin,kind,payload,confidence,threshold,evidence_snapshot,state) values($1,$2,$3,$4,$5,$6,$7,'model',$8,$9::text::jsonb,$10,$11,$12::text::jsonb,$13)`,[id,row['user_id'],row['account_id'],row['activity_id'],row['run_id'],decisionId,action.key,action.kind,JSON.stringify(action),action.confidence,threshold,JSON.stringify(row['evidence_snapshot']),action.confidence<threshold?'waiting_review':'ready']); await appendProposalEventInTransaction(sql,{...row,id},{type:'action_proposed',runId:row['run_id'],proposalId:id});}
  for(const action of output.actions)for(const key of action.dependsOn)await sql.query(`insert into app.agent_proposal_dependencies(proposal_id,depends_on_id,user_id,account_id,activity_id) values($1,$2,$3,$4,$5)`,[byKey.get(action.key),byKey.get(key),row['user_id'],row['account_id'],row['activity_id']]);
  await aggregateAgentActivityInTransaction(sql,String(row['activity_id']));
}
async function authority(sql:Sql, row:Row, kind:string):Promise<boolean> {
  const found=await sql.query(`select r.*,fg.capabilities as frozen_grant,fs.capabilities as frozen_safety,g.capabilities as current_grant,g.invocation_modes as grant_modes,g.state as grant_state,g.id as current_grant_id,g.revision as current_grant_revision,s.capabilities as current_safety,s.invocation_modes as safety_modes,s.revision as current_safety_revision,ma.id as current_assignment_id,ma.revision as current_assignment_revision,a.state as account_state from app.agent_runs r join app.accounts a on a.id=r.account_id join app.agent_capability_grant_revisions fg on fg.grant_id=r.grant_id and fg.revision=r.grant_revision join app.agent_safety_ceiling_revisions fs on fs.revision=r.safety_revision left join app.mailbox_manager_assignments ma on ma.user_id=r.user_id and ma.account_id=r.account_id left join app.agent_capability_grants g on g.user_id=r.user_id and g.account_id=r.account_id and g.manager_kind::text=r.manager_kind::text and g.agent_connection_id is not distinct from r.manager_connection_id left join app.agent_safety_ceiling s on s.singleton=true where r.id=$1`,[row['run_id']]);
  const r=found.rows[0]; if(!r)return false; const c=capability(kind);
  if(r['manager_kind']==='agent_connection'){
    const connection=await sql.query(`select state,lifecycle_revision from app.agent_connections where id=$1 and user_id=$2`,[r['manager_connection_id'],r['user_id']]);
    if(connection.rows[0]?.['state']!=='connected'||connection.rows[0]['lifecycle_revision']!==r['manager_lifecycle_revision'])return false;
  }
  return ['ready','degraded'].includes(String(r['account_state']))&&r['grant_state']==='active'&&r['current_assignment_id']===r['assignment_id']&&r['current_assignment_revision']===r['assignment_revision']&&r['current_grant_id']===r['grant_id']&&r['current_grant_revision']===r['grant_revision']&&r['current_safety_revision']===r['safety_revision']&&['frozen_grant','frozen_safety','current_grant','current_safety'].every(k=>strings(r[k]).includes(c))&&strings(r['grant_modes']).includes(String(r['mode']))&&strings(r['safety_modes']).includes(String(r['mode']));
}
async function validContext(sql:Sql,row:Row,action:OwnerActionCorrection):Promise<boolean>{
  if(action.target.accountId!==row['account_id'])return false;
  if(action.kind==='draft_edit'){const d=await sql.query(`select id from app.drafts where id=$1 and account_id=$2 and version=$3 and state in ('editing','failed')`,[action.target.draftId,row['account_id'],action.expectedVersion]); if(!d.rows[0])return false;}
  else {const m=await sql.query(`select m.id from app.messages m join app.agent_activities a on a.source_message_id=m.id where a.id=$1 and m.id=$2 and m.account_id=$3`,[row['activity_id'],action.target.messageId,row['account_id']]);if(!m.rows[0])return false;}
  if(action.kind==='move'){const f=await sql.query(`select id from app.folders where id=$1 and account_id=$2 and selectable`,[action.target.destinationFolderId,row['account_id']]);if(!f.rows[0])return false;}
  return authority(sql,row,action.kind);
}
const reviewResult=(row:Row):ReviewResult=>({kind:'reviewed',proposalId:String(row['proposal_id']),reviewId:String(row['id']),successorProposalId:row['successor_proposal_id']==null?null:row['successor_proposal_id'] as string});
export class AgentProposalStore {
  constructor(private readonly sql:SqlClient,private readonly threshold=0.60){}
  materializeDecision(decisionId:string):Promise<void>{return this.sql.transaction(sql=>materializeDecisionInTransaction(sql,decisionId,this.threshold));}
  async recoverOrphanDecisions(limit=100):Promise<void>{const result=await this.sql.query<{id:string}>(`select d.id from app.decisions d join app.agent_runs r on r.id=d.run_id where d.schema_version=2 and d.output->>'state'='actionable' and r.state='completed' and r.outcome='action_requests_emitted' and not exists(select 1 from app.agent_action_proposals p where p.decision_id=d.id) order by d.created_at,d.id limit $1`,[limit]);for(const row of result.rows)await this.materializeDecision(row.id);}
  async readyProposalIds(limit:number):Promise<readonly string[]>{const result=await this.sql.query<{id:string}>(`select p.id from app.agent_action_proposals p where p.state='ready' and not exists(select 1 from app.agent_proposal_dependencies d join app.agent_action_proposals dp on dp.id=d.depends_on_id left join app.agent_authorized_actions a on a.id=dp.authorized_action_id where d.proposal_id=p.id and a.state is distinct from 'verified') order by p.created_at,p.id limit $1`,[limit]);return result.rows.map(r=>r.id);}
  async review(scope:Scope,proposalId:string,input:ProposalReviewInput):Promise<ReviewResult>{
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<1||!input.idempotencyKey||input.idempotencyKey.length>200||(input.reason?.length??0)>2000||(input.decision==='correct')!==(input.correction!==undefined))return {kind:'blocked',reasonCode:'INVALID_REVIEW'};
    const corrected=input.correction===undefined?undefined:ownerActionCorrectionSchema.safeParse(input.correction);if(corrected&&!corrected.success)return {kind:'blocked',reasonCode:'INVALID_CORRECTION'};
    const digest=createHash('sha256').update(canonical({proposalId,...input})).digest('hex');
    return this.sql.transaction(async sql=>{
      await sql.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`,[`${scope.userId}:${input.idempotencyKey}`]);
      const replay=await sql.query(`select * from app.agent_action_reviews where user_id=$1 and idempotency_key=$2`,[scope.userId,input.idempotencyKey]); if(replay.rows[0]){if(!scope.accountIds.includes(String(replay.rows[0]['account_id'])))return {kind:'not_found'};return replay.rows[0]['request_digest']===digest?reviewResult(replay.rows[0]):{kind:'conflict',reasonCode:'IDEMPOTENCY_KEY_REUSED'};}
      await sql.query(`select a.id from app.accounts a join app.agent_action_proposals p on p.account_id=a.id where p.id=$1 and p.user_id=$2 and p.account_id=any($3::uuid[]) for update of a`,[proposalId,scope.userId,scope.accountIds]);
      await sql.query(`select a.id from app.agent_activities a join app.agent_action_proposals p on p.activity_id=a.id where p.id=$1 and p.user_id=$2 and p.account_id=any($3::uuid[]) for update of a`,[proposalId,scope.userId,scope.accountIds]);
      const found=await sql.query(`select * from app.agent_action_proposals where id=$1 and user_id=$2 and account_id=any($3::uuid[]) for update`,[proposalId,scope.userId,scope.accountIds]);const p=found.rows[0];if(!p)return {kind:'not_found'};
      if(p['revision']!==input.expectedRevision||p['state']!=='waiting_review')return {kind:'conflict',reasonCode:'PROPOSAL_REVISION_CONFLICT'};
      if(input.decision!=='reject'&&!await validContext(sql,p,corrected?.success?corrected.data:payload(p)))return {kind:'blocked',reasonCode:'TARGET_OR_CAPABILITY_FORBIDDEN'};
      const reviewId=proposalUuid(`review:${scope.userId}:${input.idempotencyKey}`);const successorId=input.decision==='correct'?proposalUuid(`successor:${reviewId}`):null;
      if(successorId&&corrected?.success){await sql.query(`insert into app.agent_action_proposals(id,user_id,account_id,activity_id,run_id,decision_id,action_key,origin,kind,payload,confidence,threshold,evidence_snapshot,state,supersedes_proposal_id) values($1,$2,$3,$4,$5,$6,$7,'owner',$8,$9::text::jsonb,null,$10,$11::text::jsonb,'ready',$12)`,[successorId,p['user_id'],p['account_id'],p['activity_id'],p['run_id'],p['decision_id'],`review_${reviewId.replaceAll('-','')}`,corrected.data.kind,JSON.stringify(corrected.data),p['threshold'],JSON.stringify(p['evidence_snapshot']),proposalId]);await sql.query(`insert into app.agent_proposal_dependencies(proposal_id,depends_on_id,user_id,account_id,activity_id) select $1,depends_on_id,user_id,account_id,activity_id from app.agent_proposal_dependencies where proposal_id=$2`,[successorId,proposalId]);await sql.query(`update app.agent_proposal_dependencies set depends_on_id=$1 where depends_on_id=$2`,[successorId,proposalId]);}
      if(successorId)await appendProposalEventInTransaction(sql,{...p,id:successorId},{type:'action_proposed',runId:p['run_id'],proposalId:successorId});
      const inserted=await sql.query(`insert into app.agent_action_reviews(id,proposal_id,user_id,account_id,decision,idempotency_key,request_digest,reason,correction,successor_proposal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10) returning *`,[reviewId,proposalId,p['user_id'],p['account_id'],input.decision,input.idempotencyKey,digest,input.reason??null,input.correction?JSON.stringify(input.correction):null,successorId]);
      await sql.query(`update app.agent_action_proposals set state=$2,revision=revision+1,updated_at=now() where id=$1`,[proposalId,input.decision==='approve'?'ready':input.decision==='reject'?'rejected':'superseded']);
      if(input.decision==='reject'){
        const descendants=await sql.query(`with recursive descendants(id) as (select proposal_id from app.agent_proposal_dependencies where depends_on_id=$1 union select d.proposal_id from app.agent_proposal_dependencies d join descendants x on x.id=d.depends_on_id) update app.agent_action_proposals set state='blocked',error_code='DEPENDENCY_REJECTED',revision=revision+1,updated_at=now() where id in(select id from descendants) and state in ('ready','waiting_review') returning *`,[proposalId]);
        for(const descendant of descendants.rows)await appendProposalEventInTransaction(sql,descendant,{type:'action_blocked',runId:descendant['run_id'],proposalId:descendant['id'],reasonCode:'DEPENDENCY_REJECTED'});
      }
      const action=corrected?.success?corrected.data:payload(p);
      const reviewRow=inserted.rows[0];if(!reviewRow)throw new Error('REVIEW_INSERT_FAILED');
      const occurredAt=reviewRow['created_at'];
      await enqueueMailboxMemoryEventInTransaction(sql,{userId:scope.userId,mailboxId:String(p['account_id']),sourceType:'action_review',sourceId:reviewId,kind:`action_${input.decision==='approve'?'approved':input.decision==='reject'?'rejected':'corrected'}`,occurredAt:occurredAt instanceof Date?occurredAt.toISOString():String(occurredAt),contentPayload:{outcome:input.decision,proposalId,kind:action.kind,target:action.target,justification:mailboxMemoryTextEvidence(action.reason,8000),ownerResponse:mailboxMemoryTextEvidence(input.reason??'',8000),...(action.kind==='draft_create'||action.kind==='draft_edit'?{draft:draftMemoryProjection(action.draft)}:{})}});
      await appendProposalEventInTransaction(sql,p,{type:'action_reviewed',runId:p['run_id'],proposalId,reviewId,decision:input.decision});await aggregateAgentActivityInTransaction(sql,String(p['activity_id']));
      return reviewResult(reviewRow);
    });
  }
  async authorizeReadyProposal(proposalId:string):Promise<string|null>{return this.sql.transaction(async sql=>{
    await sql.query(`select a.id from app.accounts a join app.agent_action_proposals p on p.account_id=a.id where p.id=$1 for update of a`,[proposalId]);
    await sql.query(`select a.id from app.agent_activities a join app.agent_action_proposals p on p.activity_id=a.id where p.id=$1 for update of a`,[proposalId]);
    const found=await sql.query(`select * from app.agent_action_proposals where id=$1 for update`,[proposalId]);const p=found.rows[0];if(!p||p['state']!=='ready')return null;
    const dependencies=await sql.query(`select d.proposal_id from app.agent_proposal_dependencies d join app.agent_action_proposals p on p.id=d.depends_on_id left join app.agent_authorized_actions a on a.id=p.authorized_action_id where d.proposal_id=$1 and a.state is distinct from 'verified'`,[proposalId]);if(dependencies.rows[0])return null;
    const action=payload(p);let error:string|null=null;if(!await authority(sql,p,action.kind))error='CAPABILITY_NOT_GRANTED';
    const paused=await sql.query(`select a.autonomy_paused_at,u.autonomy_paused_at as global_pause,ma.automatic_processing_enabled from app.accounts a join app.users u on u.id=a.user_id left join app.mailbox_manager_assignments ma on ma.user_id=a.user_id and ma.account_id=a.id where a.id=$1`,[p['account_id']]);if(paused.rows[0]?.['autonomy_paused_at']!=null||paused.rows[0]?.['global_pause']!=null)return null;
    if(paused.rows[0]?.['automatic_processing_enabled']!==true)error='CAPABILITY_NOT_GRANTED';
    let target:Record<string,unknown>={...action.target};delete target['accountId'];
    if(!error&&(action.kind==='draft_create'||action.kind==='draft_edit')){
      if(action.kind==='draft_create'){const draftId=proposalUuid(`draft:${proposalId}`);await createDraftInTransaction(sql,String(p['user_id']),{...action.draft,id:draftId,accountId:action.target.accountId,sourceMessageId:action.target.messageId,createdBy:'agent',state:'editing'});target={draftId};}
      else{const edit=await editDraftInTransaction(sql,{userId:String(p['user_id']),accountIds:[String(p['account_id'])]},action.target.draftId,action.expectedVersion,action.draft,'agent');if(edit.kind!=='updated')error='DRAFT_VERSION_CONFLICT';target={draftId:action.target.draftId};}
    }
    if(error){await sql.query(`update app.agent_action_proposals set state='blocked',error_code=$2,revision=revision+1,updated_at=now() where id=$1`,[proposalId,error]);await appendProposalEventInTransaction(sql,p,{type:'action_blocked',runId:p['run_id'],proposalId,reasonCode:error});await aggregateAgentActivityInTransaction(sql,String(p['activity_id']));return null;}
    const id=proposalUuid(`action:${proposalId}`);const key=`proposal:${proposalId}`;
    await sql.query(`insert into app.agent_authorized_actions(id,activity_id,run_id,user_id,account_id,correlation_id,causation_id,manager_kind,manager_connection_id,manager_legacy_source_id,manager_lifecycle_revision,mode,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,kind,target,authorization_revision,idempotency_key,attempt,state,authorized_at) select $1,r.activity_id,r.id,r.user_id,r.account_id,r.correlation_id,$2,r.manager_kind,r.manager_connection_id,r.manager_legacy_source_id,r.manager_lifecycle_revision,r.mode,r.assignment_id,r.assignment_revision,r.grant_id,r.grant_revision,r.safety_revision,$3,$4::text::jsonb,r.grant_revision,$5,1,'authorized',now() from app.agent_runs r where r.id=$6`,[id,p['decision_id'],action.kind,JSON.stringify(target),key,p['run_id']]);
    // Draft versions/content are fenced by validateAuthorizedProposalInTransaction, not provider facts.
    await sql.query(`insert into app.actions(id,activity_id,decision_id,kind,state,idempotency_key,target,precondition) values($1,$2,$3,$4,'planned',$5,$6::text::jsonb,'{}'::jsonb)`,[id,p['activity_id'],p['decision_id'],action.kind,key,JSON.stringify({accountId:p['account_id'],...target})]);
    await sql.query(`update app.agent_action_proposals set state='authorized',authorized_action_id=$2,revision=revision+1,updated_at=now() where id=$1`,[proposalId,id]);await appendProposalEventInTransaction(sql,p,{type:'action_authorized',runId:p['run_id'],actionId:id});await aggregateAgentActivityInTransaction(sql,String(p['activity_id']));return id;
  });}
}

export async function validateAuthorizedProposalInTransaction(sql:Sql,actionId:string):Promise<{allowed:boolean;reasonCode?:string}>{
  const result=await sql.query(`select p.*,a.target as action_target,a.kind as action_kind from app.agent_action_proposals p join app.agent_authorized_actions a on a.id=p.authorized_action_id where a.id=$1`,[actionId]);const p=result.rows[0];
  if(!p){const existing=await sql.query(`select mode from app.agent_authorized_actions where id=$1`,[actionId]);return existing.rows[0]?.['mode']==='interactive'?{allowed:true}:{allowed:false,reasonCode:'PROPOSAL_REQUIRED'};}
  const action=payload(p);if(p['state']!=='authorized'||p['action_kind']!==action.kind)return {allowed:false,reasonCode:'PROPOSAL_MISMATCH'};
  const reviews=await sql.query(`select id from app.agent_action_reviews where (proposal_id=$1 and decision='approve') or (successor_proposal_id=$1 and decision='correct')`,[p['id']]);if(!(p['origin']==='model'&&Number(p['confidence'])>=Number(p['threshold']))&&!reviews.rows[0])return {allowed:false,reasonCode:'OWNER_REVIEW_REQUIRED'};
  const dependencies=await sql.query(`select d.proposal_id from app.agent_proposal_dependencies d join app.agent_action_proposals p on p.id=d.depends_on_id left join app.agent_authorized_actions a on a.id=p.authorized_action_id where d.proposal_id=$1 and a.state is distinct from 'verified'`,[p['id']]);if(dependencies.rows[0])return {allowed:false,reasonCode:'DEPENDENCY_NOT_VERIFIED'};
  const target=p['action_target'] as Row;
  if(action.kind==='draft_create'||action.kind==='draft_edit'){
    const draftId=action.kind==='draft_create'?proposalUuid(`draft:${String(p['id'])}`):action.target.draftId;
    const d=await sql.query(`select * from app.drafts where id=$1 and account_id=$2 for update`,[draftId,p['account_id']]);const row=d.rows[0];
    if(!row||target['draftId']!==draftId||row['version']!==(action.kind==='draft_create'?1:action.expectedVersion+1)||!['editing','failed'].includes(String(row['state']))||canonical({recipients:row['recipients'],subject:row['subject'],body:row['body'],bodyFormat:row['body_format']})!==canonical(action.draft))return {allowed:false,reasonCode:'DRAFT_VERSION_CONFLICT'};
  }else {const expected:Row={...action.target};delete expected['accountId'];if(canonical(target)!==canonical(expected))return {allowed:false,reasonCode:'PROPOSAL_TARGET_MISMATCH'};}
  return {allowed:true};
}
