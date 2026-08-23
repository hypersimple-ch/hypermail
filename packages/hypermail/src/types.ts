export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Provider = "outlook" | "gmail" | "imap";

export interface EmailAddress { address: string; name?: string }
/** Safe projection only: provider credentials and provider configuration are intentionally absent. */
export interface Account { email: string; provider: Provider; displayName?: string; addedAt?: string; hasSignature?: boolean; hasStyle?: boolean }
export interface Folder { id: string; displayName: string; parentFolderId?: string; wellKnownName?: string }
export interface AttachmentMetadata { id: string; name: string; contentType?: string; size?: number; webUrl?: string; webUrlUnavailableReason?: string }
export interface Message {
  id: string; account: string; subject?: string; from?: EmailAddress; to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[];
  replyTo?: EmailAddress[]; internetMessageId?: string; receivedAt?: string; isRead?: boolean; folder?: string;
  body?: string; bodyFormat?: "markdown" | "html" | "text"; attachments?: AttachmentMetadata[];
}
export type DraftBodyFormat = "markdown" | "html";
export interface DraftMutationResult { id: string; draftHtml?: string }
export interface PolicyMutationResult { id: string }
export interface DraftCreateInput {
  account: string; to: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; subject: string; body: string; bodyFormat: DraftBodyFormat; inReplyTo?: string;
}
export interface DraftEditInput {
  account: string; id: string; to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; subject?: string; oldText?: string; newText?: string; bodyFormat: DraftBodyFormat;
}
export interface MessagePage { messages: Message[]; cursor?: string; hasMore: boolean }
export interface InboxPage extends MessagePage { account?: string }
export interface SearchOptions { account?: string; query?: string; from?: string; to?: string; cc?: string; limit?: number }
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
  /** Receives only scrubbed, bounded onboarding diagnostics; raw provider text is never emitted. */
  onOnboardingDiagnostic?: (diagnostic: OnboardingDiagnostic) => void;
}
/** `tempDirectory` must be a private, dedicated attachment directory; the process-wide temporary directory is never accepted. */
export interface AttachmentStreamOptions { maxBytes: number; tempDirectory: string; signal?: AbortSignal }

/** IMAP credentials are accepted only as an add-account request and are never returned. */
export interface ImapAddAccountConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}
export type AddAccountInput =
  | { provider: "outlook" | "gmail"; email?: string; config?: never }
  | { provider: "imap"; email?: string; config: ImapAddAccountConfig };
export interface CompleteAddAccountInput {
  provider: Provider;
  handle: string;
  /** OAuth callback data is request-only and is never included in a result. */
  authorizationResponse?: string;
  code?: string;
  state?: string;
}
export interface OnboardingAccount {
  provider: Provider;
  email: string;
  displayName?: string;
  state?: string;
}
export interface AccountVerification {
  type: "device_code" | "oauth_url";
  userCode?: string;
  verificationUri: string;
  expiresAt: string;
  message: string;
}
export type AddAccountResult =
  | { status: "pending"; handle: string; verification: AccountVerification }
  | { status: "ready"; account: OnboardingAccount };
/** Safe operational detail for diagnosing onboarding failures without callback data, credentials, tokens, or raw provider text. */
export interface OnboardingDiagnostic {
  source: "provider_result" | "transport";
  reason: OnboardingErrorReason;
  detail: string;
}
/** Bounded completion failures; raw provider text is deliberately never exposed. */
export type OnboardingErrorReason = "authorization_expired" | "authorization_rejected" | "provider_configuration" | "token_exchange_failed" | "gmail_profile_failed" | "provider_unavailable";
export type CompleteAddAccountResult =
  | { status: "pending" }
  | { status: "ready"; account: OnboardingAccount }
  | { status: "expired" }
  | { status: "error"; reason: OnboardingErrorReason };
