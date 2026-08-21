import { createHash } from 'node:crypto';
import type { AgentTaskErrorCode, AgentTaskResult } from '@hypermail/contracts';
import type { AgentTaskStore, ClaimedAgentTask } from '@hypermail/db';

/** Transport-neutral application protocol. HTTP/MCP adapters must authenticate a connection before calling it. */
export class ExternalAgentTaskProtocol {
 constructor(private readonly tasks:AgentTaskStore){}
 claim(connectionId:string,workerId:string):Promise<ClaimedAgentTask|null>{return this.tasks.claim({kind:'agent_connection',connectionId},workerId);}
 heartbeat(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string}){return this.tasks.heartbeat(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,60_000,connectionId);}
 complete(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string;result:AgentTaskResult}){return this.tasks.reportResult(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,input.result,connectionId);}
 fail(connectionId:string,input:{taskId:string;generation:number;leaseToken:string;requestId:string;requestDigest:string;errorCode:AgentTaskErrorCode}){return this.tasks.reportFailure(input.taskId,input.generation,input.leaseToken,input.requestId,input.requestDigest,input.errorCode,connectionId);}
 answer(connectionId:string,input:{taskId:string;questionId:string;answerDigest:string;continuationRunId:string;requestId:string;requestDigest:string}){return this.tasks.answer(input.taskId,input.questionId,input.answerDigest,input.continuationRunId,input.requestId,input.requestDigest,connectionId);}
 cancel(connectionId:string,taskId:string){return this.tasks.cancel(taskId,connectionId);}
}
export class UnverifiableAgentTaskError extends Error {constructor(message='Provider mutation outcome cannot be verified.'){super(message);this.name='UnverifiableAgentTaskError';}}
export interface MastraAutomaticTaskExecutor { execute(claim:ClaimedAgentTask):Promise<AgentTaskResult>; }
/** Embedded Mastra uses the exact same durable protocol and never consumes external work. */
export class MastraAutomaticTaskAdapter {
 constructor(private readonly tasks:AgentTaskStore,private readonly executor:MastraAutomaticTaskExecutor,private readonly workerId:string){}
 async runOne():Promise<boolean>{const claim=await this.tasks.claim({kind:'mastra'},this.workerId);if(!claim)return false;const requestId=`mastra-result:${claim.runId}`;try{const result=await this.executor.execute(claim);await this.tasks.reportResult(claim.task.id,claim.task.leaseGeneration,claim.leaseToken,requestId,createHash('sha256').update(requestId).digest('hex'),result);}catch(error){const code:AgentTaskErrorCode=error instanceof UnverifiableAgentTaskError?'UNVERIFIABLE':'INTERNAL';await this.tasks.reportFailure(claim.task.id,claim.task.leaseGeneration,claim.leaseToken,`mastra-failure:${claim.runId}`,createHash('sha256').update(`mastra-failure:${claim.runId}`).digest('hex'),code);}return true;}
}
export class AgentTaskRecovery {constructor(private readonly tasks:AgentTaskStore,private readonly limit=100){}async recover():Promise<void>{await this.tasks.reconcileExpired(this.limit);await this.tasks.reconcileVerifiedActions(this.limit);}}
