import { marked } from "marked";
import { AttachmentStream } from "./attachments.js";
import type { Account, AddAccountInput, AddAccountResult, AttachmentMetadata, AttachmentStreamOptions, CompleteAddAccountInput, CompleteAddAccountResult, DraftCreateInput, DraftEditInput, DraftMutationResult, Folder, HypermailReadClientOptions, InboxPage, Json, Message, MessagePage, OnboardingAccount, OnboardingDiagnostic, OnboardingErrorReason, PolicyMutationResult, Provider, RetryClassification, SearchOptions } from "./types.js";

const retryableRpcCodes = new Set([-32001, -32002, -32003]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const toolFailure = (result: Record<string, unknown>): McpTransportError => {
  const diagnostic = Array.isArray(result.content) ? result.content.flatMap((entry) => isRecord(entry) && typeof entry.text === "string" ? [entry.text] : []).join(" ") : "";
  // Tool content can contain provider secrets. Use it only to select a bounded,
  // stable classification and never include it in the thrown error.
  if (/invalid_grant|invalid[_ -]?token|token (?:has )?expired|reauth|authentication/i.test(diagnostic)) return new McpTransportError("Provider authentication failed", 401, false, "http");
  if (/rate.?limit|too many requests|\b429\b/i.test(diagnostic)) return new McpTransportError("Provider rate limited", 429, true, "http");
  if (/timeout|temporar|unavailable|network|\b5\d\d\b/i.test(diagnostic)) return new McpTransportError("Provider unavailable", 503, true, "http");
  return new McpTransportError("MCP tool failed");
};
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || value.length === 0) throw new McpTransportError(`Malformed ${field}`); return value; };
const optionalText = (value: unknown, field: string): string | undefined => value === undefined ? undefined : text(value, field);
const bool = (value: unknown, field: string): boolean | undefined => value === undefined ? undefined : typeof value === "boolean" ? value : (() => { throw new McpTransportError(`Malformed ${field}`); })();
const positive = (value: number | undefined, name: string, maximum = 100): number => { const result = value ?? 25; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new RangeError(`${name} must be an integer from 1 to ${String(maximum)}`); return result; };

export function classifyRetry(error: unknown): RetryClassification {
  if (error instanceof McpJsonRpcError) return { retryable: error.retryable, reason: "json-rpc" };
  if (error instanceof McpTransportError) return { retryable: error.retryable, reason: error.reason };
  if (error instanceof DOMException && error.name === "AbortError") return { retryable: false, reason: "aborted" };
  return { retryable: true, reason: "network" };
}
export class McpTransportError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly reason: RetryClassification["reason"] = "malformed") { super(message); this.name = "McpTransportError"; }
}
export class McpJsonRpcError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: number, message: string, readonly data?: Json) { super(message); this.name = "McpJsonRpcError"; this.retryable = retryableRpcCodes.has(code); }
}

type RpcResponse = { jsonrpc: string; id: number | string | null; result?: Json; error?: { code: number; message: string; data?: Json } };
type Cursor = { scope: "all" | "account"; account?: string; offsets: Record<string, number> };

/** Low-level Streamable HTTP client. It exposes only lifecycle and tool calls; no write-tool helpers exist here. */
export class HypermailMcpHttpClient {
  #id = 0; #sessionId?: string; #initialized = false;
  readonly endpoint: string;
  constructor(endpoint: string, private readonly request: typeof fetch = fetch, private readonly headers: Record<string, string> = {}, private readonly maxRetries = 0) { this.endpoint = endpoint; }

  async initialize(protocolVersion: string): Promise<Json> {
    if (this.#initialized) throw new Error("MCP client is already initialized");
    const result = await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "hypermail-read-worker", version: "0.1.0" } });
    await this.notify("notifications/initialized"); this.#initialized = true; return result;
  }
  async listTools(): Promise<Json> { return this.rpc("tools/list", {}); }
  async close(): Promise<void> {
    if (!this.#sessionId) return;
    const headers = new Headers(this.headers); headers.set("mcp-session-id", this.#sessionId);
    try { await this.request(this.endpoint, { method: "DELETE", headers }); } finally { this.#sessionId = undefined; this.#initialized = false; }
  }
  async call<T extends Json = Json>(name: string, args: Record<string, Json>): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (!isRecord(result) || (!("content" in result) && !("structuredContent" in result))) return result as T;
    if (result.isError === true) throw toolFailure(result);
    if (!("structuredContent" in result)) throw new McpTransportError("Malformed MCP tool result");
    return result.structuredContent as T;
  }

  async #retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) try { return await operation(); } catch (error) {
      if (attempt >= this.maxRetries || !classifyRetry(error).retryable) throw error;
    }
  }
  async notify(method: string): Promise<void> { await this.#retry(() => this.send({ jsonrpc: "2.0", method, params: {} })); }
  async rpc(method: string, params: Record<string, Json>): Promise<Json> {
    const id = ++this.#id;
    return this.#retry(async () => {
      const response = await this.send({ jsonrpc: "2.0", id, method, params });
      if (response === undefined || response.jsonrpc !== "2.0" || response.id !== id || (("result" in response) === ("error" in response))) throw new McpTransportError("Malformed JSON-RPC response");
      if (response.error) throw new McpJsonRpcError(response.error.code, response.error.message, response.error.data);
      return response.result as Json;
    });
  }
  async send(body: Record<string, Json | number | string>): Promise<RpcResponse | undefined> {
    let response: Response;
    try {
      const headers = new Headers(this.headers); headers.set("content-type", "application/json"); headers.set("accept", "application/json, text/event-stream");
      if (this.#sessionId) headers.set("mcp-session-id", this.#sessionId);
      response = await this.request(this.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (error) { throw new McpTransportError(`Network failure: ${error instanceof Error ? error.message : String(error)}`, undefined, true, "network"); }
    const session = response.headers.get("mcp-session-id"); if (session) this.#sessionId = session;
    if (!response.ok) throw new McpTransportError(`HTTP ${String(response.status)}`, response.status, response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500, "http");
    if (!("id" in body) && response.status === 202) return;
    const mediaType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const payload = await response.text();
    try {
      if (mediaType.includes("application/json")) return JSON.parse(payload) as RpcResponse;
      if (mediaType.includes("text/event-stream")) {
        const events = payload.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")).filter(Boolean);
        const event = events.at(-1);
        if (event !== undefined) return JSON.parse(event) as RpcResponse;
      }
    } catch { /* normalize parser errors */ }
    throw new McpTransportError(mediaType.includes("application/json") || mediaType.includes("text/event-stream") ? "Malformed JSON-RPC response" : "Unsupported response media type");
  }
}

const address = (value: unknown, field: string) => { const v = record(value, field); return { address: text(v.address, `${field}.address`), ...(optionalText(v.name, `${field}.name`) !== undefined ? { name: optionalText(v.name, `${field}.name`) } : {}) }; };
const record = (value: unknown, field: string): Record<string, unknown> => { if (!isRecord(value)) throw new McpTransportError(`Malformed ${field}`); return value; };
function attachment(value: unknown): AttachmentMetadata { const v = record(value, "attachment"); return { id: text(v.id, "attachment.id"), name: text(v.name, "attachment.name"), ...(optionalText(v.contentType, "attachment.contentType") !== undefined ? { contentType: optionalText(v.contentType, "attachment.contentType") } : {}), ...(v.size !== undefined ? { size: number(v.size, "attachment.size") } : {}), ...(optionalText(v.webUrl, "attachment.webUrl") !== undefined ? { webUrl: optionalText(v.webUrl, "attachment.webUrl") } : {}), ...(optionalText(v.webUrlUnavailableReason, "attachment.webUrlUnavailableReason") !== undefined ? { webUrlUnavailableReason: optionalText(v.webUrlUnavailableReason, "attachment.webUrlUnavailableReason") } : {}) }; }
const number = (value: unknown, field: string): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new McpTransportError(`Malformed ${field}`); return value; };
const provider = (value: unknown, field: string): Provider => { const result = text(value, field); if (result !== "outlook" && result !== "gmail" && result !== "imap") throw new McpTransportError(`Malformed ${field}`); return result; };
function onboardingAccount(value: unknown, expectedProvider: Provider): OnboardingAccount { const account = record(value, "account"); const selected = provider(account.provider, "account.provider"); if (selected !== expectedProvider) throw new McpTransportError("Account provider mismatch"); return { provider: selected, email: text(account.email, "account.email"), ...(optionalText(account.displayName, "account.displayName") !== undefined ? { displayName: optionalText(account.displayName, "account.displayName") } : {}), ...(optionalText(account.state, "account.state") !== undefined ? { state: optionalText(account.state, "account.state") } : {}) }; }
function addAccountResult(value: unknown, expectedProvider: Provider): AddAccountResult {
  const result = record(value, "add_account response");
  if (result.status === "ready") return { status: "ready", account: onboardingAccount(result.account, expectedProvider) };
  if (result.status !== "pending" || expectedProvider === "imap") throw new McpTransportError("Malformed add_account response");
  const verification = record(result.verification, "add_account.verification"); const type = text(verification.type, "add_account.verification.type");
  if (type !== "device_code" && type !== "oauth_url") throw new McpTransportError("Malformed add_account.verification.type");
  if ((expectedProvider === "outlook" && type !== "device_code") || (expectedProvider === "gmail" && type !== "oauth_url")) throw new McpTransportError("Malformed add_account.verification.type");
  return { status: "pending", handle: text(result.handle, "add_account.handle"), verification: { type, ...(type === "device_code" ? { userCode: text(verification.userCode, "add_account.verification.userCode") } : {}), verificationUri: text(verification.verificationUri, "add_account.verification.verificationUri"), expiresAt: text(verification.expiresAt, "add_account.verification.expiresAt"), message: text(verification.message, "add_account.verification.message") } };
}
function onboardingErrorReason(value: unknown): OnboardingErrorReason {
  if (typeof value !== "string") return "provider_unavailable";
  const message = value.toLowerCase();
  if (message.includes("unknown handle") || message.includes("invalid_grant") || message.includes("expired")) return "authorization_expired";
  if (message.includes("state mismatch") || message.includes("unknown oauth state") || message.includes("missing oauth state")) return "authorization_rejected";
  if (message.includes("invalid_client") || message.includes("unauthorized_client") || message.includes("redirect_uri") || message.includes("client secret") || message.includes("oauth client was not found")) return "provider_configuration";
  if (message.includes("token request failed")) return "token_exchange_failed";
  if (message.includes("failed to get gmail profile") || message.includes("no email returned from google")) return "gmail_profile_failed";
  return "provider_unavailable";
}
function completeAddAccountResult(value: unknown, expectedProvider: Provider): CompleteAddAccountResult {
  const result = record(value, "complete_add_account response");
  if (result.status === "ready") return { status: "ready", account: onboardingAccount(result.account, expectedProvider) };
  if (result.status === "pending" || result.status === "expired") return { status: result.status };
  if (result.status === "error") return { status: "error", reason: onboardingErrorReason(result.error) };
  throw new McpTransportError("Malformed complete_add_account response");
}
function onboardingDiagnostic(value: unknown, source: OnboardingDiagnostic["source"]): OnboardingDiagnostic {
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : "Provider returned no diagnostic text";
  const detail = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/((?:code|state|access_token|refresh_token|client_secret)\s*[=:]\s*)[^\s,;&"']+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .slice(0, 240);
  return { source, reason: onboardingErrorReason(value), detail };
}
function emitOnboardingDiagnostic(callback: HypermailReadClientOptions["onOnboardingDiagnostic"], diagnostic: OnboardingDiagnostic): void {
  try { callback?.(diagnostic); } catch { /* Diagnostics must never affect account onboarding. */ }
}
function addAccountArguments(input: AddAccountInput): Record<string, Json> {
  const request = record(input, "add_account input"); const selected = provider(request.provider, "add_account.provider"); const email = optionalText(request.email, "add_account.email");
  if (selected !== "imap") { if (request.config !== undefined) throw new RangeError("Invalid add_account.config"); return { provider: selected, ...(email !== undefined ? { email } : {}) }; }
  const config = record(request.config, "add_account.config"); const port = config.port === undefined ? undefined : number(config.port, "add_account.config.port"); const smtpPort = config.smtpPort === undefined ? undefined : number(config.smtpPort, "add_account.config.smtpPort");
  if ((port !== undefined && (port < 1 || port > 65_535)) || (smtpPort !== undefined && (smtpPort < 1 || smtpPort > 65_535))) throw new RangeError("Invalid add_account.config port");
  return { provider: selected, ...(email !== undefined ? { email } : {}), config: { host: text(config.host, "add_account.config.host"), ...(port !== undefined ? { port } : {}), ...(bool(config.secure, "add_account.config.secure") !== undefined ? { secure: bool(config.secure, "add_account.config.secure") } : {}), user: text(config.user, "add_account.config.user"), password: text(config.password, "add_account.config.password"), ...(optionalText(config.smtpHost, "add_account.config.smtpHost") !== undefined ? { smtpHost: optionalText(config.smtpHost, "add_account.config.smtpHost") } : {}), ...(smtpPort !== undefined ? { smtpPort } : {}), ...(bool(config.smtpSecure, "add_account.config.smtpSecure") !== undefined ? { smtpSecure: bool(config.smtpSecure, "add_account.config.smtpSecure") } : {}) } };
}
function completeAddAccountArguments(input: CompleteAddAccountInput): Record<string, Json> { const request = record(input, "complete_add_account input"); return { provider: provider(request.provider, "complete_add_account.provider"), handle: text(request.handle, "complete_add_account.handle"), ...(optionalText(request.authorizationResponse, "complete_add_account.authorizationResponse") !== undefined ? { authorizationResponse: optionalText(request.authorizationResponse, "complete_add_account.authorizationResponse") } : {}), ...(optionalText(request.code, "complete_add_account.code") !== undefined ? { code: optionalText(request.code, "complete_add_account.code") } : {}), ...(optionalText(request.state, "complete_add_account.state") !== undefined ? { state: optionalText(request.state, "complete_add_account.state") } : {}) }; }
function message(value: unknown, expectedAccount?: string, includeBody = false): Message {
  const v = record(value, "message"); const projectedAccount = optionalText(v.account, "message.account"); const account = projectedAccount ?? expectedAccount;
  if (!account) throw new McpTransportError("Malformed message.account"); if (expectedAccount && account !== expectedAccount) throw new McpTransportError("Account isolation violation");
  const mapAddresses = (raw: unknown, field: string) => raw === undefined ? undefined : Array.isArray(raw) ? raw.map((entry) => address(entry, field)) : (() => { throw new McpTransportError(`Malformed ${field}`); })();
  const attachments = v.attachments === undefined ? undefined : Array.isArray(v.attachments) ? v.attachments.map(attachment) : (() => { throw new McpTransportError("Malformed message.attachments"); })();
  const bodyFormat = optionalText(v.bodyFormat, "message.bodyFormat");
  if (bodyFormat !== undefined && bodyFormat !== "markdown" && bodyFormat !== "html" && bodyFormat !== "text") throw new McpTransportError("Malformed message.bodyFormat");
  return { id: text(v.id, "message.id"), account, ...(optionalText(v.subject, "message.subject") !== undefined ? { subject: optionalText(v.subject, "message.subject") } : {}), ...(v.from !== undefined ? { from: address(v.from, "message.from") } : {}), ...(mapAddresses(v.to, "message.to") ? { to: mapAddresses(v.to, "message.to") } : {}), ...(mapAddresses(v.cc, "message.cc") ? { cc: mapAddresses(v.cc, "message.cc") } : {}), ...(optionalText(v.receivedAt, "message.receivedAt") !== undefined ? { receivedAt: optionalText(v.receivedAt, "message.receivedAt") } : {}), ...(bool(v.isRead, "message.isRead") !== undefined ? { isRead: bool(v.isRead, "message.isRead") } : {}), ...(optionalText(v.folder, "message.folder") !== undefined ? { folder: optionalText(v.folder, "message.folder") } : {}), ...(includeBody && optionalText(v.body, "message.body") !== undefined ? { body: optionalText(v.body, "message.body") } : {}), ...(includeBody && bodyFormat !== undefined ? { bodyFormat } : {}), ...(attachments ? { attachments } : {}) };
}

/** Mirrors the pinned runtime's Markdown draft composition for safe exact-text selection. */
export const renderDraftMarkdown = (body: string): string => marked.parse(body, { async: false });

const draftMutationResult = (value: unknown, flag: "draft" | "edited"): DraftMutationResult => {
  const result = record(value, `${flag} response`);
  if (result[flag] !== true) throw new McpTransportError(`Malformed ${flag} response`);
  return { id: text(result.id, `${flag}.id`), ...(optionalText(result.draftHtml, `${flag}.draftHtml`) !== undefined ? { draftHtml: optionalText(result.draftHtml, `${flag}.draftHtml`) } : {}) };
};
const draftAddresses = (items: DraftCreateInput["to"] | undefined): Json[] | undefined => items?.map((item) => ({ address: text(item.address, "recipient.address"), ...(optionalText(item.name, "recipient.name") !== undefined ? { name: optionalText(item.name, "recipient.name") } : {}) }));
const policyMutationResult = (value: unknown, flag: "archived" | "trashed" | "moved" | "marked", expected?: Readonly<Record<string, unknown>>): PolicyMutationResult => {
  const result = record(value, `${flag} response`); if (result[flag] !== true) throw new McpTransportError(`Malformed ${flag} response`);
  for (const [field, wanted] of Object.entries(expected ?? {})) if (result[field] !== wanted) throw new McpTransportError(`Malformed ${flag}.${field}`);
  return { id: text(result.id, `${flag}.id`) };
};

/** Restricted write client for autonomous policy. It intentionally exposes drafts only, never send, forward, account admin, or folder admin. */
export class HypermailPolicyClient {
  constructor(private readonly transport: Pick<HypermailMcpHttpClient, "call">) {}
  async archive(account: string, id: string): Promise<PolicyMutationResult> { return policyMutationResult(await this.transport.call("archive_email", { account, id }), "archived"); }
  async trash(account: string, id: string): Promise<PolicyMutationResult> { return policyMutationResult(await this.transport.call("trash_email", { account, id }), "trashed"); }
  async move(account: string, id: string, destination: string): Promise<PolicyMutationResult> { return policyMutationResult(await this.transport.call("move_email", { account, id, destination }), "moved", { destination }); }
  async mark(account: string, id: string, isRead: boolean): Promise<PolicyMutationResult> { return policyMutationResult(await this.transport.call(isRead ? "mark_read" : "mark_unread", { account, id }), "marked", { isRead }); }
  async containsMessageInFolder(account: string, id: string, folder: string, maximumPages = 5): Promise<boolean> {
    for (let page = 0; page < maximumPages; page += 1) {
      const result = record(await this.transport.call("list_emails", { account, folder, skip: page * 100, limit: 100 }), "list_emails");
      if (!Array.isArray(result.items) || typeof result.hasMore !== "boolean") throw new McpTransportError("Malformed list_emails response");
      if (result.items.some((raw) => record(raw, "message").id === id)) return true; if (!result.hasMore) return false;
    }
    return false;
  }
  async createDraft(input: DraftCreateInput): Promise<DraftMutationResult> {
    return draftMutationResult(await this.transport.call("draft_email", {
      account: text(input.account, "draft.account"), to: draftAddresses(input.to) ?? [], ...(input.cc ? { cc: draftAddresses(input.cc) ?? [] } : {}), ...(input.bcc ? { bcc: draftAddresses(input.bcc) ?? [] } : {}),
      subject: input.subject, body: input.body, format: input.bodyFormat, include_signature: false, inReplyTo: input.inReplyTo ?? false,
    }), "draft");
  }
  async editDraft(input: DraftEditInput): Promise<DraftMutationResult> {
    if ((input.oldText === undefined) !== (input.newText === undefined) || input.oldText === "") throw new RangeError("Draft body edits require one non-empty oldText and its newText replacement");
    const bodyEdit: Record<string, Json> = input.oldText !== undefined && input.newText !== undefined ? { old_text: input.oldText, new_text: input.newText, format: input.bodyFormat, include_signature: false } : {};
    return draftMutationResult(await this.transport.call("edit_draft", {
      account: text(input.account, "draft.account"), id: text(input.id, "draft.id"), ...(input.to ? { to: draftAddresses(input.to) ?? [] } : {}), ...(input.cc ? { cc: draftAddresses(input.cc) ?? [] } : {}), ...(input.bcc ? { bcc: draftAddresses(input.bcc) ?? [] } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}), ...bodyEdit,
    }), "edited");
  }
  async readDraft(account: string, id: string, format: "markdown" | "html" | "text" = "html"): Promise<Message> { return message(await this.transport.call("read_email", { account, id, format }), account, true); }
}

const policyToolContracts = {
  list_emails: { input: ["account", "folder", "limit", "skip"], required: ["account"], output: ["items", "hasMore"] },
  read_email: { input: ["account", "id", "format"], required: ["account", "id"] },
  archive_email: { input: ["account", "id"], required: ["account", "id"], output: ["archived", "id"], flag: "archived" },
  trash_email: { input: ["account", "id"], required: ["account", "id"], output: ["trashed", "id"], flag: "trashed" },
  move_email: { input: ["account", "id", "destination"], required: ["account", "id", "destination"], output: ["moved", "id", "destination"], flag: "moved" },
  mark_read: { input: ["account", "id"], required: ["account", "id"], output: ["marked", "id", "isRead"], flag: "marked" },
  mark_unread: { input: ["account", "id"], required: ["account", "id"], output: ["marked", "id", "isRead"], flag: "marked" },
  draft_email: { input: ["account", "to", "subject", "body", "format", "include_signature", "inReplyTo"], required: ["account", "to", "subject", "body", "format", "include_signature"], output: ["draft", "id"], flag: "draft" },
  edit_draft: { input: ["account", "id", "old_text", "new_text"], required: ["account", "id"], output: ["edited", "id"], flag: "edited" },
} as const;
const policyInputTypes: Record<string, Record<string, "string" | "number" | "boolean" | "array">> = {
  list_emails: { account: "string", folder: "string", limit: "number", skip: "number" }, read_email: { account: "string", id: "string", format: "string" },
  archive_email: { account: "string", id: "string" }, trash_email: { account: "string", id: "string" }, move_email: { account: "string", id: "string", destination: "string" },
  mark_read: { account: "string", id: "string" }, mark_unread: { account: "string", id: "string" },
  draft_email: { account: "string", to: "array", subject: "string", body: "string", format: "string", include_signature: "boolean" },
  edit_draft: { account: "string", id: "string", old_text: "string", new_text: "string" },
};
const policyOutputTypes: Record<string, Record<string, "string" | "boolean" | "array">> = {
  list_emails: { items: "array", hasMore: "boolean" }, archive_email: { id: "string" }, trash_email: { id: "string" }, move_email: { id: "string", destination: "string" },
  mark_read: { id: "string", isRead: "boolean" }, mark_unread: { id: "string", isRead: "boolean" }, draft_email: { id: "string" }, edit_draft: { id: "string" },
};
const schemaVariants = (value: unknown): Record<string, unknown>[] => {
  if (!isRecord(value)) return []; const nested = [value.anyOf, value.oneOf].flatMap((item) => Array.isArray(item) ? item.filter(isRecord) : []); return [value, ...nested];
};
const hasSchemaType = (value: unknown, type: string): boolean => schemaVariants(value).some((schema) => schema.type === type || (type === "number" && schema.type === "integer") || (type === "boolean" && typeof schema.const === "boolean"));
const hasSchemaEnum = (value: unknown, values: readonly unknown[]): boolean => schemaVariants(value).some((schema) => {
  const enumeration: unknown = schema.enum; if (!Array.isArray(enumeration)) return false; const items = enumeration as unknown[];
  return values.every((wanted) => items.some((item) => Object.is(item, wanted)));
});

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) throw new McpTransportError(`Malformed ${field}`); const result: string[] = [];
  for (const item of value as unknown[]) { if (typeof item !== "string") throw new McpTransportError(`Malformed ${field}`); result.push(item); }
  return result;
};
function verifyPolicyTools(value: unknown): void {
  const result = record(value, "tools/list");
  if (!Array.isArray(result.tools)) throw new McpTransportError("Malformed tools/list.tools");
  const tools = new Map(result.tools.map((raw) => { const tool = record(raw, "tool"); return [text(tool.name, "tool.name"), tool] as const; }));
  for (const [name, contract] of Object.entries(policyToolContracts)) {
    const tool = tools.get(name); if (!tool) throw new McpTransportError(`Missing policy tool ${name}`);
    const input = record(tool.inputSchema, `${name}.inputSchema`); const properties = record(input.properties, `${name}.inputSchema.properties`); const required = new Set(stringArray(input.required, `${name}.inputSchema.required`));
    if (contract.input.some((field) => !(field in properties)) || contract.required.some((field) => !required.has(field))) throw new McpTransportError(`Malformed ${name} input schema`);
    if (Object.entries(policyInputTypes[name] ?? {}).some(([field, type]) => !hasSchemaType(properties[field], type))) throw new McpTransportError(`Incompatible ${name} input schema`);
    if (name === "draft_email" && (!hasSchemaType(properties["inReplyTo"], "string") || !hasSchemaType(properties["inReplyTo"], "boolean") || !hasSchemaEnum(properties["format"], ["html", "markdown"]))) throw new McpTransportError("Incompatible draft_email input schema");
    if (name === "read_email" && !hasSchemaEnum(properties["format"], ["html", "markdown", "text"])) throw new McpTransportError("Incompatible read_email input schema");
    if ("output" in contract) {
      const output = record(tool.outputSchema, `${name}.outputSchema`); const outputProperties = record(output.properties, `${name}.outputSchema.properties`); const outputRequired = new Set(stringArray(output.required, `${name}.outputSchema.required`));
      if (contract.output.some((field) => !(field in outputProperties) || !outputRequired.has(field))) throw new McpTransportError(`Malformed ${name} output schema`);
      if (Object.entries(policyOutputTypes[name] ?? {}).some(([field, type]) => !hasSchemaType(outputProperties[field], type))) throw new McpTransportError(`Incompatible ${name} output schema`);
      if ("flag" in contract) { const flag = record(outputProperties[contract.flag], `${name}.outputSchema.${contract.flag}`); if (flag.const !== true && (!Array.isArray(flag.enum) || !flag.enum.includes(true))) throw new McpTransportError(`Malformed ${name} success flag`); }
    }
  }
}

export class HypermailReadClient {
  readonly transport: HypermailMcpHttpClient;
  #accounts?: { value: Account[]; expires: number }; #folders = new Map<string, { value: Folder[]; expires: number }>(); #policyContract?: Promise<void>;
  #accountTtl: number; #folderTtl: number;
  constructor(private readonly options: HypermailReadClientOptions) {
    this.transport = new HypermailMcpHttpClient(options.endpoint, options.fetch, options.headers, options.maxRetries ?? 0);
    this.#accountTtl = options.accountCacheTtlMs ?? 60_000; this.#folderTtl = options.folderCacheTtlMs ?? 60_000;
  }
  async initialize(): Promise<Json> { return this.transport.initialize(this.options.protocolVersion); }
  /** Validates the pinned runtime's restricted mutation surface without performing provider I/O. */
  verifyPolicyContract(): Promise<void> {
    if (!this.#policyContract) this.#policyContract = this.transport.listTools().then(verifyPolicyTools).catch((error: unknown) => { this.#policyContract = undefined; throw error; });
    return this.#policyContract;
  }
  /** Starts an explicit user-controlled account onboarding flow; callers initialize this client first, as with read methods. */
  async addAccount(input: AddAccountInput): Promise<AddAccountResult> { const result = addAccountResult(await this.transport.call("add_account", addAccountArguments(input)), provider(input.provider, "add_account.provider")); if (result.status === "ready") this.#accounts = undefined; return result; }
  /** Polls or finalizes an explicit user-controlled account onboarding flow. Server error text is never surfaced. */
  async completeAddAccount(input: CompleteAddAccountInput): Promise<CompleteAddAccountResult> {
    let raw: Json;
    try { raw = await this.transport.call("complete_add_account", completeAddAccountArguments(input)); }
    catch (error) { emitOnboardingDiagnostic(this.options.onOnboardingDiagnostic, onboardingDiagnostic(error, "transport")); throw error; }
    const result = completeAddAccountResult(raw, provider(input.provider, "complete_add_account.provider"));
    if (result.status === "error") emitOnboardingDiagnostic(this.options.onOnboardingDiagnostic, onboardingDiagnostic(isRecord(raw) ? raw.error : undefined, "provider_result"));
    if (result.status === "ready") this.#accounts = undefined;
    return result;
  }
  async accounts(force = false): Promise<Account[]> {
    if (!force && this.#accounts && this.#accounts.expires > Date.now()) return this.#accounts.value;
    const result = record(await this.transport.call("list_accounts", {}), "list_accounts"); if (!Array.isArray(result.accounts)) throw new McpTransportError("Malformed list_accounts.accounts");
    const accounts = result.accounts.map((raw) => { const a = record(raw, "account"); const provider = text(a.provider, "account.provider"); if (provider !== "outlook" && provider !== "gmail" && provider !== "imap") throw new McpTransportError("Malformed account.provider"); return { email: text(a.email, "account.email"), provider, ...(optionalText(a.displayName, "account.displayName") !== undefined ? { displayName: optionalText(a.displayName, "account.displayName") } : {}), ...(optionalText(a.addedAt, "account.addedAt") !== undefined ? { addedAt: optionalText(a.addedAt, "account.addedAt") } : {}), ...(bool(a.hasSignature, "account.hasSignature") !== undefined ? { hasSignature: bool(a.hasSignature, "account.hasSignature") } : {}), ...(bool(a.hasStyle, "account.hasStyle") !== undefined ? { hasStyle: bool(a.hasStyle, "account.hasStyle") } : {}), } satisfies Account; });
    if (new Set(accounts.map((a) => a.email)).size !== accounts.length) throw new McpTransportError("Duplicate account projection"); this.#accounts = { value: accounts, expires: Date.now() + this.#accountTtl }; return accounts;
  }
  async folders(account: string, parentFolderId?: string): Promise<Folder[]> {
    const key = `${account}\u0000${parentFolderId ?? ""}`, cached = this.#folders.get(key); if (cached && cached.expires > Date.now()) return cached.value;
    const result = record(await this.transport.call("list_folders", { account, ...(parentFolderId ? { parentFolderId } : {}) }), "list_folders"); if (!Array.isArray(result.items)) throw new McpTransportError("Malformed list_folders.items");
    const folders = result.items.map((raw) => { const f = record(raw, "folder"); return { id: text(f.id, "folder.id"), displayName: text(f.displayName, "folder.displayName"), ...(optionalText(f.parentFolderId, "folder.parentFolderId") !== undefined ? { parentFolderId: optionalText(f.parentFolderId, "folder.parentFolderId") } : {}), ...(optionalText(f.wellKnownName, "folder.wellKnownName") !== undefined ? { wellKnownName: optionalText(f.wellKnownName, "folder.wellKnownName") } : {}) }; });
    this.#folders.set(key, { value: folders, expires: Date.now() + this.#folderTtl }); return folders;
  }
  async inbox(input: { account?: string; cursor?: string; limit?: number } = {}): Promise<InboxPage> {
    const limit = positive(input.limit, "limit"); const scope = input.account ? "account" : "all"; const cursor = decodeCursor(input.cursor, scope, input.account);
    const accounts = input.account ? [input.account] : (await this.accounts()).map((a) => a.email);
    const pages = await Promise.all(accounts.map(async (account) => ({ account, result: await this.listEmails(account, cursor.offsets[account] ?? 0, 100) })));
    const all = pages.flatMap(({ account, result }) => result.messages.map((item) => ({ ...item, account }))).sort((a, b) => Date.parse(b.receivedAt ?? "") - Date.parse(a.receivedAt ?? ""));
    const messages = all.slice(0, limit); const offsets = { ...cursor.offsets }; for (const item of messages) offsets[item.account] = (offsets[item.account] ?? 0) + 1;
    const hasMore = all.length > messages.length || pages.some(({ result }) => result.hasMore); const next = hasMore ? encodeCursor({ scope, ...(input.account ? { account: input.account } : {}), offsets }) : undefined;
    return { messages, hasMore, ...(next ? { cursor: next } : {}), ...(input.account ? { account: input.account } : {}) };
  }
  async mailboxPage(account: string, input: { folder?: string; skip?: number; limit?: number } = {}): Promise<MessagePage> {
    const page = await this.listEmails(account, input.skip ?? 0, positive(input.limit, "limit"), input.folder);
    return { messages: page.messages, hasMore: page.hasMore };
  }
  async readMessage(account: string, id: string, format: "markdown" | "html" | "text" = "markdown"): Promise<Message> { return message(await this.transport.call("read_email", { account, id, format }), account, true); }
  async search(options: SearchOptions): Promise<Message[]> {
    if (!options.query && !options.from && !options.to && !options.cc) throw new RangeError("search requires at least one criterion");
    const result = record(await this.transport.call("search_emails", { ...options, limit: positive(options.limit, "limit") }), "search_emails"); if (!Array.isArray(result.items)) throw new McpTransportError("Malformed search_emails.items"); return result.items.map((raw) => message(raw));
  }
  /** Establishes the provider's Inbox checkpoint and deliberately never returns mail content. */
  async establishBaseline(account?: string): Promise<void> { await this.transport.call("get_new_emails", account ? { account, limit: 0 } : { limit: 0 }); }
  async pollNewInbox(account?: string, limit = 25): Promise<Message[]> { const result = record(await this.transport.call("get_new_emails", { ...(account ? { account } : {}), limit: positive(limit, "limit") }), "get_new_emails"); if (!Array.isArray(result.emails)) throw new McpTransportError("Malformed get_new_emails.emails"); return result.emails.map((raw) => message(raw, account)); }
  async openAttachment(account: string, messageId: string, attachmentId: string, options: AttachmentStreamOptions): Promise<AttachmentStream> {
    const result = record(await this.transport.call("read_attachment", { account, messageId, attachmentId }), "read_attachment"); const metadata = attachment({ ...result, id: attachmentId }); const path = text(result.path, "read_attachment.path"); return AttachmentStream.open(metadata, path, options);
  }
  private async listEmails(account: string, skip: number, limit: number, folder?: string): Promise<{ messages: Message[]; hasMore: boolean }> { const result = record(await this.transport.call("list_emails", { account, folder: folder ?? "inbox", skip, limit }), "list_emails"); if (!Array.isArray(result.items) || typeof result.hasMore !== "boolean") throw new McpTransportError("Malformed list_emails response"); return { messages: result.items.map((raw) => message(raw, account)), hasMore: result.hasMore }; }
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decodeCursor(value: string | undefined, scope: Cursor["scope"], account?: string): Cursor { if (!value) return { scope, ...(account ? { account } : {}), offsets: {} }; try { const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; const cursor = record(raw, "cursor"); if (cursor.scope !== scope || cursor.account !== account || !isRecord(cursor.offsets)) throw new Error(); const offsets = Object.fromEntries(Object.entries(cursor.offsets).map(([key, offset]) => [key, number(offset, "cursor offset")])); return { scope, ...(account ? { account } : {}), offsets }; } catch { throw new RangeError("Invalid Inbox cursor"); } }
