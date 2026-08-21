import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { PostgresOAuthService, AccessPrincipal } from '../oauth/service.js';
import { PublicMcpError, type PublicMcpFacadeCore, type VerifiedInvocationBinding } from './core.js';
import { PUBLIC_MCP_PROTECTED_RESOURCE_METADATA_PATH, publicToolRegistry } from './registry.js';

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 15 * 60_000;
const PUBLIC_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
type SessionIdentity = Pick<AccessPrincipal, 'familyId' | 'clientId' | 'userId' | 'connectionId' | 'mailboxId'>;
type Session = { id?: string; identity: SessionIdentity; transport: StreamableHTTPServerTransport; server: McpServer; touchedAt: number; inflight: number; closed: boolean; controllers: Set<AbortController> };
export type PublicMcpAuditEvent = Readonly<{ event: string; sessionId?: string; userId?: string; connectionId?: string; mailboxId?: string; reason?: string }>;
export type PublicMcpHttpOptions = Readonly<{
  oauth: Pick<PostgresOAuthService, 'verifyAccess'>; facade: PublicMcpFacadeCore; origin: string;
  audit?: (event: PublicMcpAuditEvent) => Promise<void>; now?: () => number; sessionTtlMs?: number;
  maxSessions?: number; maxInflightPerSession?: number; maxInflight?: number;
  preAuthLimit?: number; preAuthWindowMs?: number; preAuthMaxSubjects?: number;
  connectSession?: (server:McpServer,transport:StreamableHTTPServerTransport)=>Promise<void>;
}>;
export interface PublicMcpHttpHandler { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; close(): Promise<void>; readonly sessionCount: number }

const jsonRpcError = (res: ServerResponse, status: number, code: number, message: string, id: unknown = null): void => {
  if (res.headersSent) return;
  res.statusCode = status; res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
};
const bearer = (req: IncomingMessage): string | null => {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] ?? null;
};
const sameIdentity = (a: SessionIdentity, b: SessionIdentity): boolean => a.familyId === b.familyId && a.clientId === b.clientId && a.userId === b.userId && a.connectionId === b.connectionId && a.mailboxId === b.mailboxId;
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > MAX_BODY_BYTES) throw new RangeError('oversize'); chunks.push(chunk); }
  if (chunks.length === 0) throw new SyntaxError('empty');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/** Raw Node transport. It must be mounted before the generic web/API body parser. */
export function createPublicMcpHttpHandler(options: PublicMcpHttpOptions): PublicMcpHttpHandler {
  const sessions = new Map<string, Session>(); const managedSessions = new Set<Session>(); const context = new AsyncLocalStorage<VerifiedInvocationBinding>();
  const now = options.now ?? Date.now; const ttl = options.sessionTtlMs ?? DEFAULT_TTL_MS;
  const maxSessions = options.maxSessions ?? 100; const maxPerSession = options.maxInflightPerSession ?? 8; const maxInflight = options.maxInflight ?? 64;
  const preAuthLimit=options.preAuthLimit??60,preAuthWindow=options.preAuthWindowMs??60_000,preAuthMaximum=options.preAuthMaxSubjects??2_048;
  const preAuth=new Map<string,{started:number;count:number}>();
  const takePreAuth=(subject:string):boolean=>{const at=now();const found=preAuth.get(subject);if(!found||at-found.started>=preAuthWindow){if(preAuth.size>=preAuthMaximum)preAuth.delete(preAuth.keys().next().value as string);preAuth.set(subject,{started:at,count:1});return true}found.count++;return found.count<=preAuthLimit};
  let totalInflight = 0; let pendingSessions = 0; let shuttingDown = false;
  const audit = async (event: PublicMcpAuditEvent) => { await options.audit?.(event); };
  const closeSession = async (session: Session): Promise<void> => {
    if (session.closed) return; session.closed = true; managedSessions.delete(session); if (session.id) sessions.delete(session.id); for(const controller of session.controllers)controller.abort(new Error('MCP session closed'));session.controllers.clear();
    await Promise.allSettled([session.transport.close(), session.server.close()]);
  };
  const reap = async (): Promise<void> => { const cutoff = now() - ttl; await Promise.all([...sessions.values()].filter(s => s.touchedAt <= cutoff).map(closeSession)); };
  const challenge = (res: ServerResponse, reason = 'invalid_token'): void => {
    const resource = new URL(PUBLIC_MCP_PROTECTED_RESOURCE_METADATA_PATH, options.origin).toString();
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resource}", error="${reason}"`);
    jsonRpcError(res, 401, -32001, 'Authentication required.');
  };
  const createSession = async (identity: SessionIdentity, admission?:{reserved:boolean}): Promise<Session> => {
    const server = new McpServer({ name: 'hypermail-public', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => {
      session.id = id; session.touchedAt = now(); sessions.set(id, session);if(admission?.reserved){pendingSessions--;admission.reserved=false}
    } });
    const session: Session = { identity, transport, server, touchedAt: now(), inflight: 0, closed: false, controllers:new Set() }; managedSessions.add(session);
    transport.onclose = () => { if (session.id) sessions.delete(session.id); managedSessions.delete(session); session.closed = true; for(const controller of session.controllers)controller.abort(new Error('MCP transport closed'));session.controllers.clear(); };
    for (const definition of Object.values(publicToolRegistry)) {
      server.registerTool(definition.name, { title: definition.title, description: definition.description, inputSchema: definition.args, outputSchema: definition.result, annotations: definition.annotations }, async (args: unknown) => {
        const binding = context.getStore();
        if (!binding || !sameIdentity(binding.principal, session.identity)) throw new PublicMcpError('unauthorized');
        try {
          const result = await options.facade.invoke(binding, definition.name, args);
          return { structuredContent: result as Record<string, unknown>, content: [{ type: 'text' as const, text: definition.name === 'read_attachment' ? 'Attachment content is available in structuredContent.' : JSON.stringify(result) }] };
        } catch (error) {
          const safe = error instanceof PublicMcpError ? error : new PublicMcpError('internal_error');
          return { isError: true, structuredContent: { error: { code: safe.code } }, content: [{ type: 'text' as const, text: safe.message }] };
        }
      });
    }
    try{if(options.connectSession)await options.connectSession(server,transport);else await server.connect(transport as unknown as Transport);return session}catch(error){await closeSession(session);throw error}
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', options.origin); if (url.pathname !== '/mcp') return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Origin');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') { const origin = req.headers.origin; if (origin !== options.origin) { jsonRpcError(res, 403, -32003, 'Forbidden.'); return true; } res.statusCode = 204; res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version'); res.end(); return true; }
    if (!['POST', 'GET', 'DELETE'].includes(method)) { res.setHeader('Allow', 'POST, GET, DELETE'); jsonRpcError(res, 405, -32600, 'Method not allowed.'); return true; }
    const origin = req.headers.origin; if (origin !== undefined && origin !== options.origin) { jsonRpcError(res, 403, -32003, 'Forbidden.'); return true; }
    if (origin === options.origin) res.setHeader('Access-Control-Allow-Origin', origin);
    const expectedHost = new URL(options.origin).host; if (req.headers.host !== expectedHost) { jsonRpcError(res, 400, -32600, 'Invalid request.'); return true; }
    if(!takePreAuth(req.socket.remoteAddress??'unknown')){res.setHeader('Retry-After',String(Math.max(1,Math.ceil(preAuthWindow/1000))));jsonRpcError(res,429,-32002,'Too many requests.');return true}
    const token = bearer(req); if (!token) { challenge(res); return true; }
    const principal = await options.oauth.verifyAccess(token); if (!principal || principal.audience !== new URL('/mcp', options.origin).toString() || !principal.scopes.includes('agent:mailbox')) { challenge(res); return true; }
    await reap(); if (shuttingDown) { jsonRpcError(res, 503, -32002, 'Service unavailable.'); return true; }
    const rawSessionId = req.headers['mcp-session-id']; const sessionId = typeof rawSessionId === 'string' && rawSessionId.length <= 200 ? rawSessionId : undefined;
    const protocolVersion = req.headers['mcp-protocol-version'];
    if (protocolVersion !== undefined && (typeof protocolVersion !== 'string' || !PUBLIC_PROTOCOL_VERSIONS.has(protocolVersion))) { jsonRpcError(res, 400, -32600, 'Unsupported MCP protocol version.'); return true; }
    let session = sessionId ? sessions.get(sessionId) : undefined; let parsed: unknown; const admission={reserved:false};
    if (sessionId && (!session || !sameIdentity(session.identity, principal))) {
      await audit({ event: 'mcp.session_denied', sessionId, userId: principal.userId, connectionId: principal.connectionId, mailboxId: principal.mailboxId, reason: session ? 'identity_mismatch' : 'unknown_session' });
      jsonRpcError(res, 404, -32001, 'Session not found.'); return true;
    }
    if (method === 'POST') {
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { jsonRpcError(res, 415, -32600, 'Content-Type must be application/json.'); return true; }
      try { parsed = await readJson(req); } catch (error) { jsonRpcError(res, error instanceof RangeError ? 413 : 400, -32700, error instanceof RangeError ? 'Request body too large.' : 'Parse error.'); return true; }
      if (!session) {
        if (sessionId || !isInitializeRequest(parsed)) { jsonRpcError(res, 400, -32000, 'A valid session is required.'); return true; }
        if (sessions.size + pendingSessions >= maxSessions) { jsonRpcError(res, 503, -32002, 'Service unavailable.'); return true; }
        pendingSessions++;admission.reserved=true;
        try{session = await createSession(principal,admission)}catch{pendingSessions--;admission.reserved=false;jsonRpcError(res,503,-32002,'Service unavailable.');return true}
      }
    } else if (!session) { jsonRpcError(res, 404, -32001, 'Session not found.'); return true; }
    if (session.inflight >= maxPerSession || totalInflight >= maxInflight) { if(admission.reserved){pendingSessions--;admission.reserved=false;await closeSession(session)} jsonRpcError(res, 429, -32002, 'Too many requests.'); return true; }
    session.touchedAt = now(); session.inflight++; totalInflight++;
    const controller=new AbortController();let signalCleaned=false;const cleanupSignal=()=>{if(signalCleaned)return;signalCleaned=true;req.off('aborted',abort);res.off('finish',responseFinished);res.off('close',responseClosed);session.controllers.delete(controller)};const abort=()=>{controller.abort(new Error('MCP request aborted'))};const responseFinished=()=>{abort();cleanupSignal()};const responseClosed=()=>{if(!res.writableFinished)abort();cleanupSignal()};req.once('aborted',abort);res.once('finish',responseFinished);res.once('close',responseClosed);session.controllers.add(controller);const binding: VerifiedInvocationBinding = { principal, mode: 'interactive', sessionId: session.id ?? 'initializing-session', signal:controller.signal };
    try { await context.run(binding, () => session.transport.handleRequest(req, res, parsed)); }
    finally { if(res.writableFinished)cleanupSignal();session.inflight--;totalInflight--;if(admission.reserved){pendingSessions--;admission.reserved=false;if(!session.id)await closeSession(session)}if(method==='DELETE')await closeSession(session); }
    return true;
  };
  return { handle, get sessionCount() { return sessions.size; }, close: async () => { shuttingDown = true; await Promise.all([...managedSessions].map(closeSession)); } };
}
