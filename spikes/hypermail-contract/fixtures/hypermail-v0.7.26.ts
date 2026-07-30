import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Json, Provider } from "../src/types.ts";

/** Sanitized, provider-neutral fixture proof; it is not a Hypermail implementation or live validation. */
export const accounts = [
  { email: "outlook@example.test", provider: "outlook" as Provider, displayName: "Outlook Fixture", addedAt: "2026-01-01T00:00:00Z", hasSignature: false, hasStyle: false },
  { email: "gmail@example.test", provider: "gmail" as Provider, displayName: "Gmail Fixture", addedAt: "2026-01-02T00:00:00Z", hasSignature: true, hasStyle: true },
  { email: "imap@example.test", provider: "imap" as Provider, displayName: "IMAP Fixture", addedAt: "2026-01-03T00:00:00Z", hasSignature: false, hasStyle: false }
];
export const inbox = [
  { id: "msg-001", account: "gmail@example.test", subject: "First", from: { address: "sender@example.test" }, receivedAt: "2026-01-01T10:00:00Z", isRead: false },
  { id: "msg-002", account: "gmail@example.test", subject: "Second", from: { address: "sender@example.test" }, receivedAt: "2026-01-02T10:00:00Z", isRead: false }
];
export const capabilities = {
  outlook: { onboarding: "device_code", webUrl: "graph-or-owa", perToolMatrix: "unknown" },
  gmail: { onboarding: "oauth_url", webUrl: "best-effort-unofficial", perToolMatrix: "unknown" },
  imap: { onboarding: "synchronous-config", webUrl: "unavailable-reason", perToolMatrix: "unknown" }
} as const;

const tools = ["list_accounts", "add_account", "complete_add_account", "get_account_settings", "set_account_settings", "remove_account", "list_emails", "search_emails", "read_email", "read_attachment", "get_new_emails", "list_folders", "create_folder", "delete_folder", "rename_folder", "draft_email", "edit_draft", "send_draft", "send_email", "move_email", "archive_email", "trash_email", "mark_read", "mark_unread"];
export async function startFixtureServer(mode: "normal" | "malformed" | "http-503" = "normal") {
  const checkpoints = new Set<string>();
  let sawSession = false;
  const server = createServer(async (req, res) => {
    if (req.headers["mcp-session-id"] === "fixture-session") sawSession = true;
    const raw = await new Promise<string>((resolve) => { let body = ""; req.on("data", (c) => body += c); req.on("end", () => resolve(body)); });
    if (mode === "http-503") { res.writeHead(503); res.end("temporary"); return; }
    if (mode === "malformed") { res.writeHead(200, { "content-type": "application/json" }); res.end("{bad"); return; }
    const request = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, Json> } };
    const reply = (result?: Json, error?: { code: number; message: string }) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, ...(error ? { error } : { result }) })); };
    if (request.method === "notifications/initialized") return reply({});
    if (request.method === "initialize") return reply({ protocolVersion: "fixture", serverInfo: { name: "fixture", version: "0" }, capabilities: {} });
    if (request.method === "tools/list") return reply({ tools: tools.map((name) => ({ name })) });
    if (request.method !== "tools/call" || !request.params?.name) return reply(undefined, { code: -32601, message: "Method not found" });
    const name = request.params.name, a = request.params.arguments ?? {};
    if (name === "list_accounts") return reply({ accounts });
    if (name === "list_emails") { const skip = Number(a.skip ?? 0), limit = Number(a.limit ?? 25); return reply({ emails: inbox.slice(skip, skip + limit), hasMore: skip + limit < inbox.length }); }
    if (name === "get_new_emails") { const account = String(a.account ?? "all"); if (!checkpoints.has(account)) { checkpoints.add(account); return reply({ emails: [], initialized: true }); } return reply({ emails: inbox.slice(0, Number(a.limit ?? 10)), initialized: false }); }
    if (name === "list_folders") return reply({ folders: [{ id: "inbox", displayName: "Inbox" }, { id: "archive", displayName: "Archive" }] });
    if (name === "search_emails") return reply({ emails: inbox.filter((m) => m.subject.toLowerCase().includes(String(a.query ?? "").toLowerCase())) });
    if (name === "read_email") return reply({ ...inbox[0], body: "Sanitized body", attachments: [{ id: "att-001", name: "fixture.txt", contentType: "text/plain", size: 9 }] });
    if (name === "read_attachment") return reply({ name: "fixture.txt", contentType: "text/plain", path: "/tmp/hypermail-fixture.txt", webUrlUnavailableReason: "fixture" });
    if (["draft_email", "edit_draft", "send_draft", "send_email", "move_email", "archive_email", "trash_email", "mark_read", "mark_unread"].includes(name)) return reply({ id: "result-001", status: "fixture-only" });
    return reply(undefined, { code: -32602, message: "Unsupported fixture tool" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}/mcp`, get sawSession() { return sawSession; }, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
