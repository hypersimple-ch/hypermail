import { describe, expect, it } from "vitest";
import { HypermailReadClient, McpTransportError, type OnboardingDiagnostic } from "../src/index.js";

type Request = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type FixtureResult = Readonly<Record<string, unknown>>;
function fixtureClient(results: Record<string, FixtureResult | FixtureResult[]>, onOnboardingDiagnostic?: (diagnostic: OnboardingDiagnostic) => void) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
    const request = JSON.parse(init.body) as Request; calls.push(request);
    const key = request.params?.name ?? request.method; const configured = results[key];
    const result: FixtureResult = Array.isArray(configured) ? configured.shift() ?? {} : configured ?? {};
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result }), { headers: { "content-type": "application/json" } }));
  };
  return { client: new HypermailReadClient({ endpoint: "http://fixture/mcp", protocolVersion: "deployment", fetch, ...(onOnboardingDiagnostic ? { onOnboardingDiagnostic } : {}) }), calls };
}
async function initialized(results: Record<string, FixtureResult | FixtureResult[]>, onOnboardingDiagnostic?: (diagnostic: OnboardingDiagnostic) => void) { const server = fixtureClient(results, onOnboardingDiagnostic); await server.client.initialize(); return server; }

describe("Hypermail explicit-user onboarding", () => {
  it("projects Outlook device-code and Gmail OAuth pending payloads", async () => {
    const outlook = await initialized({ add_account: { status: "pending", handle: "outlook-handle", verification: { type: "device_code", userCode: "DISPLAY-CODE", verificationUri: "https://verify.example.test", expiresAt: "2026-01-01T00:00:00Z", message: "Enter the displayed code." } } });
    await expect(outlook.client.addAccount({ provider: "outlook" })).resolves.toEqual({ status: "pending", handle: "outlook-handle", verification: { type: "device_code", userCode: "DISPLAY-CODE", verificationUri: "https://verify.example.test", expiresAt: "2026-01-01T00:00:00Z", message: "Enter the displayed code." } });
    const gmail = await initialized({ add_account: { content: [{ type: "text", text: "provider display text" }], structuredContent: { status: "pending", handle: "gmail-handle", verification: { type: "oauth_url", userCode: "", verificationUri: "https://authorize.example.test", expiresAt: "2026-01-01T00:00:00Z", message: "Continue in your browser." } } } });
    await expect(gmail.client.addAccount({ provider: "gmail", email: "user@example.test" })).resolves.toEqual({ status: "pending", handle: "gmail-handle", verification: { type: "oauth_url", verificationUri: "https://authorize.example.test", expiresAt: "2026-01-01T00:00:00Z", message: "Continue in your browser." } });
  });

  it("projects an IMAP ready response and discards unknown credential fields", async () => {
    const server = await initialized({ add_account: { status: "ready", account: { provider: "imap", email: "user@example.test", displayName: "IMAP", state: "connected", tokens: { accessToken: "placeholder" }, password: "placeholder", addedAt: "ignored" } } });
    const result = await server.client.addAccount({ provider: "imap", config: { host: "imap.example.test", user: "user@example.test", password: "placeholder" } });
    expect(result).toEqual({ status: "ready", account: { provider: "imap", email: "user@example.test", displayName: "IMAP", state: "connected" } });
    expect(JSON.stringify(result)).not.toContain("tokens"); expect(JSON.stringify(result)).not.toContain("password");
    expect(server.calls.at(-1)?.params?.arguments).toMatchObject({ provider: "imap", config: { host: "imap.example.test", user: "user@example.test" } });
    expect(server.calls.at(-1)?.params?.arguments?.config).not.toHaveProperty("port");
  });

  it("projects completion pending, ready, expired, and error without server error text", async () => {
    const server = await initialized({ complete_add_account: [
      { status: "pending" },
      { status: "ready", account: { provider: "gmail", email: "user@example.test", displayName: "Gmail", state: "connected", refreshToken: "placeholder" } },
      { status: "expired", error: "remote detail" },
      { status: "error", error: "remote detail" }
    ] });
    await expect(server.client.completeAddAccount({ provider: "outlook", handle: "h" })).resolves.toEqual({ status: "pending" });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "ready", account: { provider: "gmail", email: "user@example.test", displayName: "Gmail", state: "connected" } });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "expired" });
    const error = await server.client.completeAddAccount({ provider: "imap", handle: "h" });
    expect(error).toEqual({ status: "error", reason: "provider_unavailable" }); expect(JSON.stringify(error)).not.toContain("remote detail");
  });

  it("rejects malformed onboarding output with bounded parse errors", async () => {
    const malformedAdd = await initialized({ add_account: { status: "pending", handle: "h", verification: { type: "device_code" } } });
    await expect(malformedAdd.client.addAccount({ provider: "outlook" })).rejects.toEqual(expect.objectContaining({ name: McpTransportError.name, message: "Malformed add_account.verification.userCode" }));
    const malformedComplete = await initialized({ complete_add_account: { status: "ready", account: { provider: "unknown", email: "user@example.test" } } });
    await expect(malformedComplete.client.completeAddAccount({ provider: "gmail", handle: "h" })).rejects.toEqual(expect.objectContaining({ name: McpTransportError.name, message: "Malformed account.provider" }));
  });

  it("classifies completion failures without exposing provider text", async () => {
    const server = await initialized({ complete_add_account: [
      { status: "error", error: "Token request failed: invalid_client details" },
      { status: "error", error: "OAuth state mismatch — restart setup" },
      { status: "error", error: "unknown handle" },
      { status: "error", error: "Token request failed: Bad Request" },
      { status: "error", error: "Failed to get Gmail profile (403): bounded remote body" },
    ] });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "error", reason: "provider_configuration" });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "error", reason: "authorization_rejected" });
    const expired = await server.client.completeAddAccount({ provider: "gmail", handle: "h" });
    expect(expired).toEqual({ status: "error", reason: "authorization_expired" });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "error", reason: "token_exchange_failed" });
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "error", reason: "gmail_profile_failed" });
    expect(JSON.stringify(expired)).not.toContain("unknown handle");
  });

  it("emits scrubbed bounded diagnostics without changing the public result", async () => {
    const diagnostics: OnboardingDiagnostic[] = [];
    const server = await initialized({ complete_add_account: { status: "error", error: "EACCES user@example.test https://remote.test/path code=abcdefghijklmnop access_token=qrstuvwxyz012345" } }, (diagnostic) => diagnostics.push(diagnostic));
    await expect(server.client.completeAddAccount({ provider: "gmail", handle: "h" })).resolves.toEqual({ status: "error", reason: "provider_unavailable" });
    expect(diagnostics).toEqual([{ source: "provider_result", reason: "provider_unavailable", detail: "EACCES [redacted-email] [redacted-url] code=[redacted] access_token=[redacted]" }]);
    expect(JSON.stringify(diagnostics)).not.toContain("user@example.test");
    expect(JSON.stringify(diagnostics)).not.toContain("abcdefghijklmnop");
  });

  it("rejects MCP tool error envelopes without exposing provider text", async () => {
    const server = await initialized({ add_account: { isError: true, content: [{ type: "text", text: "provider secret detail" }] } });
    const error = await server.client.addAccount({ provider: "gmail" }).catch((caught: unknown) => caught);
    expect(error).toEqual(expect.objectContaining({ name: McpTransportError.name, message: "MCP tool failed" }));
    expect(JSON.stringify(error)).not.toContain("provider secret detail");
  });
});
