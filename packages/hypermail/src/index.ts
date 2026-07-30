export { HypermailReadClient, HypermailMcpHttpClient, McpJsonRpcError, McpTransportError, classifyRetry } from "./client.js";
export { AttachmentStream, cleanupAttachmentOrphans, contentDisposition } from "./attachments.js";
export type { AttachmentOrphanCleanupOptions } from "./attachments.js";
export type {
  Account, AttachmentMetadata, AttachmentStreamOptions, EmailAddress, Folder, HypermailReadClientOptions,
  InboxPage, Message, MessagePage, Provider, RetryClassification, SearchOptions
} from "./types.js";
