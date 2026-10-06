import { z } from 'zod';
import { SendRequestConflictError, SendRequestFreshAuthError, SendRequestNotFoundError, type OwnerSendScope } from './contracts.js';
import type { OwnerSendRequestService } from './service.js';
type Request=Readonly<{method:string;origin:string|null;auth:OwnerSendScope|null;body:unknown}>;type Response=Readonly<{status:number;body:Readonly<Record<string,unknown>>}>;
const id=z.uuid();const confirmation=z.string().min(16).max(500);
const failure=(e:unknown):Response=>{
 if(e instanceof SendRequestNotFoundError)return {status:404,body:{error:{code:'NOT_FOUND'}}};
 if(e instanceof SendRequestFreshAuthError)return {status:401,body:{error:{code:'FRESH_AUTH_REQUIRED'}}};
 if(e instanceof SendRequestConflictError)return {status:409,body:{error:{code:'CONFLICT',message:e.message}}};
 if(e instanceof z.ZodError)return {status:400,body:{error:{code:'BAD_REQUEST'}}};
 if(e instanceof Error&&['HYPERMAIL_TENANT_ROUTE_REQUIRED','HYPERMAIL_TENANT_ROUTE_MISSING'].includes(e.message))return {status:503,body:{error:{code:'SEND_UNAVAILABLE'}}};
 throw e;
};
export function createOwnerSendRequestRoutes(service:OwnerSendRequestService,expectedOrigin:string){const auth=(r:Request):Response|null=>!r.auth?{status:401,body:{error:{code:'UNAUTHENTICATED'}}}:null;const mutate=async(r:Request,work:(s:OwnerSendScope)=>Promise<unknown>):Promise<Response>=>{if(r.method!=='POST')return{status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};if(r.origin!==expectedOrigin)return{status:403,body:{error:{code:'CROSS_ORIGIN'}}};const denied=auth(r);if(denied)return denied;try{const request=await work(r.auth as OwnerSendScope);const state=(request as {state?:string}).state;return{status:state==='sending'||state==='unverifiable'?202:200,body:{request}}}catch(e){return failure(e)}};return{
 async list(r:Request){if(r.method!=='GET')return{status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};const denied=auth(r);if(denied)return denied;return{status:200,body:{requests:await service.list(r.auth as OwnerSendScope)}}},
 async detail(r:Request,requestId:string){if(r.method!=='GET')return{status:405,body:{error:{code:'METHOD_NOT_ALLOWED'}}};const denied=auth(r);if(denied)return denied;try{return{status:200,body:{request:await service.detail(r.auth as OwnerSendScope,id.parse(requestId))}}}catch(e){return failure(e)}},
 reject:(r:Request,requestId:string)=>mutate(r,s=>service.reject(s,id.parse(requestId))),
 begin:(r:Request,requestId:string)=>mutate(r,s=>{const x=z.strictObject({expectedDraftVersion:z.number().int().positive(),confirmation}).parse(r.body);return service.begin(s,id.parse(requestId),x.expectedDraftVersion,x.confirmation)}),
 confirm:(r:Request,requestId:string,approvalId:string)=>mutate(r,s=>{const x=z.strictObject({confirmation}).parse(r.body);return service.confirm(s,id.parse(requestId),id.parse(approvalId),x.confirmation)}),
 reconcile:(r:Request,requestId:string)=>mutate(r,s=>{const x=z.strictObject({approvalId:z.uuid(),expectedVersion:z.number().int().positive()}).parse(r.body);return service.reconcile(s,id.parse(requestId),x.approvalId,x.expectedVersion)}),
 manualReview:(r:Request,requestId:string)=>mutate(r,s=>{const x=z.strictObject({approvalId:z.uuid(),expectedVersion:z.number().int().positive(),outcome:z.enum(['observed_sent','not_observed']),note:z.string().max(2000)}).parse(r.body);return service.manualReview(s,id.parse(requestId),x.approvalId,x.expectedVersion,x.outcome,x.note)}),
}}
