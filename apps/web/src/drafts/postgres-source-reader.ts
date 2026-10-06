import type { DraftScope, DraftSource, DraftSourceReader } from './contracts.js';
import type { MessageReader } from '../message-reader.js';
import { MailReadError } from '../mailbox-page.js';


/** Quotes use the same complete, sanitized read-through body as the reader. */
export class PostgresDraftSourceReader implements DraftSourceReader {
  constructor(private readonly messages: MessageReader) {}

  async read(scope: DraftScope, accountId: string, sourceMessageId: string): Promise<DraftSource | null> {
    if (!scope.accountIds.includes(accountId)) return null;
    try {
      const message = await this.messages.read(scope, sourceMessageId);
      if (message.account_id !== accountId) return null;
      return { id: message.id, accountId, from: message.senderAddress, sentAt: message.received_at, subject: message.subject, body: message.body };
    } catch (error) {
      if (error instanceof MailReadError && error.status === 404) return null;
      throw error;
    }
  }
}
