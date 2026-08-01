export { HypermailReadClient, HypermailMcpHttpClient, McpJsonRpcError, McpTransportError, classifyRetry } from "./client.js";
export { AttachmentStream, cleanupAttachmentOrphans, contentDisposition } from "./attachments.js";
export type { AttachmentOrphanCleanupOptions } from "./attachments.js";
export type {
  Account, AccountVerification, AddAccountInput, AddAccountResult, AttachmentMetadata, AttachmentStreamOptions,
  CompleteAddAccountInput, CompleteAddAccountResult, EmailAddress, Folder, HypermailReadClientOptions,
  ImapAddAccountConfig, InboxPage, Message, MessagePage, OnboardingAccount, OnboardingDiagnostic, OnboardingErrorReason, Provider, RetryClassification, SearchOptions
} from "./types.js";
