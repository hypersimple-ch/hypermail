import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { sessionCookie } from '@hypermail/auth';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { withPostgresSchemas } from '../../worker/test/postgres-test.js';
import { createWebRuntimeFromEnvironment, type WebRuntime } from '../src/runtime.js';
import { createWebServer } from '../src/server.js';
import { RequestThrottle } from '../src/security/limits.js';
import { pkceS256 } from '../src/oauth/service.js';

const databaseUrl = process.env['DATABASE_URL'] ?? '';
const appOrigin = 'http://127.0.0.1:3000';
const oauthHashKey = 'o'.repeat(32);
const redirectUri = 'https://runtime-client.example.test/callback?registered=1';
const verifier = 'runtime-fixture-verifier-'.repeat(3);
const state = 'runtime consent state & callback';

function disposableDatabaseUrl(): string {
  const parsed = new URL(databaseUrl);
  // withPostgresSchemas drops schemas. Never accept the application's usual DB.
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/hypermail_audit' || parsed.username !== 'audit') {
    throw new Error('runtime-startup requires the disposable loopback audit database (audit/hypermail_audit)');
  }
  return databaseUrl;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated HTTP listener');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
  });
}

type Fixture = {
  sql: Sql;
  base: string;
  providerRequests: string[];
  userId: string;
  email: string;
  cookie: string;
};

async function withRuntime(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withPostgresSchemas(disposableDatabaseUrl(), async sql => {
    const directory = await mkdtemp('/var/tmp/hypermail-runtime-audit-');
    const providerRequests: string[] = [];
    const provider = createServer((request, response) => {
      providerRequests.push(request.url ?? '/');
      request.resume();
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'isolated provider must not be needed' }));
    });
    let runtime: WebRuntime | undefined;
    let server: Server | undefined;
    try {
      const providerBase = await listen(provider);
      runtime = createWebRuntimeFromEnvironment({
        DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_ORIGIN: appOrigin,
        AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: oauthHashKey,
        HYPERMAIL_URL: `${providerBase}/mcp`, HYPERMAIL_KEY: 'b'.repeat(16),
        HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated',
        VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16),
        VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32),
        ATTACHMENT_TEMP_DIRECTORY: directory,
      });
      const userId = randomUUID();
      const email = `${userId}@example.test`;
      const token = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(token).digest('base64url');
      await sql`insert into app.users(id,email,password_hash) values(${userId},${email},'synthetic-unused-password-hash')`;
      await sql`insert into app.sessions(user_id,token_hash,created_at,expires_at) values(${userId},${digest},now(),now()+interval '1 hour')`;
      const cookie = sessionCookie(token, { insecureLocalDevelopment: true }).split(';')[0];
      if (!cookie) throw new Error('session cookie is missing');
      server = createWebServer(new RequestThrottle(1_000), runtime);
      const base = await listen(server);
      await work({ sql, base, providerRequests, userId, email, cookie });
    } finally {
      // Both connection pools must close before withPostgresSchemas drops app.
      try { if (server) await closeServer(server); }
      finally {
        try { await runtime?.close(); }
        finally { await closeServer(provider); await rm(directory, { recursive: true, force: true }); }
      }
    }
  });
}

type ConsentFixture = Fixture & {
  clientId: string;
  accountIds: [string, string];
  mailboxes: { id: string; email: string }[];
  foreignAccountId: string;
};

async function seedConsent(fixture: Fixture): Promise<ConsentFixture> {
  const { sql, userId } = fixture;
  const connectionId = randomUUID();
  const clientId = `runtime-client-${randomUUID()}`;
  const accountIds: [string, string] = [randomUUID(), randomUUID()];
  const foreignAccountId = randomUUID();
  const mailboxes = accountIds.map(id => ({ id, email: `${id}@example.test` }));
  await sql.begin(async tx => {
    await tx`insert into app.agent_connections(id,user_id,adapter,external_profile_id,display_name,state,verified_at) values(${connectionId},${userId},'test',${clientId},'Runtime Agent','connected',now())`;
    for (const mailbox of mailboxes) {
      await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${mailbox.id},${userId},'microsoft',${mailbox.id},${mailbox.email},'ready')`;
      await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${mailbox.id})`;
      await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,agent_connection_id) values(${randomUUID()},${userId},${mailbox.id},'agent_connection',${connectionId})`;
      await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,agent_connection_id,capabilities,invocation_modes,state,approved_at) values(${randomUUID()},${userId},${mailbox.id},'agent_connection',${connectionId},array['mail.mark_read','send.request']::text[],array['interactive']::text[],'active',now())`;
    }
    await tx`insert into app.oauth_public_clients(client_id,display_name,user_id,agent_connection_id,redirect_uris) values(${clientId},'Runtime Consent Client',${userId},${connectionId},array[${redirectUri}]::text[])`;
    const foreignUserId = randomUUID();
    await tx`insert into app.users(id,email,password_hash) values(${foreignUserId},${`${foreignUserId}@example.test`},'synthetic-unused-password-hash')`;
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${foreignAccountId},${foreignUserId},'microsoft',${foreignAccountId},${`${foreignAccountId}@example.test`},'ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${foreignUserId},${foreignAccountId})`;
  });
  return { ...fixture, clientId, accountIds, mailboxes, foreignAccountId };
}

function authorizationPath(fixture: ConsentFixture, overrides: Record<string, string> = {}): string {
  return `/oauth/authorize?${new URLSearchParams({
    client_id: fixture.clientId, redirect_uri: redirectUri, scope: 'agent:mailbox',
    response_type: 'code', code_challenge_method: 'S256', code_challenge: pkceS256(verifier), state,
    ...overrides,
  }).toString()}`;
}

function privateRepresentation(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim())).toContain('accept');
}

async function beginConsent(fixture: ConsentFixture): Promise<string> {
  const response = await fetch(`${fixture.base}${authorizationPath(fixture)}`, {
    headers: { Cookie: fixture.cookie, Accept: 'application/json' }, redirect: 'manual',
  });
  expect(response.status).toBe(200);
  privateRepresentation(response);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = await response.json() as { request_token: string; mailboxes: { id: string; email: string }[] };
  expect(body).toMatchObject({ clientName: 'Runtime Consent Client', clientId: fixture.clientId, redirectUri, scope: 'agent:mailbox' });
  expect([...body.mailboxes].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...fixture.mailboxes].sort((a, b) => a.id.localeCompare(b.id)));
  expect(body.request_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.request_token;
}

function decide(fixture: ConsentFixture, requestToken: string, decision: 'allow' | 'deny', options: {
  mailboxId?: string; origin?: string; json?: boolean;
} = {}): Promise<Response> {
  const body: Record<string, string> = { request_token: requestToken, decision,
    ...(decision === 'allow' ? { mailbox_id: options.mailboxId ?? fixture.accountIds[1] } : {}),
  };
  return fetch(`${fixture.base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: fixture.cookie, Origin: options.origin ?? appOrigin,
      Accept: options.json === false ? 'text/html' : 'application/json',
      'Content-Type': options.json === false ? 'application/x-www-form-urlencoded' : 'application/json',
    },
    body: options.json === false ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
}

async function jsonRedirect(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  privateRepresentation(response);
  expect(response.headers.get('location')).toBeNull();
  const body = await response.json() as { redirectUrl: string };
  expect(Object.keys(body)).toEqual(['redirectUrl']);
  return new URL(body.redirectUrl);
}

function registeredRedirect(url: URL): void {
  expect(url.origin + url.pathname).toBe('https://runtime-client.example.test/callback');
  expect(url.searchParams.get('registered')).toBe('1');
  expect(url.searchParams.get('state')).toBe(state);
}

async function rejected(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  privateRepresentation(response);
  expect(response.headers.get('location')).toBeNull();
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ error });
  expect(body).not.toHaveProperty('redirectUrl');
}

describe.skipIf(!databaseUrl)('real-runtime startup and OAuth consent (disposable PostgreSQL)', () => {
  it('serves all fresh-owner startup collections without touching the provider and denies anonymous access', async () => {
    await withRuntime(async fixture => {
      const session = await fetch(`${fixture.base}/api/v1/session`, { headers: { Cookie: fixture.cookie } });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ userId: fixture.userId, user: { id: fixture.userId, email: fixture.email }, accounts: [] });
      const collections = [
        ['/api/v1/activities', { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } }],
        ['/api/v1/drafts', { drafts: [] }],
        ['/api/v1/send-requests', { requests: [] }],
      ] as const;
      for (const [path, expected] of collections) {
        const response = await fetch(`${fixture.base}${path}`, { headers: { Cookie: fixture.cookie } });
        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toEqual(expected);
      }
      for (const path of ['/api/v1/session', ...collections.map(([path]) => path)]) {
        const response = await fetch(`${fixture.base}${path}`);
        expect(response.status, path).toBe(401);
        const body = await response.json() as Record<string, unknown>;
        expect(body).toHaveProperty('error');
        for (const privateField of ['accounts', 'items', 'drafts', 'requests', 'user']) expect(body).not.toHaveProperty(privateField);
      }
      expect(fixture.providerRequests).toEqual([]);
    });
  }, 60_000);

  it('negotiates the consent document and private JSON without changing the original authorization query', async () => {
    await withRuntime(async baseFixture => {
      const fixture = await seedConsent(baseFixture);
      const path = authorizationPath(fixture);
      for (const cookie of [fixture.cookie, '']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(`${fixture.base}${path}`, { method, headers: { Accept: 'text/html', Cookie: cookie }, redirect: 'manual' });
          expect(response.status).toBe(200);
          expect(new URL(response.url).pathname + new URL(response.url).search).toBe(path);
          privateRepresentation(response);
          expect(response.headers.get('content-type')).toContain('text/html');
          const document = await response.text();
          if (method === 'HEAD') expect(document).toBe('');
          else expect(document.toLowerCase()).toContain('<!doctype html>');
        }
      }
      await beginConsent(fixture);
      const anonymous = await fetch(`${fixture.base}${path}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
      expect(anonymous.status).toBe(302);
      privateRepresentation(anonymous);
      expect(anonymous.headers.get('location')).toBe(`${appOrigin}/login`);
      expect(fixture.providerRequests).toEqual([]);
    });
  }, 60_000);

  it('allows a selected owned mailbox through JSON and preserves the form 303 redirect contract', async () => {
    await withRuntime(async baseFixture => {
      const fixture = await seedConsent(baseFixture);
      const requestToken = await beginConsent(fixture);
      const redirect = await jsonRedirect(await decide(fixture, requestToken, 'allow'));
      registeredRedirect(redirect);
      expect(redirect.searchParams.has('error')).toBe(false);
      const code = redirect.searchParams.get('code');
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (!code) throw new Error('authorization code is missing');
      const issued = await fixture.sql<{ account_id: string; code_challenge: string }[]>`select account_id,code_challenge from app.oauth_authorization_codes where client_id=${fixture.clientId}`;
      expect(issued).toEqual([{ account_id: fixture.accountIds[1], code_challenge: pkceS256(verifier) }]);
      await rejected(await decide(fixture, requestToken, 'allow'), 400, 'invalid_request');
      const exchanged = await fetch(`${fixture.base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: fixture.clientId, redirect_uri: redirectUri, code, code_verifier: verifier }).toString() });
      expect(exchanged.status).toBe(200);
      const tokens: unknown = await exchanged.json();
      expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'agent:mailbox' });
      if (typeof tokens !== 'object' || tokens === null || !('access_token' in tokens) || !('refresh_token' in tokens)) throw new Error('token response is missing tokens');
      expect(typeof tokens.access_token).toBe('string');
      expect(typeof tokens.refresh_token).toBe('string');
      const formToken = await beginConsent(fixture);
      const form = await decide(fixture, formToken, 'allow', { json: false, mailboxId: fixture.accountIds[0] });
      expect(form.status).toBe(303);
      privateRepresentation(form);
      const location = form.headers.get('location');
      if (!location) throw new Error('form authorization redirect is missing');
      const formRedirect = new URL(location);
      registeredRedirect(formRedirect);
      expect(formRedirect.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(formRedirect.searchParams.get('code')).not.toBe(code);
      expect(await fixture.sql<{ account_id: string }[]>`select account_id from app.oauth_authorization_codes where client_id=${fixture.clientId} and account_id=${fixture.accountIds[0]}`).toEqual([{ account_id: fixture.accountIds[0] }]);
    });
  }, 60_000);

  it('denies with access_denied and state, consumes the request, and issues no authorization code', async () => {
    await withRuntime(async baseFixture => {
      const fixture = await seedConsent(baseFixture);
      const requestToken = await beginConsent(fixture);
      const redirect = await jsonRedirect(await decide(fixture, requestToken, 'deny'));
      registeredRedirect(redirect);
      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.has('code')).toBe(false);
      await rejected(await decide(fixture, requestToken, 'allow'), 400, 'invalid_request');
      const form = await decide(fixture, await beginConsent(fixture), 'deny', { json: false });
      expect(form.status).toBe(303);
      privateRepresentation(form);
      const location = form.headers.get('location');
      if (!location) throw new Error('form denial redirect is missing');
      const formRedirect = new URL(location);
      registeredRedirect(formRedirect);
      expect(formRedirect.searchParams.get('error')).toBe('access_denied');
      expect(await fixture.sql`select code_digest from app.oauth_authorization_codes where client_id=${fixture.clientId}`).toEqual([]);
    });
  }, 60_000);

  it('rejects expired requests, unknown clients, foreign mailboxes and untrusted origins without redirecting', async () => {
    await withRuntime(async baseFixture => {
      const fixture = await seedConsent(baseFixture);
      const unknown = await fetch(`${fixture.base}${authorizationPath(fixture, { client_id: `unknown-${randomUUID()}` })}`, { headers: { Cookie: fixture.cookie, Accept: 'application/json' }, redirect: 'manual' });
      await rejected(unknown, 400, 'invalid_request');
      const badRedirect = await fetch(`${fixture.base}${authorizationPath(fixture, { redirect_uri: 'https://unregistered.example.test/callback' })}`, { headers: { Cookie: fixture.cookie, Accept: 'application/json' }, redirect: 'manual' });
      await rejected(badRedirect, 400, 'invalid_request');
      const expired = await beginConsent(fixture);
      const requestDigest = createHmac('sha256', oauthHashKey).update(expired).digest('base64url');
      await fixture.sql`update app.oauth_consent_requests set expires_at=now()-interval '1 second' where request_digest=${requestDigest}`;
      await rejected(await decide(fixture, expired, 'allow'), 400, 'invalid_request');
      await rejected(await decide(fixture, expired, 'deny'), 400, 'invalid_request');
      const active = await beginConsent(fixture);
      await rejected(await decide(fixture, active, 'allow', { mailboxId: fixture.foreignAccountId }), 400, 'invalid_request');
      await rejected(await decide(fixture, active, 'allow', { origin: 'https://attacker.example.test' }), 403, 'forbidden');
      await rejected(await decide(fixture, active, 'deny', { origin: 'https://attacker.example.test' }), 403, 'forbidden');
      expect(await fixture.sql`select code_digest from app.oauth_authorization_codes where client_id=${fixture.clientId}`).toEqual([]);
      // Rejections must not consume a valid request: an explicit valid decision still works.
      const redirect = await jsonRedirect(await decide(fixture, active, 'allow'));
      registeredRedirect(redirect);
      expect(redirect.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fixture.providerRequests).toEqual([]);
    });
  }, 60_000);
});
