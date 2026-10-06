import type { MailboxPageReader, MailReadScope } from './mailbox-page.js';
import type { MessageReader } from './message-reader.js';
import { mailReadErrorResponse } from './message-reader.js';

interface ReadRequest { auth: MailReadScope | null; query: Readonly<Record<string,string|undefined>>; }
/** Authentication is supplied from the session, never request JSON or query scope. */
export function createMailReadRoutes(inbox: MailboxPageReader, messages: MessageReader) {
  return {
    async inbox(request: ReadRequest) {
      if (!request.auth) return {status:401,body:{error:{code:'UNAUTHENTICATED'}}};
      const accountId=request.query['accountId'];
      if (!accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) return {status:400,body:{error:{code:'INVALID_ACCOUNT_ID'}}};
      const limit=request.query['limit'] === undefined ? 50 : Number(request.query['limit']);
      try { return {status:200,body:await inbox.page(request.auth,accountId,request.query['cursor'],limit)}; }
      catch(error) { return mailReadErrorResponse(error); }
    },
    async message(request: ReadRequest, messageId: string) {
      if (!request.auth) return {status:401,body:{error:{code:'UNAUTHENTICATED'}}};
      try { return {status:200,body:{message:await messages.read(request.auth,messageId)}}; }
      catch(error) { return mailReadErrorResponse(error); }
    },
  };
}
