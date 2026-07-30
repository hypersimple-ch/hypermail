import { AttachmentAuthorizationError, AttachmentInputError, type AttachmentReader, type AttachmentScope, type AttachmentTarget, type DeliveredAttachment } from './contracts.js';

const mime = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const targetPart = (value: string): boolean => value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);

/** `tempDirectory` is the private, dedicated source root required by the Hypermail reader. */
export type AttachmentDeliveryOptions = Readonly<{ maxBytes: number; tempDirectory: string }>; 
export type AttachmentDelivery = Readonly<{ headers: Readonly<Record<string, string>>; stream: DeliveredAttachment['stream']; cleanup(): Promise<void> }>;

/** Authorizes a narrowly scoped attachment read and exposes only response-safe delivery data. */
export class AttachmentDeliveryService {
  constructor(private readonly reader: AttachmentReader, private readonly options: AttachmentDeliveryOptions) {}

  async open(scope: AttachmentScope, target: AttachmentTarget, signal?: AbortSignal): Promise<AttachmentDelivery> {
    if (!targetPart(target.accountId) || !targetPart(target.messageId) || !targetPart(target.attachmentId)) throw new AttachmentInputError();
    if (!scope.accountIds.includes(target.accountId)) throw new AttachmentAuthorizationError();
    const attachment = await this.reader.openAttachment(target.accountId, target.messageId, target.attachmentId, { maxBytes: this.options.maxBytes, tempDirectory: this.options.tempDirectory, ...(signal ? { signal } : {}) });
    const type = attachment.metadata.contentType && mime.test(attachment.metadata.contentType) ? attachment.metadata.contentType : 'application/octet-stream';
    return { headers: { 'content-type': type, 'content-disposition': attachment.contentDisposition, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }, stream: attachment.stream, cleanup: () => attachment.cleanup() };
  }
}
