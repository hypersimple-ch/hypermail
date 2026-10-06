import type { ApprovedSendTransport, ProviderSendResult, ProviderSendStatus, Submission, SubmissionReadback } from '@hypermail/send';
import type { Json } from './types.js';
/** Deliberately exported only by the approved-send subpath, never the public MCP proxy. Transport MUST have retries disabled. */
export interface HypermailToolTransport { callTool(name:string,args:Record<string,Json>):Promise<unknown>; }
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MALFORMED_SEND_READBACK');return value as Record<string,unknown>;};
export class HypermailApprovedSendTransport implements ApprovedSendTransport {
 constructor(private readonly transport:HypermailToolTransport){}
 async submit(s:Submission):Promise<ProviderSendResult>{
  if(s.sourceMessageId&&!s.providerSourceId)return {state:'rejected',reasonCode:'REPLY_SOURCE_UNAVAILABLE'};
  const result=object(await this.transport.callTool('send_email',{account:s.account,to:s.recipients.filter(r=>r.kind==='to').map(r=>({address:r.address})),cc:s.recipients.filter(r=>r.kind==='cc').map(r=>({address:r.address})),bcc:s.recipients.filter(r=>r.kind==='bcc').map(r=>({address:r.address})),subject:s.subject,body:s.body,format:s.bodyFormat,include_signature:false,inReplyTo:s.providerSourceId??false,replyAll:false}));
  if(result['sent']!==true)return {state:'unknown',reasonCode:'PROVIDER_SUBMISSION_AMBIGUOUS'};
  const id=typeof result['id']==='string'?result['id']:'';
  return {state:'reported',reference:id?{kind:s.providerType==='imap'?'internet_message_id':'native_id',value:id}:null};
 }
 async verify(s:SubmissionReadback):Promise<ProviderSendStatus>{
  // Pinned Hypermail v0.7.26 exposes neither RFC Message-ID headers nor exact header search.
  // Never treat an SMTP Message-ID as the IMAP folder/UID expected by read_email.
  if(!s.reference||s.reference.kind==='internet_message_id')return {state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'};
  // This is a documented provider well-known name, not a guessed display label.
  const sentFolder='sentitems';
  const deadline=Date.now()+30_000;
  for(let skip=0;skip<5000&&Date.now()<deadline;skip+=100){
   const page=object(await this.transport.callTool('list_emails',{account:s.account,folder:sentFolder,skip,limit:100}));
   if(!Array.isArray(page['items'])||typeof page['hasMore']!=='boolean')throw new Error('MALFORMED_SENT_PAGE');
   const match=page['items'].map(object).find(m=>m['id']===s.reference?.value);
   if(match&&typeof match['id']==='string'){
    const read=object(await this.transport.callTool('read_email',{account:s.account,id:match['id'],format:'html'}));
    const identity=read['id']===s.reference.value;
    const stamp=read['sentAt']??read['receivedAt']??read['receivedDateTime']??match['receivedAt'];
    if(identity&&typeof stamp==='string'&&Number.isFinite(Date.parse(stamp))&&s.startedAt&&Date.parse(stamp)>=Date.parse(s.startedAt)-300_000&&Date.parse(stamp)<=Date.now()+300_000)return {state:'verified',providerMessageId:match['id'],observedAt:new Date().toISOString(),evidence:{folderId:sentFolder,referenceKind:s.reference.kind,reference:s.reference.value,messageId:match['id'],messageDate:stamp}};
    return {state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'};
   }
   if(!page['hasMore'])break;
  }
  return {state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'};
 }
}
