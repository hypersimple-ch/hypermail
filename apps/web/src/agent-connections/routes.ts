import type { AgentConnectionsService } from './service.js';
import type { ConnectionState, ManagerChoice } from './contracts.js';
import { ManagerConflictError, ManagerInputError, ManagerNotFoundError } from './contracts.js';
export type ManagerRouteRequest=Readonly<{method:string;origin:string|null;auth:{subjectId:string}|null;body:Readonly<Record<string,unknown>>}>;
type Response=Readonly<{status:number;body:Readonly<Record<string,unknown>>}>;
const error=(e:unknown):Response=>e instanceof ManagerInputError?{status:400,body:{error:{code:'BAD_REQUEST',message:e.message}}}:e instanceof ManagerConflictError?{status:409,body:{error:{code:'CONFLICT',message:e.message}}}:e instanceof ManagerNotFoundError?{status:404,body:{error:{code:'NOT_FOUND',message:e.message}}}:{status:500,body:{error:{code:'INTERNAL'}}};
const choice=(value:unknown):ManagerChoice=>{if(!value||typeof value!=='object')throw new ManagerInputError('A Manager is required.');const v=value as Record<string,unknown>;if(v['kind']==='mastra'||v['kind']==='none')return {kind:v['kind']};if(v['kind']==='agent_connection'&&typeof v['connectionId']==='string')return {kind:'agent_connection',connectionId:v['connectionId']};throw new ManagerInputError('Unknown Manager.');};
export function createAgentConnectionRoutes(service:AgentConnectionsService,expectedOrigin:string){
 const run=async(request:ManagerRouteRequest,mutation:(userId:string)=>Promise<unknown>):Promise<Response>=>{if(request.method!=='POST')return{status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};if(request.origin!==expectedOrigin)return{status:403,body:{error:{code:'CSRF_REJECTED'}}};if(!request.auth)return{status:401,body:{error:{code:'UNAUTHENTICATED'}}};try{return{status:200,body:{settings:await mutation(request.auth.subjectId)}};}catch(e){return error(e);}};
 return {
  read:async(request:ManagerRouteRequest):Promise<Response>=>{if(request.method!=='GET')return{status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};if(!request.auth)return{status:401,body:{error:{code:'UNAUTHENTICATED'}}};try{return{status:200,body:{settings:await service.read(request.auth.subjectId)}};}catch(e){return error(e);}},
  setDefault:(r:ManagerRouteRequest)=>run(r,userId=>service.setDefault(userId,choice(r.body['manager']),Number(r.body['expectedRevision']))),
  lifecycle:(r:ManagerRouteRequest,id:string)=>run(r,userId=>service.setLifecycle(userId,id,String(r.body['state']) as ConnectionState,Number(r.body['expectedRevision']))),
  securityRevoke:(r:ManagerRouteRequest,id:string)=>run(r,userId=>service.securityRevoke(userId,id,Number(r.body['expectedRevision']))),
  assignment:(r:ManagerRouteRequest,mailboxId:string)=>run(r,userId=>service.setAssignment(userId,mailboxId,choice(r.body['manager']),r.body['automaticProcessingEnabled']===true,Number(r.body['expectedAssignmentRevision']),r.body['expectedGrantRevision']===undefined?undefined:Number(r.body['expectedGrantRevision']))),
  reapprove:(r:ManagerRouteRequest,mailboxId:string)=>run(r,userId=>service.reapprove(userId,mailboxId,Number(r.body['expectedGrantRevision']),typeof r.body['idempotencyKey']==='string'?r.body['idempotencyKey']:'')),
 };
}
