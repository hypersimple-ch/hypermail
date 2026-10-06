import { createHash } from 'node:crypto';
import type { MailSendProvider, ProviderSendStatus } from '@hypermail/send';
import { SendRequestFreshAuthError, SendRequestConflictError, type OwnerSendRequest, type OwnerSendScope } from './contracts.js';
import type { PostgresOwnerSendRequestRepository } from './postgres-repository.js';
export interface TenantOwnerSendProvider { providerForUser(userId:string):MailSendProvider; }
export class OwnerSendRequestService {
 constructor(private readonly repository:PostgresOwnerSendRequestRepository,private readonly provider:MailSendProvider|TenantOwnerSendProvider,private readonly now:()=>Date=()=>new Date()){}
 list(scope:OwnerSendScope){return this.repository.list(scope);} detail(scope:OwnerSendScope,id:string){return this.repository.detail(scope,id);} reject(scope:OwnerSendScope,id:string){return this.repository.reject(scope,id);}
 async begin(scope:OwnerSendScope,id:string,expected:number,confirmation:string):Promise<OwnerSendRequest>{this.fresh(scope);if('providerForUser' in this.provider)this.provider.providerForUser(scope.subjectId);await this.repository.begin(scope,id,expected,confirmation);const request=await this.repository.detail(scope,id);if(request.state==='pending_owner_approval'&&request.snapshot?.version!==expected)throw new SendRequestConflictError('Draft changed during preparation.');return request;}
 async confirm(scope:OwnerSendScope,id:string,approvalId:string,confirmation:string):Promise<OwnerSendRequest>{
  this.fresh(scope);const provider='providerForUser' in this.provider?this.provider.providerForUser(scope.subjectId):this.provider;
  const claimed=await this.repository.claim(scope,id,approvalId,confirmation);if(!('message' in claimed))return this.repository.detail(scope,id);
  const result=await provider.submit({approvalId:claimed.approvalId,idempotencyKey:claimed.idempotencyKey,...claimed.message});
  if(result.state==='rejected'){await this.repository.finish(scope,id,{kind:'failed',reason:result.reasonCode.toLowerCase()});return this.repository.detail(scope,id);}
  if(result.state==='reported')await this.repository.markReported(scope,id,result.reference?.value??'');
  await this.applyReadback(scope,id,approvalId);return this.repository.detail(scope,id);
 }
 async reconcile(scope:OwnerSendScope,id:string,approvalId:string,expectedVersion:number):Promise<OwnerSendRequest>{const current=await this.repository.reconciliationScope(scope,id,approvalId,expectedVersion);if(!['sending','unverifiable'].includes(current.state))return current;await this.applyReadback(scope,id,approvalId);return this.repository.detail(scope,id);}
 manualReview(scope:OwnerSendScope,id:string,approvalId:string,expectedVersion:number,outcome:'observed_sent'|'not_observed',note:string){return this.repository.manualReview(scope,id,approvalId,expectedVersion,outcome,note);}
 private async applyReadback(scope:OwnerSendScope,id:string,approvalId:string):Promise<void>{
  const provider='providerForUser' in this.provider?this.provider.providerForUser(scope.subjectId):this.provider;
  let status:ProviderSendStatus;try{status=await provider.status(approvalId);}catch{status={state:'unknown',reasonCode:'PROVIDER_READBACK_UNAVAILABLE'};}
  if(status.state==='verified'){const evidenceDigest=createHash('sha256').update(JSON.stringify({providerMessageId:status.providerMessageId,observedAt:status.observedAt,evidence:status.evidence})).digest('hex');await this.repository.finish(scope,id,{kind:'verified',providerMessageId:status.providerMessageId,observedAt:status.observedAt,evidenceDigest});}
  else if(status.state==='rejected')await this.repository.finish(scope,id,{kind:'failed',reason:status.reasonCode.toLowerCase()});
  else if(status.state!=='pending')await this.repository.finish(scope,id,{kind:'unverifiable',reason:(status.reasonCode??'PROVIDER_SENT_ID_UNVERIFIABLE').toLowerCase()});
 }
 private fresh(scope:OwnerSendScope):void{const at=scope.freshAuthAt?Date.parse(scope.freshAuthAt):NaN,now=this.now().getTime();if(!Number.isFinite(at)||now-at>5*60_000||at>now+60_000)throw new SendRequestFreshAuthError();}
}
