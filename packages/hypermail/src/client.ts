import { AttachmentStream } from "./attachments.js";
import type { Account, AttachmentMetadata, AttachmentStreamOptions, Folder, HypermailReadClientOptions, InboxPage, Json, Message, RetryClassification, SearchOptions } from "./types.js";

const retryableRpcCodes = new Set([-32001, -32002, -32003]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
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
  async call<T extends Json = Json>(name: string, args: Record<string, Json>): Promise<T> { return this.rpc("tools/call", { name, arguments: args }) as Promise<T>; }

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
function message(value: unknown, expectedAccount?: string, includeBody = false): Message {
  const v = record(value, "message"); const account = text(v.account, "message.account"); if (expectedAccount && account !== expectedAccount) throw new McpTransportError("Account isolation violation");
  const mapAddresses = (raw: unknown, field: string) => raw === undefined ? undefined : Array.isArray(raw) ? raw.map((entry) => address(entry, field)) : (() => { throw new McpTransportError(`Malformed ${field}`); })();
  const attachments = v.attachments === undefined ? undefined : Array.isArray(v.attachments) ? v.attachments.map(attachment) : (() => { throw new McpTransportError("Malformed message.attachments"); })();
  return { id: text(v.id, "message.id"), account, ...(optionalText(v.subject, "message.subject") !== undefined ? { subject: optionalText(v.subject, "message.subject") } : {}), ...(v.from !== undefined ? { from: address(v.from, "message.from") } : {}), ...(mapAddresses(v.to, "message.to") ? { to: mapAddresses(v.to, "message.to") } : {}), ...(mapAddresses(v.cc, "message.cc") ? { cc: mapAddresses(v.cc, "message.cc") } : {}), ...(optionalText(v.receivedAt, "message.receivedAt") !== undefined ? { receivedAt: optionalText(v.receivedAt, "message.receivedAt") } : {}), ...(bool(v.isRead, "message.isRead") !== undefined ? { isRead: bool(v.isRead, "message.isRead") } : {}), ...(includeBody && optionalText(v.body, "message.body") !== undefined ? { body: optionalText(v.body, "message.body") } : {}), ...(attachments ? { attachments } : {}) };
}

export class HypermailReadClient {
  readonly transport: HypermailMcpHttpClient;
  #accounts?: { value: Account[]; expires: number }; #folders = new Map<string, { value: Folder[]; expires: number }>();
  #accountTtl: number; #folderTtl: number;
  constructor(private readonly options: HypermailReadClientOptions) {
    this.transport = new HypermailMcpHttpClient(options.endpoint, options.fetch, options.headers, options.maxRetries ?? 0);
    this.#accountTtl = options.accountCacheTtlMs ?? 60_000; this.#folderTtl = options.folderCacheTtlMs ?? 60_000;
  }
  async initialize(): Promise<Json> { return this.transport.initialize(this.options.protocolVersion); }
  async accounts(force = false): Promise<Account[]> {
    if (!force && this.#accounts && this.#accounts.expires > Date.now()) return this.#accounts.value;
    const result = record(await this.transport.call("list_accounts", {}), "list_accounts"); if (!Array.isArray(result.accounts)) throw new McpTransportError("Malformed list_accounts.accounts");
    const accounts = result.accounts.map((raw) => { const a = record(raw, "account"); const provider = text(a.provider, "account.provider"); if (provider !== "outlook" && provider !== "gmail" && provider !== "imap") throw new McpTransportError("Malformed account.provider"); return { email: text(a.email, "account.email"), provider, ...(optionalText(a.displayName, "account.displayName") !== undefined ? { displayName: optionalText(a.displayName, "account.displayName") } : {}), ...(optionalText(a.addedAt, "account.addedAt") !== undefined ? { addedAt: optionalText(a.addedAt, "account.addedAt") } : {}), ...(bool(a.hasSignature, "account.hasSignature") !== undefined ? { hasSignature: bool(a.hasSignature, "account.hasSignature") } : {}), ...(bool(a.hasStyle, "account.hasStyle") !== undefined ? { hasStyle: bool(a.hasStyle, "account.hasStyle") } : {}), } satisfies Account; });
    if (new Set(accounts.map((a) => a.email)).size !== accounts.length) throw new McpTransportError("Duplicate account projection"); this.#accounts = { value: accounts, expires: Date.now() + this.#accountTtl }; return accounts;
  }
  async folders(account: string, parentFolderId?: string): Promise<Folder[]> {
    const key = `${account}\u0000${parentFolderId ?? ""}`, cached = this.#folders.get(key); if (cached && cached.expires > Date.now()) return cached.value;
    const result = record(await this.transport.call("list_folders", { account, ...(parentFolderId ? { parentFolderId } : {}) }), "list_folders"); if (!Array.isArray(result.folders)) throw new McpTransportError("Malformed list_folders.folders");
    const folders = result.folders.map((raw) => { const f = record(raw, "folder"); return { id: text(f.id, "folder.id"), displayName: text(f.displayName, "folder.displayName"), ...(optionalText(f.parentFolderId, "folder.parentFolderId") !== undefined ? { parentFolderId: optionalText(f.parentFolderId, "folder.parentFolderId") } : {}), ...(optionalText(f.wellKnownName, "folder.wellKnownName") !== undefined ? { wellKnownName: optionalText(f.wellKnownName, "folder.wellKnownName") } : {}) }; });
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
  async readMessage(account: string, id: string, format: "markdown" | "html" | "text" = "markdown"): Promise<Message> { return message(await this.transport.call("read_email", { account, id, format }), account, true); }
  async search(options: SearchOptions): Promise<Message[]> {
    if (!options.query && !options.from && !options.to && !options.cc) throw new RangeError("search requires at least one criterion");
    const result = record(await this.transport.call("search_emails", { ...options, limit: positive(options.limit, "limit") }), "search_emails"); if (!Array.isArray(result.emails)) throw new McpTransportError("Malformed search_emails.emails"); return result.emails.map((raw) => message(raw));
  }
  /** Establishes the provider's Inbox checkpoint and deliberately never returns mail content. */
  async establishBaseline(account?: string): Promise<void> { await this.transport.call("get_new_emails", account ? { account, limit: 0 } : { limit: 0 }); }
  async pollNewInbox(account?: string, limit = 25): Promise<Message[]> { const result = record(await this.transport.call("get_new_emails", { ...(account ? { account } : {}), limit: positive(limit, "limit") }), "get_new_emails"); if (!Array.isArray(result.emails)) throw new McpTransportError("Malformed get_new_emails.emails"); return result.emails.map((raw) => message(raw, account)); }
  async openAttachment(account: string, messageId: string, attachmentId: string, options: AttachmentStreamOptions): Promise<AttachmentStream> {
    const result = record(await this.transport.call("read_attachment", { account, messageId, attachmentId }), "read_attachment"); const metadata = attachment({ ...result, id: attachmentId }); const path = text(result.path, "read_attachment.path"); return AttachmentStream.open(metadata, path, options);
  }
  private async listEmails(account: string, skip: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> { const result = record(await this.transport.call("list_emails", { account, folder: "inbox", skip, limit }), "list_emails"); if (!Array.isArray(result.emails) || typeof result.hasMore !== "boolean") throw new McpTransportError("Malformed list_emails response"); return { messages: result.emails.map((raw) => message(raw, account)), hasMore: result.hasMore }; }
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decodeCursor(value: string | undefined, scope: Cursor["scope"], account?: string): Cursor { if (!value) return { scope, ...(account ? { account } : {}), offsets: {} }; try { const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; const cursor = record(raw, "cursor"); if (cursor.scope !== scope || cursor.account !== account || !isRecord(cursor.offsets)) throw new Error(); const offsets = Object.fromEntries(Object.entries(cursor.offsets).map(([key, offset]) => [key, number(offset, "cursor offset")])); return { scope, ...(account ? { account } : {}), offsets }; } catch { throw new RangeError("Invalid Inbox cursor"); } }
