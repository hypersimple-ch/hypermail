import type { HypermailReadClient } from '@hypermail/hypermail';
import type { SqlClient } from '../activity/postgres-repository.js';
import { AttachmentAuthorizationError, type AttachmentReader, type DeliveredAttachment } from './contracts.js';

/** Resolves application UUIDs to provider identifiers before crossing the provider boundary. */
export class ScopedHypermailAttachmentReader implements AttachmentReader {
  private initialized: Promise<unknown> | undefined;
  constructor(private readonly sql: SqlClient, private readonly client: HypermailReadClient) {}

  async openAttachment(accountId: string, messageId: string, attachmentId: string, options: Readonly<{ maxBytes: number; tempDirectory: string; signal?: AbortSignal }>): Promise<DeliveredAttachment> {
    const result = await this.sql.query<{ email: string; provider_message_id: string; provider_attachment_id: string }>(
      `SELECT a.email, m.provider_message_id, att.provider_attachment_id
       FROM app.accounts a JOIN app.messages m ON m.account_id = a.id
       JOIN app.attachments att ON att.message_id = m.id
       WHERE a.id = $1::uuid AND m.id = $2::uuid AND att.id = $3::uuid`, [accountId, messageId, attachmentId],
    );
    const target = result.rows[0];
    if (!target) throw new AttachmentAuthorizationError();
    this.initialized ??= this.client.initialize();
    await this.initialized;
    const attachment = await this.client.openAttachment(target.email, target.provider_message_id, target.provider_attachment_id, options);
    return { metadata: { name: attachment.metadata.name, ...(attachment.metadata.contentType ? { contentType: attachment.metadata.contentType } : {}) }, contentDisposition: attachment.contentDisposition, stream: attachment.stream, cleanup: () => attachment.cleanup() };
  }
}
