import { createHash } from 'node:crypto';
import type { AgentTaskErrorCode, AgentTaskResult } from '@hypermail/contracts';
import type { AgentTaskStore, ClaimedAgentTask } from '@hypermail/db';

/** Transport-neutral application protocol. HTTP/MCP adapters must authenticate a connection before calling it. */
export class ExternalAgentTaskProtocol {
 constructor(private readonly tasks:AgentTaskStore){}
 claim(connectionId:string,workerId:string,now:string):Promise<ClaimedAgentTask|null>{return this.tasks.claim({kind:'agent_connection',connectionId},workerId,now);}
 heartbeat(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string;now:string}){return this.tasks.heartbeat(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,input.now,60_000,connectionId);}
 complete(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string;result:AgentTaskResult;now:string}){return this.tasks.reportResult(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,input.result,input.now,connectionId);}
 fail(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string;errorCode:AgentTaskErrorCode;now:string}){return this.tasks.reportFailure(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,input.errorCode,input.now,connectionId);}
 answer(connectionId:string,input:{taskId:string;questionId:string;answerDigest:string;continuationRunId:string;requestId:string;requestDigest:string;now:string}){return this.tasks.answer(input.taskId,input.questionId,input.answerDigest,input.continuationRunId,input.requestId,input.requestDigest,input.now,connectionId);}
 cancel(connectionId:string,taskId:string,now:string){return this.tasks.cancel(taskId,now,connectionId);}
}
export class UnverifiableAgentTaskError extends Error {constructor(message='Provider mutation outcome cannot be verified.'){super(message);this.name='UnverifiableAgentTaskError';}}
export interface MastraAutomaticTaskExecutor { execute(claim:ClaimedAgentTask):Promise<AgentTaskResult>; }
/** Embedded Mastra uses the exact same durable protocol and never consumes external work. */
export class MastraAutomaticTaskAdapter {
 constructor(private readonly tasks:AgentTaskStore,private readonly executor:MastraAutomaticTaskExecutor,private readonly workerId:string){}
 async runOne(now:string):Promise<boolean>{const claim=await this.tasks.claim({kind:'mastra'},this.workerId,now);if(!claim)return false;const requestId=`mastra-result:${claim.runId}`;try{const result=await this.executor.execute(claim);await this.tasks.reportResult(claim.task.id,claim.task.leaseGeneration,claim.leaseToken,requestId,createHash('sha256').update(requestId).digest('hex'),result,new Date().toISOString());}catch(error){const code:AgentTaskErrorCode=error instanceof UnverifiableAgentTaskError?'UNVERIFIABLE':'INTERNAL';await this.tasks.reportFailure(claim.task.id,claim.task.leaseGeneration,claim.leaseToken,`mastra-failure:${claim.runId}`,createHash('sha256').update(`mastra-failure:${claim.runId}`).digest('hex'),code,new Date().toISOString());}return true;}
}
export class AgentTaskRecovery {constructor(private readonly tasks:AgentTaskStore,private readonly limit=100){}async recover():Promise<void>{const now=new Date().toISOString();await this.tasks.materializeBlocked(now,this.limit);await this.tasks.reconcileExpired(now,this.limit);await this.tasks.reconcileVerifiedActions(now,this.limit);}}
export class PollingTaskOutboxPublisher {constructor(private readonly tasks:AgentTaskStore,private readonly limit=100){}async recover():Promise<void>{const claim=await this.tasks.claimOutbox(this.limit);for(const row of claim.rows){const id=String(row['id']);try{await this.tasks.markOutboxPublished(id,new Date().toISOString(),claim.claimToken);}catch(error){await this.tasks.markOutboxFailed(id,claim.claimToken,error instanceof Error?error.message:'OUTBOX_PUBLISH_FAILED',new Date().toISOString());}}}}
