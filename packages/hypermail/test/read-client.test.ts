import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { HypermailReadClient, McpTransportError, contentDisposition } from "../src/index.js";

type Request = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const accounts = [
  { email: "outlook@example.test", provider: "outlook", displayName: "Microsoft" },
  { email: "gmail@example.test", provider: "gmail", displayName: "Google" },
  { email: "imap@example.test", provider: "imap", displayName: "IMAP" }
];
function fakeServer(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Request[] = []; const headers: Headers[] = [];
  const request: typeof fetch = (_url, init) => {
    headers.push(new Headers(init?.headers)); const payload = init?.body; if (typeof payload !== "string") throw new Error("Expected JSON request body"); const body = JSON.parse(payload) as Request; calls.push(body);
    const name = body.params?.name;
    const result = overrides[name ?? body.method] ?? (() => {
      if (body.method === "initialize") return { protocolVersion: "deployment", capabilities: {} };
      if (body.method === "notifications/initialized") return {};
      if (name === "list_accounts") return { accounts };
      if (name === "list_folders") return { folders: [{ id: "inbox", displayName: "Inbox" }] };
      if (name === "list_emails") { const a = body.params?.arguments?.account as string; const skip = Number(body.params?.arguments?.skip ?? 0); const messages = [{ id: `${a}-1`, account: a, subject: a, receivedAt: a.startsWith("gmail") ? "2026-01-03T00:00:00Z" : "2026-01-02T00:00:00Z" }, { id: `${a}-2`, account: a, receivedAt: "2026-01-01T00:00:00Z" }]; return { emails: messages.slice(skip), hasMore: false }; }
      if (name === "search_emails") return { emails: [{ id: "search", account: "gmail@example.test" }] };
      if (name === "get_new_emails") return { emails: [] };
      return {};
    })();
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }), { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } }));
  };
  return { request, calls, headers };
}
function client(server: ReturnType<typeof fakeServer>) { return new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "deployment", fetch: server.request, headers: { authorization: "Bearer private" }, accountCacheTtlMs: 60_000, folderCacheTtlMs: 60_000 }); }

describe("Hypermail read worker", () => {
  it("projects Microsoft/Gmail/IMAP accounts without credential fields and keeps auth/session headers", async () => {
    const server = fakeServer(), subject = client(server); await subject.initialize(); const projected = await subject.accounts();
    expect(projected.map((account) => account.provider)).toEqual(["outlook", "gmail", "imap"]);
    expect(projected[0]).not.toHaveProperty("config"); expect(server.headers[0]?.get("authorization")).toBe("Bearer private");
    expect(server.headers.at(-1)?.get("mcp-session-id")).toBe("session-1");
  });
  it("uses cached account/folder projections and validates malformed provider-neutral responses", async () => {
    const server = fakeServer(), subject = client(server); await subject.accounts(); await subject.accounts(); await subject.folders("gmail@example.test"); await subject.folders("gmail@example.test");
    expect(server.calls.filter((call) => call.params?.name === "list_accounts")).toHaveLength(1); expect(server.calls.filter((call) => call.params?.name === "list_folders")).toHaveLength(1);
    const malformed = client(fakeServer({ list_accounts: { accounts: [{ email: "x", provider: "exchange" }] } })); await expect(malformed.accounts()).rejects.toBeInstanceOf(McpTransportError);
  });
  it("paginates unified and account Inbox cursors without leaking account messages", async () => {
    const server = fakeServer(), subject = client(server); const first = await subject.inbox({ limit: 2 });
    expect(first.messages).toHaveLength(2); expect(first.cursor).toBeTruthy(); expect(new Set(first.messages.map((message) => message.account)).size).toBeGreaterThan(1);
    const next = await subject.inbox({ limit: 2, cursor: first.cursor }); expect(next.messages.map((message) => message.id)).not.toContain(first.messages[0]?.id);
    const account = await subject.inbox({ account: "gmail@example.test", limit: 1 }); expect(account.messages[0]?.account).toBe("gmail@example.test");
    await expect(subject.inbox({ account: "imap@example.test", cursor: account.cursor })).rejects.toThrow("Invalid Inbox cursor");
  });
  it("rejects malformed JSON and cross-account provider responses", async () => {
    const malformedFetch: typeof fetch = () => Promise.resolve(new Response("{broken", { headers: { "content-type": "application/json" } }));
    await expect(new HypermailReadClient({ endpoint: "x", protocolVersion: "v", fetch: malformedFetch }).accounts()).rejects.toBeInstanceOf(McpTransportError);
    const isolated = client(fakeServer({ list_emails: { emails: [{ id: "wrong", account: "other@example.test" }], hasMore: false } })); await expect(isolated.inbox({ account: "gmail@example.test" })).rejects.toThrow("Account isolation");
  });
  it("streams only an authenticated read_attachment temp file, bounds it, and cleans it up on completion/cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hypermail-test-")); const path = join(directory, "report ü.txt"); await writeFile(path, "hello");
    const server = fakeServer({ read_attachment: { name: "report ü.txt", contentType: "text/plain", size: 5, path } }); const subject = client(server);
    const attachment = await subject.openAttachment("gmail@example.test", "m", "a", { maxBytes: 10, tempDirectory: directory }); const chunks: Buffer[] = []; attachment.stream.on("data", (chunk: Buffer) => chunks.push(chunk)); await once(attachment.stream, "end"); await attachment.cleanup(); expect(Buffer.concat(chunks).toString()).toBe("hello"); await expect(access(path)).rejects.toThrow();
    expect(attachment.contentDisposition).toContain("filename*=UTF-8''report%20%C3%BC.txt"); expect(contentDisposition("bad\r\nname.txt")).not.toContain("\r");
    const oversized = join(directory, "large"); await writeFile(oversized, "123456"); const tooLarge = client(fakeServer({ read_attachment: { name: "large", size: 6, path: oversized } })); await expect(tooLarge.openAttachment("gmail@example.test", "m", "a", { maxBytes: 5, tempDirectory: directory })).rejects.toThrow("exceeds"); await expect(access(oversized)).rejects.toThrow();
    const cancelled = join(directory, "cancel"); await writeFile(cancelled, "hello"); const controller = new AbortController(); const cancelledClient = client(fakeServer({ read_attachment: { name: "cancel", size: 5, path: cancelled } })); const stream = await cancelledClient.openAttachment("gmail@example.test", "m", "a", { maxBytes: 10, tempDirectory: directory, signal: controller.signal }); stream.stream.once("error", () => undefined); const closed = new Promise<void>((resolve) => stream.stream.once("close", resolve)); controller.abort(); await closed; await stream.cleanup(); await expect(access(cancelled)).rejects.toThrow();
  });
});
