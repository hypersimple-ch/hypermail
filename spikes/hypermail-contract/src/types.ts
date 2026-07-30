export type Provider = "outlook" | "gmail" | "imap";
export type Policy = "read-only" | "autonomous-policy-eligible" | "user-approved-only" | "forbidden";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Account { email: string; provider: Provider; displayName?: string; addedAt?: string; hasSignature?: boolean; hasStyle?: boolean }
export interface EmailAddress { address: string; name?: string }
export interface Attachment { id?: string; name: string; contentType?: string; size?: number; path?: string; webUrl?: string; webUrlUnavailableReason?: string }
export interface Email { id: string; account: string; subject?: string; from?: EmailAddress; receivedAt?: string; isRead?: boolean; attachments?: Attachment[]; body?: string }
export interface ToolCall { name: string; arguments: Record<string, Json> }
export interface JsonRpcError { code: number; message: string; data?: Json }
export interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string | null; result?: Json; error?: JsonRpcError }

export const policy: Record<string, Policy> = {
  list_accounts: "read-only", add_account: "forbidden", complete_add_account: "forbidden", remove_account: "forbidden",
  get_account_settings: "read-only", set_account_settings: "forbidden",
  list_emails: "read-only", search_emails: "read-only", read_email: "read-only", read_attachment: "read-only", get_new_emails: "autonomous-policy-eligible",
  list_folders: "read-only", create_folder: "forbidden", delete_folder: "forbidden", rename_folder: "forbidden",
  draft_email: "user-approved-only", edit_draft: "user-approved-only", send_draft: "forbidden", send_email: "forbidden",
  move_email: "user-approved-only", archive_email: "user-approved-only", trash_email: "user-approved-only", mark_read: "autonomous-policy-eligible", mark_unread: "user-approved-only"
};
