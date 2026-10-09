import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createWebServer, startWebServer } from '../src/server.js';
import { createWebRuntimeFromEnvironment, type WebRuntime } from '../src/runtime.js';
import { RequestThrottle } from '../src/security/limits.js';

let server: Server | undefined;
let runtime: WebRuntime | undefined;

async function request(path: string, init?: RequestInit, throttle?: RequestThrottle, runtime?: WebRuntime): Promise<Response> {
  server = createWebServer(throttle, runtime);
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return fetch(`http://127.0.0.1:${String(address.port)}${path}`, init);
}

afterEach(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server?.close((error) => { if (error) reject(error); else resolve(); }); });
  } finally {
    server = undefined;
    await runtime?.close();
    runtime = undefined;
  }
});

describe('web static host', () => {
  it('serves the installable shell and connectivity assets with safe headers', async () => {
    const shell = await request('/');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(shell.headers.get('cache-control')).toBe('no-cache');
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(shell.headers.get('permissions-policy')).toContain('camera=()');
    expect(shell.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(shell.headers.get('strict-transport-security')).toContain('max-age=31536000');
    await expect(shell.text()).resolves.toContain('rel="manifest"');

    const manifest = await fetch(new URL('/manifest.webmanifest', shell.url));
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    const bootstrap = await fetch(new URL('/app.js', shell.url));
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get('cache-control')).toBe('no-cache');
    const legacyStyles = await fetch(new URL('/pwa.css', shell.url));
    expect(legacyStyles.status).toBe(404);
    // The compiled worker is copied only during `pnpm build`; live-host smoke verifies its root-scope header.
  });

  it('exposes liveness but does not expose arbitrary files', async () => {
    const live = await request('/health/live', { headers: { 'x-correlation-id': 'valid-request-123' } });
    await expect(live.json()).resolves.toEqual({ status: 'ok' });
    expect(live.headers.get('x-correlation-id')).toBe('valid-request-123');
    const missing = await fetch(new URL('/../package.json', live.url));
    expect(missing.status).toBe(404);
  });

  it('serves only the Gmail callback document while preserving OAuth endpoint contracts', async () => {
    // No authenticated or valid token request is made; the unreachable fixture URL cannot reach user data.
    runtime = createWebRuntimeFromEnvironment({
      NODE_ENV: 'development',
      ATTACHMENT_TEMP_DIRECTORY: '/var/tmp',
      DATABASE_URL: 'postgresql://synthetic:synthetic-only@127.0.0.1:1/hypermail-server-fixture',
      APP_ORIGIN: 'https://mail.example.test',
      AUTH_SECRET: 'a'.repeat(32),
      OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32),
      HYPERMAIL_URL: 'https://hypermail.internal/mcp',
      HYPERMAIL_KEY: 'b'.repeat(16),
      HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated',
      VAPID_SUBJECT: 'mailto:owner@example.test',
      VAPID_PUBLIC_KEY: 'c'.repeat(16),
      VAPID_PRIVATE_KEY: 'd'.repeat(16),
      PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32),
    });
    const callback = await request('/oauth/gmail/callback?error=access_denied', undefined, undefined, runtime);
    expect(callback.status).toBe(200);
    expect(callback.headers.get('content-type')).toContain('text/html');
    expect(new URL(callback.url).searchParams.get('error')).toBe('access_denied');
    await expect(callback.text()).resolves.toContain('rel="manifest"');

    const head = await fetch(callback.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('text/html');
    await expect(head.text()).resolves.toBe('');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const unsupported = await fetch(callback.url, { method });
      expect(unsupported.status).toBe(405);
      expect(unsupported.headers.get('allow')).toBe('GET, HEAD');
    }

    for (const path of ['/oauth/unknown', '/oauth/gmail/callback/extra', '/oauth/gmail/callback/']) {
      const unknown = await fetch(new URL(path, callback.url));
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('content-type')).toContain('application/json');
      await expect(unknown.json()).resolves.toMatchObject({ error: 'Not found' });
    }

    const tokenUrl = new URL('/oauth/token', callback.url);
    const wrongMethod = await fetch(tokenUrl);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
    expect(wrongMethod.headers.get('content-type')).toContain('application/json');

    const wrongContentType = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(wrongContentType.status).toBe(415);
    await expect(wrongContentType.json()).resolves.toEqual({ error: 'invalid_request' });

    const invalidForm = await fetch(tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) });
    expect(invalidForm.status).toBe(400);
    await expect(invalidForm.json()).resolves.toEqual({ error: 'invalid_request' });

    const authorizeUrl = new URL('/oauth/authorize?client_id=unknown&state=preserved%2Bstate', callback.url);
    for (const accept of ['text/html', 'application/xhtml+xml, TEXT/HTML; charset=utf-8; q=0.9']) {
      const document = await fetch(authorizeUrl, { headers: { Accept: accept } });
      expect(document.status).toBe(200);
      expect(document.headers.get('content-type')).toContain('text/html');
      expect(document.headers.get('cache-control')).toBe('no-store');
      expect(document.headers.get('vary')).toBe('Accept');
      await expect(document.text()).resolves.toContain('rel="manifest"');
    }
    const consentHead = await fetch(authorizeUrl, { method: 'HEAD', headers: { Accept: 'text/html' } });
    expect(consentHead.status).toBe(200);
    expect(consentHead.headers.get('cache-control')).toBe('no-store');
    expect(consentHead.headers.get('vary')).toBe('Accept');
    await expect(consentHead.text()).resolves.toBe('');

    // Wildcards, substrings and explicitly unacceptable HTML must not turn OAuth responses into documents.
    for (const accept of ['application/json', '*/*', 'text/*', 'text/html;q=0', 'text/html-extra']) {
      const consent = await fetch(authorizeUrl, { headers: { Accept: accept }, redirect: 'manual' });
      expect(consent.status).toBe(302);
      expect(consent.headers.get('location')).toBe('https://mail.example.test/login');
      expect(consent.headers.get('content-type')).toContain('application/json');
      expect(consent.headers.get('cache-control')).toBe('no-store');
      expect(consent.headers.get('vary')).toBe('Accept');
    }
    const rejectedDecision = await fetch(authorizeUrl, { method: 'POST', headers: { Accept: 'application/json', Origin: 'https://foreign.example.test', 'Content-Type': 'application/json' }, body: '{"request_token":"untrusted","decision":"deny"}', redirect: 'manual' });
    expect(rejectedDecision.status).toBe(403);
    expect(rejectedDecision.headers.get('location')).toBeNull();
    expect(rejectedDecision.headers.get('vary')).toBe('Accept');
    expect(rejectedDecision.headers.get('cache-control')).toBe('no-store');
    await expect(rejectedDecision.json()).resolves.toEqual({ error: 'forbidden' });
  });

  it('adapts same-origin API JSON requests without exposing the static host as an API fallback', async () => {
    let received: unknown;
    const runtime: WebRuntime = { dispatch: (request) => { received = request; return Promise.resolve({ status: 201, body: { status: 'ok' } }); }, close: () => Promise.resolve() };
    const response = await request('/api/v1/example?filter=new', { method: 'POST', headers: { origin: 'https://mail.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ value: 1 }) }, undefined, runtime);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(received).toMatchObject({ pathname: '/api/v1/example', origin: 'https://mail.example.test', query: { filter: 'new' }, body: { value: 1 } });
  });

  it('streams attachment responses with backpressure and cleans up after completion', async () => {
    const cleanup = vi.fn(() => Promise.resolve()); const runtime: WebRuntime = { dispatch: () => Promise.resolve({ status: 200, headers: { 'content-type': 'text/plain' }, stream: Readable.from(['streamed']), cleanup }), close: () => Promise.resolve() };
    const response = await request('/api/v1/attachment', undefined, undefined, runtime);
    await expect(response.text()).resolves.toBe('streamed'); await new Promise((resolve) => setImmediate(resolve)); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('closes the composed runtime when the web listener shuts down', async () => {
    const close = vi.fn(() => Promise.resolve());
    const listener = startWebServer(0, { dispatch: () => Promise.resolve(null), close });
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    await new Promise<void>((resolve, reject) => listener.close((error) => { if (error) reject(error); else resolve(); }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('generates safe correlation IDs and rejects oversized bodies and excessive requests with generic errors', async () => {
    const invalid = await request('/', { headers: { 'x-correlation-id': '<script>alert(1)</script>' } });
    expect(invalid.headers.get('x-correlation-id')).toMatch(/^[A-Za-z0-9-]{36}$/);
    await expect(invalid.text()).resolves.not.toContain('<script>');

    const unsupported = await request('/', { method: 'POST', body: 'x' });
    expect(unsupported.status).toBe(405);

    const body = await request('/', { method: 'POST', body: 'x'.repeat(8_193) });
    expect(body.status).toBe(413);
    await expect(body.json()).resolves.toMatchObject({ error: 'Payload too large' });

    const throttle = new RequestThrottle(1);
    const first = await request('/', undefined, throttle);
    expect(first.status).toBe(200);
    const second = await fetch(new URL('/', first.url));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ error: 'Too many requests' });
  });
});
