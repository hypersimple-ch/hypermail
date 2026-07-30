import type { Json, JsonRpcResponse, ToolCall } from "./types.ts";

export class McpTransportError extends Error {
  readonly status?: number; readonly retryable: boolean;
  constructor(message: string, status?: number, retryable = false) { super(message); this.name = "McpTransportError"; this.status = status; this.retryable = retryable; }
}
export class McpJsonRpcError extends Error {
  readonly code: number; readonly data?: Json; readonly retryable: boolean;
  constructor(code: number, message: string, data?: Json) {
    super(message); this.name = "McpJsonRpcError"; this.code = code; this.data = data;
    this.retryable = code === -32001 || code === -32002 || code === -32003;
  }
}

export class HypermailMcpHttpClient {
  #id = 0;
  #sessionId?: string;
  readonly endpoint: string; private readonly request: typeof fetch;
  constructor(endpoint: string, request: typeof fetch = fetch) { this.endpoint = endpoint; this.request = request; }

  async initialize(protocolVersion: string): Promise<Json> {
    const result = await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "hypermail-contract-proof", version: "0.1.0" } });
    await this.notify("notifications/initialized");
    return result;
  }
  async listTools(): Promise<Json> { return this.rpc("tools/list", {}); }
  async call<T extends Json = Json>(call: ToolCall): Promise<T> { return this.rpc("tools/call", { name: call.name, arguments: call.arguments }) as Promise<T>; }

  private async notify(method: string): Promise<void> { await this.send({ jsonrpc: "2.0", method, params: {} }); }
  private async rpc(method: string, params: Record<string, Json>): Promise<Json> {
    const id = ++this.#id;
    const response = await this.send({ jsonrpc: "2.0", id, method, params }) as JsonRpcResponse;
    if (response.jsonrpc !== "2.0" || response.id !== id || ("result" in response) === ("error" in response)) throw new McpTransportError("Malformed JSON-RPC response");
    if (response.error) throw new McpJsonRpcError(response.error.code, response.error.message, response.error.data);
    return response.result!;
  }
  private async send(body: Record<string, Json | number | string>): Promise<JsonRpcResponse | void> {
    let response: Response;
    try { response = await this.request(this.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}) }, body: JSON.stringify(body) }); }
    catch (error) { throw new McpTransportError(`Network failure: ${error instanceof Error ? error.message : String(error)}`, undefined, true); }
    const session = response.headers.get("mcp-session-id"); if (session) this.#sessionId = session;
    if (!response.ok) throw new McpTransportError(`HTTP ${response.status}`, response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    if (!("id" in body) && response.status === 202) return;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    try {
      if (contentType.includes("application/json")) return JSON.parse(text) as JsonRpcResponse;
      if (contentType.includes("text/event-stream")) {
        const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
        if (data.length) return JSON.parse(data.at(-1)!) as JsonRpcResponse;
      }
    } catch { /* normalized below */ }
    throw new McpTransportError(contentType.includes("application/json") || contentType.includes("text/event-stream") ? "Malformed JSON-RPC response" : "Unsupported response media type");
  }
}
