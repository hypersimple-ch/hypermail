import assert from "node:assert/strict";
import test from "node:test";
import { HypermailMcpHttpClient, McpJsonRpcError, McpTransportError } from "../src/client.ts";
import { capabilities, inbox, startFixtureServer } from "../fixtures/hypermail-v0.7.26.ts";
import { policy } from "../src/types.ts";

async function fixture(mode: "normal" | "malformed" | "http-503" = "normal") { const f = await startFixtureServer(mode); return { f, client: new HypermailMcpHttpClient(f.endpoint) }; }

test("fixture proof: lifecycle, stable provider identity, IDs, and pagination", async () => {
  const { f, client } = await fixture(); try {
    await client.initialize("BLOCKED-LIVE-PROTOCOL-VERSION");
    const accountResult = await client.call<{ accounts: { email: string; provider: string }[] }>({ name: "list_accounts", arguments: {} });
    assert.deepEqual(accountResult.accounts.map((a) => a.provider), ["outlook", "gmail", "imap"]);
    assert.equal(new Set(accountResult.accounts.map((a) => a.email)).size, 3); assert.equal(f.sawSession, true);
    const first = await client.call<{ emails: typeof inbox; hasMore: boolean }>({ name: "list_emails", arguments: { account: "gmail@example.test", folder: "inbox", limit: 1, skip: 0 } });
    const second = await client.call<{ emails: typeof inbox; hasMore: boolean }>({ name: "list_emails", arguments: { account: "gmail@example.test", folder: "inbox", limit: 1, skip: 1 } });
    assert.equal(first.hasMore, true); assert.equal(second.hasMore, false); assert.notEqual(first.emails[0].id, second.emails[0].id);
  } finally { await f.close(); }
});

test("fixture proof: first get_new_emails call establishes checkpoint without bodies", async () => {
  const { f, client } = await fixture(); try {
    const args = { account: "gmail@example.test", limit: 10 };
    assert.deepEqual(await client.call({ name: "get_new_emails", arguments: args }), { emails: [], initialized: true });
    const next = await client.call<{ emails: typeof inbox; initialized: boolean }>({ name: "get_new_emails", arguments: args });
    assert.equal(next.initialized, false); assert.deepEqual(next.emails.map((m) => m.id), ["msg-001", "msg-002"]);
  } finally { await f.close(); }
});

test("fixture proof: documented browse/attachment/folder/draft/action payload surfaces", async () => {
  const { f, client } = await fixture(); try {
    const folders = await client.call<{ folders: { id: string }[] }>({ name: "list_folders", arguments: { account: "imap@example.test" } });
    const found = await client.call<{ emails: typeof inbox }>({ name: "search_emails", arguments: { account: "gmail@example.test", query: "first", limit: 25 } });
    const message = await client.call<{ id: string; attachments: { id: string }[] }>({ name: "read_email", arguments: { account: "gmail@example.test", id: "msg-001", format: "markdown" } });
    const attachment = await client.call<{ path: string }>({ name: "read_attachment", arguments: { account: "gmail@example.test", messageId: message.id, attachmentId: message.attachments[0].id } });
    assert.equal(folders.folders[0].id, "inbox"); assert.equal(found.emails[0].id, "msg-001"); assert.match(attachment.path, /^\/tmp\//);
    for (const name of ["draft_email", "send_email", "move_email", "archive_email", "trash_email", "mark_read", "mark_unread"]) {
      const result = await client.call<{ status: string }>({ name, arguments: { account: "gmail@example.test", id: "msg-001" } }); assert.equal(result.status, "fixture-only");
    }
  } finally { await f.close(); }
});

test("policy and provider differences remain conservative", () => {
  for (const name of ["send_email", "send_draft", "add_account", "remove_account", "create_folder", "delete_folder", "rename_folder"]) assert.equal(policy[name], "forbidden");
  assert.equal(policy.move_email, "user-approved-only"); assert.equal(policy.get_new_emails, "autonomous-policy-eligible");
  assert.deepEqual(capabilities.outlook.onboarding, "device_code"); assert.deepEqual(capabilities.gmail.onboarding, "oauth_url"); assert.deepEqual(capabilities.imap.webUrl, "unavailable-reason");
});

test("HTTP transport and malformed-response failures expose retryability", async () => {
  const unavailable = await fixture("http-503"); try { await assert.rejects(unavailable.client.listTools(), (e: unknown) => e instanceof McpTransportError && e.status === 503 && e.retryable); } finally { await unavailable.f.close(); }
  const malformed = await fixture("malformed"); try { await assert.rejects(malformed.client.listTools(), (e: unknown) => e instanceof McpTransportError && !e.retryable); } finally { await malformed.f.close(); }
  const rpc = new HypermailMcpHttpClient("http://fixture.invalid", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "temporarily unavailable" } }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(rpc.listTools(), (e: unknown) => e instanceof McpJsonRpcError && e.retryable);
  const sse = new HypermailMcpHttpClient("http://fixture.invalid", async () => new Response("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n", { headers: { "content-type": "text/event-stream" } }));
  assert.deepEqual(await sse.listTools(), { tools: [] });
});
