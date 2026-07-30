import type { Readable } from 'node:stream';

/** Verified by the framework session adapter; raw provider credentials are never accepted here. */
export type AttachmentScope = Readonly<{ subjectId: string; accountIds: readonly string[] }>;
export type AttachmentTarget = Readonly<{ accountId: string; messageId: string; attachmentId: string }>;
export type DeliveredAttachment = Readonly<{
  metadata: Readonly<{ name: string; contentType?: string }>;
  contentDisposition: string;
  stream: Readable;
  cleanup(): Promise<void>;
}>;

/** The delivery boundary only needs the read client's bounded temporary-file operation. */
export interface AttachmentReader {
  openAttachment(accountId: string, messageId: string, attachmentId: string, options: Readonly<{ maxBytes: number; tempDirectory: string; signal?: AbortSignal }>): Promise<DeliveredAttachment>;
}

export class AttachmentAuthorizationError extends Error { constructor() { super('Attachment is not available.'); this.name = 'AttachmentAuthorizationError'; } }
export class AttachmentInputError extends Error { constructor() { super('Invalid attachment target.'); this.name = 'AttachmentInputError'; } }
