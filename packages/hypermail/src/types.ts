export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Provider = "outlook" | "gmail" | "imap";

export interface EmailAddress { address: string; name?: string }
/** Safe projection only: provider credentials and provider configuration are intentionally absent. */
export interface Account { email: string; provider: Provider; displayName?: string; addedAt?: string; hasSignature?: boolean; hasStyle?: boolean }
export interface Folder { id: string; displayName: string; parentFolderId?: string; wellKnownName?: string }
export interface AttachmentMetadata { id: string; name: string; contentType?: string; size?: number; webUrl?: string; webUrlUnavailableReason?: string }
export interface Message {
  id: string; account: string; subject?: string; from?: EmailAddress; to?: EmailAddress[]; cc?: EmailAddress[];
  receivedAt?: string; isRead?: boolean; body?: string; attachments?: AttachmentMetadata[];
}
export interface MessagePage { messages: Message[]; cursor?: string; hasMore: boolean }
export interface InboxPage extends MessagePage { account?: string }
export interface SearchOptions { query?: string; from?: string; to?: string; cc?: string; limit?: number }
export interface RetryClassification { retryable: boolean; reason: "network" | "http" | "json-rpc" | "malformed" | "aborted" }
export interface HypermailReadClientOptions {
  endpoint: string;
  /** Protocol version is deployment supplied because v0.7.26 does not publish the literal. */
  protocolVersion: string;
  fetch?: typeof fetch;
  /** Extra transport headers, e.g. an Authorization header for the private MCP endpoint. */
  headers?: Record<string, string>;
  maxRetries?: number;
  accountCacheTtlMs?: number;
  folderCacheTtlMs?: number;
}
/** `tempDirectory` must be a private, dedicated attachment directory; the process-wide temporary directory is never accepted. */
export interface AttachmentStreamOptions { maxBytes: number; tempDirectory: string; signal?: AbortSignal }
