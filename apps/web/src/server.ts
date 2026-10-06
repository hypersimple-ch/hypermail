import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStructuredLogger } from '@hypermail/observability';
import { correlationId } from './security/correlation.js';
import { requestBodyLimit, requestLimit, RequestThrottle } from './security/limits.js';
import { createClientIpResolver } from './security/client-ip.js';
import { closeRejectedBody, readRequestBytes, RequestBodyError } from './security/request-body.js';
import type { WebRuntime } from './runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = existsSync(resolve(here, 'manifest.webmanifest')) ? here : resolve(here, '../static');
const shellPath = resolve(staticRoot, 'index.html');
const contentTypes: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()'); response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'");
}
const cacheControl = (path: string) => path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css') || path.endsWith('manifest.webmanifest') ? 'no-cache' : path.endsWith('.png') ? 'public, max-age=604800' : 'public, max-age=300';
function staticFile(pathname: string): string | null { try { const candidate = resolve(staticRoot, `.${decodeURIComponent(pathname)}`); const within = relative(staticRoot, candidate); return within.startsWith('..') || within === '' || within.includes('\0') ? null : candidate; } catch { return null; } }
async function sendFile(response: ServerResponse, file: string, method: string): Promise<void> { try { if (!(await stat(file)).isFile()) throw new Error('not a file'); response.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream'); response.setHeader('Cache-Control', cacheControl(file)); if (file.endsWith('service-worker.js')) response.setHeader('Service-Worker-Allowed', '/'); response.statusCode = 200; response.end(method === 'HEAD' ? undefined : await readFile(file)); } catch { response.statusCode = 404; response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end(method === 'HEAD' ? undefined : 'Not found'); } }
async function body(request: IncomingMessage, timeoutMs: number): Promise<Readonly<Record<string, unknown>>> {
  const raw = await readRequestBytes(request, requestBodyLimit(request), timeoutMs);
  if (!raw.length) return {};
  if (request.headers['content-type']?.split(';')[0]?.trim() === 'application/x-www-form-urlencoded') {
    const result: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw.toString('utf8'))) {
      if (key.length > 128 || value.length > 4096 || key in result) throw new RequestBodyError(400);
      result[key] = value;
    }
    return result;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new RequestBodyError(400);
    return parsed as Readonly<Record<string, unknown>>;
  } catch { throw new RequestBodyError(400); }
}
function respond(response: ServerResponse, status: number, value?: Readonly<Record<string, unknown>>, setCookie?: string, headers?: Readonly<Record<string, string>>): void { response.statusCode = status; response.setHeader('Cache-Control', 'no-store'); if (setCookie) response.setHeader('Set-Cookie', setCookie); for (const [name, valueText] of Object.entries(headers ?? {})) response.setHeader(name, valueText); if (status === 204) { response.end(); return; } response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value ?? {})); }
function streamResponse(request: IncomingMessage, response: ServerResponse, result: NonNullable<Awaited<ReturnType<WebRuntime['dispatch']>>>): void {
  if (!result.stream) { respond(response, result.status, result.body, result.setCookie, result.headers); return; }
  response.statusCode = result.status; response.setHeader('Cache-Control', 'no-store'); for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  let cleaned = false; const cleanup = () => { if (!cleaned) { cleaned = true; void result.cleanup?.().catch(() => {}); } };
  response.once('finish', cleanup); response.once('close', cleanup); response.once('error', cleanup); request.once('aborted', () => { result.stream?.destroy(); cleanup(); }); result.stream.once('error', () => { cleanup(); if (!response.destroyed) response.destroy(); });
  result.stream.pipe(response); // Node pipe preserves backpressure.
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, throttle: RequestThrottle, id: string, clientIp: string, bodyTimeoutMs: number, runtime?: WebRuntime): Promise<void> {
  setSecurityHeaders(response); response.setHeader('X-Correlation-ID', id);
  // Apply the global IP quota before MCP; its raw transport retains its own 512 KiB bound.
  const limited = requestLimit(request, throttle, clientIp);
  if (limited) { closeRejectedBody(request, response); respond(response, limited.status, { error: limited.message, correlationId: id }); return; }
  if (runtime?.publicMcp && await runtime.publicMcp.handle(request, response)) return;
  const method = request.method ?? 'GET'; const url = new URL(request.url ?? '/', 'http://localhost'); const pathname = url.pathname;
  if (pathname === '/health/live' && (method === 'GET' || method === 'HEAD')) { respond(response, 200, method === 'HEAD' ? undefined : { status: 'ok' }); return; }
  if (runtime && (pathname.startsWith('/api/') || pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/'))) {
    const query = Object.fromEntries(url.searchParams.entries()); const controller = new AbortController(); request.once('aborted', () => { controller.abort(); });
    let requestBody: Readonly<Record<string, unknown>> = {};
    if (method !== 'GET' && method !== 'HEAD') {
      try { requestBody = await body(request, bodyTimeoutMs); }
      catch (error) { if (error instanceof RequestBodyError) { closeRejectedBody(request, response); respond(response, error.status, { error: 'invalid_request' }); return; } throw error; }
    }
    const result = await runtime.dispatch({ method, pathname, query, origin: typeof request.headers.origin === 'string' ? request.headers.origin : null, cookie: typeof request.headers.cookie === 'string' ? request.headers.cookie : null, remoteAddress: clientIp, correlationId: id, contentType: request.headers['content-type']?.split(';')[0]?.trim() ?? null, apiVersion: typeof request.headers['x-api-version'] === 'string' ? request.headers['x-api-version'] : null, body: requestBody, signal: controller.signal });
    if (result) { streamResponse(request, response, result); return; }
    respond(response, 404, { error: 'Not found', correlationId: id }); return;
  }
  if (pathname.startsWith('/api/')) { respond(response, 404, { error: 'Not found', correlationId: id }); return; }
  if (method !== 'GET' && method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); respond(response, 405); return; }
  if (pathname === '/' || !pathname.includes('.')) return sendFile(response, shellPath, method);
  const file = staticFile(pathname); if (!file) { respond(response, 404); return; } return sendFile(response, file, method);
}

/** Node adapter for the same-origin web API and browser shell. */
export function createWebServer(throttle = new RequestThrottle(), runtime?: WebRuntime, options: Readonly<{ trustedProxyCidrs?: readonly string[]; bodyTimeoutMs?: number }> = {}): Server {
  const clientIp = createClientIpResolver(options.trustedProxyCidrs ?? runtime?.trustedProxyCidrs ?? []);
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 30_000;
  const logger = createStructuredLogger((record) => { process.stdout.write(`${JSON.stringify(record)}\n`); });
  return createServer({ headersTimeout: 30_000, requestTimeout: 35_000 }, (request, response) => { const id = correlationId(request.headers); void handleRequest(request, response, throttle, id, clientIp(request), bodyTimeoutMs, runtime).then(() => { logger.log('info', 'web.request.completed', { method: request.method ?? 'GET', status: response.statusCode }, id); }).catch(() => { if (!response.headersSent) { setSecurityHeaders(response); response.setHeader('X-Correlation-ID', id); respond(response, 500, { error: 'Internal server error', correlationId: id }); } else response.destroy(); logger.log('error', 'web.request.failed', { method: request.method ?? 'GET', status: 500 }, id); }); });
}
export function startWebServer(port = Number(process.env['PORT']) || 3000, runtime?: WebRuntime): Server { const server = createWebServer(new RequestThrottle(), runtime); if (runtime) server.once('close', () => { void runtime.close(); }); server.listen(port, '0.0.0.0'); return server; }
