/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { HypermailPolicyClient, HypermailReadClient, McpTransportError } from "../src/index.js";

describe("Hypermail restricted policy contract", () => {
  it("uses the exact v0.7.26 draft payloads and validates structured results", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = { call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "draft_email") return { draft: true, id: "provider-draft-1", draftHtml: "<p>body</p>" };
      if (name === "read_email") return { id: "provider-draft-1", subject: "Subject", body: "<p>old</p>", bodyFormat: "html" };
      return { edited: true, id: "provider-draft-2", draftHtml: "<p>new</p>" };
    } };
    const client = new HypermailPolicyClient(transport);
    await expect(client.createDraft({ account: "owner@example.test", to: [{ address: "to@example.test" }], subject: "Subject", body: "body", bodyFormat: "html" })).resolves.toEqual({ id: "provider-draft-1", draftHtml: "<p>body</p>" });
    const current = await client.readDraft("owner@example.test", "provider-draft-1");
    await expect(client.editDraft({ account: "owner@example.test", id: current.id, to: [{ address: "to@example.test" }], subject: "Subject", oldText: current.body ?? "", newText: "new", bodyFormat: "html" })).resolves.toEqual({ id: "provider-draft-2", draftHtml: "<p>new</p>" });
    expect(calls[0]).toEqual({ name: "draft_email", args: { account: "owner@example.test", to: [{ address: "to@example.test" }], subject: "Subject", body: "body", format: "html", include_signature: false, inReplyTo: false } });
    expect(calls[2]).toMatchObject({ name: "edit_draft", args: { id: "provider-draft-1", old_text: "<p>old</p>", new_text: "new", format: "html", include_signature: false } });
    await expect(new HypermailPolicyClient({ call: async () => ({ id: "missing-flag" }) }).createDraft({ account: "owner@example.test", to: [{ address: "to@example.test" }], subject: "s", body: "b", bodyFormat: "markdown" })).rejects.toBeInstanceOf(McpTransportError);
  });

  it("validates mutation receipts and verifies a returned post-move ID by destination listing", async () => {
    const client = new HypermailPolicyClient({ call: async (name, args) => {
      if (name === "move_email") return { moved: true, id: "moved-id", destination: args["destination"] };
      if (name === "mark_read") return { marked: true, id: "moved-id", isRead: true };
      if (name === "list_emails") return { items: [{ id: "moved-id" }], hasMore: false };
      return { archived: true, id: "moved-id" };
    } });
    await expect(client.move("owner@example.test", "old-id", "folder-id")).resolves.toEqual({ id: "moved-id" });
    await expect(client.mark("owner@example.test", "moved-id", true)).resolves.toEqual({ id: "moved-id" });
    await expect(client.containsMessageInFolder("owner@example.test", "moved-id", "folder-id")).resolves.toBe(true);
    await expect(new HypermailPolicyClient({ call: async () => ({ moved: true, id: "x", destination: "wrong" }) }).move("owner@example.test", "old", "wanted")).rejects.toBeInstanceOf(McpTransportError);
  });


  it("probes the complete restricted tool surface and rejects missing schemas", async () => {
    const inputs: Record<string, string[]> = { list_emails: ["account", "folder", "limit", "skip"], read_email: ["account", "id", "format"], archive_email: ["account", "id"], trash_email: ["account", "id"], move_email: ["account", "id", "destination"], mark_read: ["account", "id"], mark_unread: ["account", "id"], draft_email: ["account", "to", "subject", "body", "format", "include_signature", "inReplyTo"], edit_draft: ["account", "id", "old_text", "new_text"] };
    const flags: Record<string, string> = { archive_email: "archived", trash_email: "trashed", move_email: "moved", mark_read: "marked", mark_unread: "marked", draft_email: "draft", edit_draft: "edited" };
    const tools = Object.entries(inputs).map(([name, fields]) => { const flag = flags[name]; const required = name === "read_email" || name === "edit_draft" ? ["account", "id"] : name === "draft_email" ? fields.filter((field) => field !== "inReplyTo") : fields; const outputFields = name === "list_emails" ? ["items", "hasMore"] : flag ? [flag, "id", ...(name === "move_email" ? ["destination"] : []), ...(name === "mark_read" || name === "mark_unread" ? ["isRead"] : [])] : [];
      const inputProperty = (field: string) => field === "to" ? { type: "array" } : field === "include_signature" ? { type: "boolean" } : field === "limit" || field === "skip" ? { type: "integer" } : field === "inReplyTo" ? { anyOf: [{ type: "string" }, { type: "boolean", const: false }] } : field === "format" ? { type: "string", enum: name === "read_email" ? ["html", "markdown", "text"] : ["html", "markdown"] } : { type: "string" };
      const outputProperty = (field: string) => field === flag ? { const: true } : field === "items" ? { type: "array" } : field === "hasMore" || field === "isRead" ? { type: "boolean" } : { type: "string" };
      return { name, inputSchema: { type: "object", properties: Object.fromEntries(fields.map((field) => [field, inputProperty(field)])), required }, ...(outputFields.length ? { outputSchema: { type: "object", properties: Object.fromEntries(outputFields.map((field) => [field, outputProperty(field)])), required: outputFields } } : {}) }; });
    const server = (value: unknown): typeof fetch => async (_url, init) => {
      const payload = init?.body; if (typeof payload !== "string") throw new Error("Expected JSON body");
      const request = JSON.parse(payload) as { id?: number; method: string };
      const result = request.method === "initialize" ? {} : request.method === "tools/list" ? value : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result }), { headers: { "content-type": "application/json" } });
    };
    const valid = new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "v", fetch: server({ tools }) }); await valid.initialize(); await expect(valid.verifyPolicyContract()).resolves.toBeUndefined();
    const invalid = new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "v", fetch: server({ tools: tools.filter((tool) => tool.name !== "edit_draft") }) }); await invalid.initialize(); await expect(invalid.verifyPolicyContract()).rejects.toThrow("Missing policy tool edit_draft");
    const incompatibleTools = tools.map((tool) => tool.name === "draft_email" ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, to: { type: "string" } }, required: ["account"] } } : tool);
    const incompatible = new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "v", fetch: server({ tools: incompatibleTools }) }); await incompatible.initialize(); await expect(incompatible.verifyPolicyContract()).rejects.toThrow("Malformed draft_email input schema");
    const wrongTypes = tools.map((tool) => tool.name === "draft_email" ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, to: { type: "string" } } } } : tool);
    const incompatibleTypes = new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "v", fetch: server({ tools: wrongTypes }) }); await incompatibleTypes.initialize(); await expect(incompatibleTypes.verifyPolicyContract()).rejects.toThrow("Incompatible draft_email input schema");
  });
});
