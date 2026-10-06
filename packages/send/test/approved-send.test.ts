/* eslint-disable @typescript-eslint/require-await -- Synchronous fixture transports expose asynchronous provider ports. */
import { describe,expect,it,vi } from 'vitest';
import { HypermailApprovedSendTransport } from '../../hypermail/src/approved-send.js';
import type { Submission } from '../src/index.js';
const snapshot:Submission={approvalId:'approval',userId:'owner',accountId:'account',account:'owner@example.test',draftId:'draft',draftVersion:1,idempotencyKey:'send:approval',recipients:[{kind:'to',address:'to@example.test'}],subject:'s',body:'b',bodyFormat:'markdown',sourceMessageId:null,providerType:'gmail',providerSourceId:null,state:'reported',reference:{kind:'native_id',value:'exact'},startedAt:new Date().toISOString()};
describe('restricted approved-send identity proof',()=>{
 it('keeps an empty Graph submission reference unknown instead of claiming sent',async()=>{
  const callTool=vi.fn().mockResolvedValue({sent:true,id:''});const transport=new HypermailApprovedSendTransport({callTool});
  expect(await transport.submit({...snapshot,providerType:'microsoft'})).toEqual({state:'reported',reference:null});
  expect(await transport.verify({...snapshot,reference:null})).toMatchObject({state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'});
  expect(callTool).toHaveBeenCalledTimes(1);
 });
 it('does not pass RFC Message-ID to read_email or match SMTP messages by subject',async()=>{
  const callTool=vi.fn();const transport=new HypermailApprovedSendTransport({callTool});
  expect(await transport.verify({...snapshot,providerType:'imap',reference:{kind:'internet_message_id',value:'<smtp@example.test>'}})).toMatchObject({state:'unknown'});
  expect(callTool).not.toHaveBeenCalled();
 });
 it('finds exact native identity beyond the first500 messages in Sent and reads only that identity',async()=>{
  const callTool=vi.fn(async(name:string,args:Record<string,unknown>)=>{
   if(name==='list_emails'){expect(args['folder']).toBe('sentitems');return Number(args['skip'])<500?{items:[{id:'other',subject:'s'}],hasMore:true}:{items:[{id:'exact'}],hasMore:false};}
   if(name==='read_email'){expect(args['id']).toBe('exact');return {id:'exact',receivedAt:snapshot.startedAt};}
   throw new Error('Unexpected mutator');
  });
  const transport=new HypermailApprovedSendTransport({callTool});
  expect(await transport.verify(snapshot)).toMatchObject({state:'verified',providerMessageId:'exact',evidence:{folderId:'sentitems',reference:'exact'}});
  expect(callTool).toHaveBeenCalledTimes(7);
 });
 it('rejects stale or conflicting exact-id readback and never resends during status',async()=>{
  const callTool=vi.fn(async(name:string)=>name==='list_emails'?{items:[{id:'exact'}],hasMore:false}:{id:'other',receivedAt:snapshot.startedAt});
  expect(await new HypermailApprovedSendTransport({callTool}).verify(snapshot)).toMatchObject({state:'unknown'});
  expect(callTool.mock.calls.map(c=>c[0])).toEqual(['list_emails','read_email']);
 });
 it('bounds incomplete Sent scans without concluding absence or mutating',async()=>{
  const callTool=vi.fn().mockResolvedValue({items:[{id:'other'}],hasMore:true});
  expect(await new HypermailApprovedSendTransport({callTool}).verify(snapshot)).toMatchObject({state:'unknown'});
  expect(callTool).toHaveBeenCalledTimes(50);
  expect(callTool.mock.calls.every(c=>c[0]==='list_emails')).toBe(true);
 });
 it('proves unavailable approved reply context before network and treats nonpositive send reports as ambiguous',async()=>{
  const callTool=vi.fn().mockResolvedValue({sent:false});const transport=new HypermailApprovedSendTransport({callTool});
  expect(await transport.submit({...snapshot,sourceMessageId:'source',providerSourceId:null})).toMatchObject({state:'rejected',reasonCode:'REPLY_SOURCE_UNAVAILABLE'});
  expect(callTool).not.toHaveBeenCalled();
  expect(await transport.submit(snapshot)).toMatchObject({state:'unknown',reasonCode:'PROVIDER_SUBMISSION_AMBIGUOUS'});
 });
});
