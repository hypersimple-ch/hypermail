import type { HypermailReadClient, TenantHypermailSessionProvider } from '@hypermail/hypermail';
import type { SqlClient } from '../activity/postgres-repository.js';
import { AttachmentAuthorizationError, type AttachmentReader, type DeliveredAttachment } from './contracts.js';

type AttachmentClient = Pick<HypermailReadClient, 'initialize' | 'openAttachment'>;
type TenantSessions = Pick<TenantHypermailSessionProvider, 'leaseForUser'>;

/** Resolves application UUIDs and their owning User before selecting a tenant provider session. */
export class ScopedHypermailAttachmentReader implements AttachmentReader {
  private initialized: Promise<unknown> | undefined;
  constructor(private readonly sql: SqlClient, private readonly clients: AttachmentClient | TenantSessions) {}

  async openAttachment(accountId: string, messageId: string, attachmentId: string, options: Readonly<{ maxBytes: number; tempDirectory: string; signal?: AbortSignal }>): Promise<DeliveredAttachment> {
    const result = await this.sql.query<{ user_id: string; email: string; provider_message_id: string; provider_attachment_id: string }>(
      `SELECT a.user_id, a.email, m.provider_message_id, att.provider_attachment_id
       FROM app.accounts a JOIN app.messages m ON m.account_id = a.id
       JOIN app.attachments att ON att.message_id = m.id
       WHERE a.id = $1::uuid AND m.id = $2::uuid AND att.id = $3::uuid`, [accountId, messageId, attachmentId],
    );
    const target = result.rows[0];
    if (!target) throw new AttachmentAuthorizationError();
    const lease = 'leaseForUser' in this.clients ? await this.clients.leaseForUser(target.user_id) : null;
    const client = lease?.bundle.read ?? this.clients as AttachmentClient;
    try {
      if (!lease) { this.initialized ??= client.initialize(); await this.initialized; }
      const attachment = await client.openAttachment(target.email, target.provider_message_id, target.provider_attachment_id, options);
      return { metadata: { name: attachment.metadata.name, ...(attachment.metadata.contentType ? { contentType: attachment.metadata.contentType } : {}) }, contentDisposition: attachment.contentDisposition, stream: attachment.stream, cleanup: async () => { try { await attachment.cleanup(); } finally { await lease?.release(); } } };
    } catch (error) { await lease?.release(); throw error; }
  }
}
