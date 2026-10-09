// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthConsent } from '../../src/oauth/consent.js';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => {
    const root = actual.createRoot(...args); roots.push(root); return root;
  } };
});
const browserTimeout = 30_000;
const authorizationPath = '/oauth/authorize?client_id=registered-client&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback%3Fx%3D1&response_type=code&scope=agent%3Amailbox&code_challenge=s256-challenge&code_challenge_method=S256&state=original%2Bstate';
const mailboxA = { id: 'owned-a', email: 'first@example.test' };
const mailboxB = { id: 'owned-b', email: 'second@example.test' };
const consent = (mailboxes = [mailboxA, mailboxB], requestToken = 'request-token') => ({
  clientName: 'Registered assistant', clientId: 'registered-client',
  redirectUri: 'https://client.example.test/callback?x=1', scope: 'agent:mailbox',
  request_token: requestToken, mailboxes,
});
const authorizedRedirect = 'https://client.example.test/callback?x=1&code=approved-code&state=original%2Bstate';
const deniedRedirect = 'https://client.example.test/callback?x=1&error=access_denied&state=original%2Bstate';
let entryLoad: Promise<unknown> | undefined;
let app: HTMLDivElement | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function navigationPorts() {
  const original = window;
  const url = new URL(authorizationPath, original.location.origin);
  const assign = vi.fn(), reload = vi.fn();
  const location = { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: '', assign, reload };
  // jsdom's Location methods are nonconfigurable. Keep all browser APIs real,
  // replacing only the external navigation boundary rather than consent logic.
  vi.stubGlobal('window', new Proxy(original, { get: (target, key): unknown => key === 'location' ? location : Reflect.get(target, key) as unknown }));
  vi.stubGlobal('location', location);
  return { assign, reload, location };
}
function serverPorts(options: { get?: () => Promise<Response>; post?: () => Promise<Response>; session?: () => Promise<Response> } = {}) {
  const requests: { path: string; method: string }[] = [];
  const decisions: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    requests.push({ path, method });
    if (path === '/api/v1/session') return options.session?.() ?? new Response(null, { status: 401 });
    if (method === 'GET' && path === authorizationPath) {
      if (new Headers(init?.headers).get('accept') !== 'application/json') return new Response('<html>Document representation</html>', { headers: { 'content-type': 'text/html' } });
      return options.get?.() ?? Response.json(consent());
    }
    if (method === 'POST' && path === '/oauth/authorize') {
      const headers = new Headers(init?.headers);
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON decision body');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      decisions.push(body);
      if (headers.get('accept') !== 'application/json' || !headers.get('content-type')?.includes('application/json') ||
          body['request_token'] !== 'request-token' ||
          (body['decision'] === 'allow' ? body['mailbox_id'] !== mailboxB.id || Object.keys(body).length !== 3 : body['decision'] !== 'deny' || Object.keys(body).length !== 2)) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      return options.post?.() ?? Response.json({ redirectUrl: body['decision'] === 'allow' ? authorizedRedirect : deniedRedirect });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, decisions, requests };
}
function mountConsent(): void {
  render(<OAuthConsent />);
}
async function chooseMailbox() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Mailbox/ }));
  await user.click(await screen.findByRole('option', { name: mailboxB.email }));
  return screen.getByRole('button', { name: /Mailbox/ });
}
function decision(name: 'Allow' | 'Deny') { return screen.getByRole<HTMLButtonElement>('button', { name, exact: true }); }
function expectBlockedDecisions() {
  expect(decision('Allow').disabled).toBe(true);
  expect(decision('Deny').disabled).toBe(true);
}

beforeEach(() => {
  vi.resetModules();
  entryLoad = undefined;
  app = undefined;
  window.history.replaceState(null, '', authorizationPath);
});
afterEach(async () => {
  try { await entryLoad; }
  finally {
    cleanup();
    act(() => { for (const root of roots.splice(0)) root.unmount(); });
    app?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  }
}, browserTimeout);

describe('OAuth consent decisions', () => {
  it('shows the registered destination and scope, requires a mailbox choice, and navigates only after approval succeeds', async () => {
    const navigation = navigationPorts(), pending = deferred<Response>();
    const server = serverPorts({ post: () => pending.promise });
    mountConsent();
    expect(await screen.findByText('Registered assistant')).toBeTruthy();
    expect(screen.getByText(consent().redirectUri)).toBeTruthy();
    expect(screen.getByText('agent:mailbox')).toBeTruthy();
    expect(decision('Allow').disabled).toBe(true);
    expect(server.decisions).toEqual([]);
    expect(navigation.assign).not.toHaveBeenCalled();
    const picker = await chooseMailbox();
    expect(picker.textContent).toContain(mailboxB.email);
    expect(decision('Allow').disabled).toBe(false);
    fireEvent.click(decision('Allow'));
    await waitFor(() => { expect(server.decisions).toHaveLength(1); });
    expectBlockedDecisions();
    fireEvent.click(decision('Allow'));
    fireEvent.click(decision('Deny'));
    expect(server.decisions).toHaveLength(1);
    expect(navigation.assign).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(Response.json({ redirectUrl: authorizedRedirect })); await pending.promise; });
    await waitFor(() => { expect(navigation.assign).toHaveBeenCalledExactlyOnceWith(authorizedRedirect); });
    expect(server.decisions[0]).toEqual({ request_token: 'request-token', decision: 'allow', mailbox_id: mailboxB.id });
  });

  it('allows denial without a mailbox and returns the server access_denied destination', async () => {
    const navigation = navigationPorts();
    const server = serverPorts({ get: () => Promise.resolve(Response.json(consent([]))) });
    mountConsent();
    expect(await screen.findByText(/No mailboxes are available/)).toBeTruthy();
    expect(decision('Allow').disabled).toBe(true);
    expect(decision('Deny').disabled).toBe(false);
    expect(server.decisions).toEqual([]);
    fireEvent.click(decision('Deny'));
    await waitFor(() => { expect(navigation.assign).toHaveBeenCalledExactlyOnceWith(deniedRedirect); });
    expect(server.decisions).toEqual([{ request_token: 'request-token', decision: 'deny' }]);
  });

  it('keeps loading explicit and never approves while the consent request is pending', async () => {
    const navigation = navigationPorts(), pending = deferred<Response>();
    const server = serverPorts({ get: () => pending.promise });
    mountConsent();
    expect(await screen.findByText('Loading consent…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow', exact: true })).toBeNull();
    expect(server.decisions).toEqual([]);
    await act(async () => { pending.resolve(Response.json(consent())); await pending.promise; });
    await screen.findByRole('button', { name: /Mailbox/ });
    expect(decision('Allow').disabled).toBe(true);
    expect(server.decisions).toEqual([]);
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it.each([
    ['expired request', () => Promise.resolve(Response.json({ error: 'invalid_request', error_description: 'Request expired' }, { status: 400 }))],
    ['consumed request', () => Promise.resolve(Response.json({ error: 'invalid_request', error_description: 'Request consumed' }, { status: 400 }))],
    ['foreign mailbox rejection', () => Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 403 }))],
    ['unauthorized decision with a still-valid session', () => Promise.resolve(new Response(null, { status: 401 }))],
    ['non-JSON response', () => Promise.resolve(new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }))],
    ['redirect response', () => Promise.resolve(new Response(null, { status: 303, headers: { location: authorizedRedirect } }))],
    ['missing redirect result', () => Promise.resolve(Response.json({}))],
    ['empty redirect result', () => Promise.resolve(Response.json({ redirectUrl: '' }))],
    ['unsafe redirect result', () => Promise.resolve(Response.json({ redirectUrl: 'javascript:alert(1)' }))],
    ['uncertain network outcome', () => Promise.reject(new TypeError('Connection lost after submission'))],
  ] as const)('retains the selected mailbox after %s until explicit reload, without replay or navigation', async (_name, post) => {
    const navigation = navigationPorts();
    let loads = 0;
    const server = serverPorts({ get: () => { loads += 1; return Promise.resolve(Response.json(consent())); }, post, session: () => Promise.resolve(Response.json({ user: { id: 'owner' }, accounts: [] })) });
    mountConsent();
    const picker = await chooseMailbox();
    fireEvent.click(decision('Allow'));
    const reload = await screen.findByRole('button', { name: 'Reload consent', exact: true });
    expect(picker.textContent).toContain(mailboxB.email);
    expect(screen.getByText('Registered assistant')).toBeTruthy();
    expectBlockedDecisions();
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(server.decisions).toHaveLength(1);
    expect(loads).toBe(1);
    fireEvent.click(reload);
    await waitFor(() => { expect(loads).toBe(2); expect(decision('Deny').disabled).toBe(false); });
    expect(screen.getByRole('button', { name: /Mailbox/ }).textContent).toContain('Choose a mailbox');
    expect(decision('Allow').disabled).toBe(true);
    expect(server.decisions).toHaveLength(1);
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown client', () => Response.json({ error: 'invalid_client' }, { status: 400 })],
    ['unauthorized response with a still-valid session', () => new Response(null, { status: 401 })],
    ['HTML login document', () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })],
    ['redirect to login', () => new Response(null, { status: 302, headers: { location: '/auth/login' } })],
    ['malformed consent', () => Response.json({ clientName: 'Untrusted partial consent' })],
  ] as const)('offers an explicit GET retry after %s instead of treating the response as consent', async (_name, failure) => {
    const navigation = navigationPorts();
    let loads = 0;
    const server = serverPorts({ get: () => Promise.resolve(++loads === 1 ? failure() : Response.json(consent())), session: () => Promise.resolve(Response.json({ user: { id: 'owner' }, accounts: [] })) });
    mountConsent();
    await screen.findByRole('button', { name: 'Try again', exact: true });
    expect(screen.queryByRole('button', { name: /Mailbox/ })).toBeNull();
    expect(navigation.assign).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again', exact: true }));
    await screen.findByRole('button', { name: /Mailbox/ });
    expect(decision('Allow').disabled).toBe(true);
    expect(server.decisions).toEqual([]);
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(loads).toBe(2);
  });
});

describe('authorization browser entry', () => {
  async function mountBrowser() {
    app = document.createElement('div'); app.id = 'app'; document.body.append(app);
    // This test intentionally exercises the browser entry's import-time mount;
    // a static import would run before its authorization URL and HTTP ports exist.
    entryLoad = import('../../src/browser.js'); await entryLoad;
    return within(app);
  }

  it('signs in on the original authorization URL and reloads without losing any query encoding', async () => {
    const navigation = navigationPorts();
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; requests.push(path);
      if (path === '/api/v1/session') return Promise.resolve(new Response(null, { status: 401 }));
      if (path === '/api/v1/auth/login') return Promise.resolve(Response.json({ ok: true }));
      throw new Error(`Unexpected request before sign-in: ${path}`);
    }));
    const ui = await mountBrowser();
    const signIn = await ui.findByRole('button', { name: 'Sign in', exact: true }, { timeout: 10_000 });
    fireEvent.change(ui.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
    fireEvent.change(ui.getByLabelText('Password'), { target: { value: 'correct-owner-password' } });
    fireEvent.click(signIn);
    await waitFor(() => { expect(navigation.reload).toHaveBeenCalledOnce(); });
    expect(navigation.location.pathname + navigation.location.search).toBe(authorizationPath);
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(requests).toEqual(['/api/v1/session', '/api/v1/auth/login']);
    expect(ui.queryByRole('region', { name: 'Desktop mailbox' })).toBeNull();
  }, browserTimeout);

  it('keeps selected consent visible when a decision discovers session expiry until explicit Sign in', async () => {
    const navigation = navigationPorts();
    let sessions = 0;
    const server = serverPorts({
      session: () => Promise.resolve(++sessions === 1
        ? Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [] })
        : new Response(null, { status: 401 })),
      post: () => Promise.resolve(new Response(null, { status: 401 })),
    });
    const ui = await mountBrowser();
    const picker = await chooseMailbox();
    fireEvent.click(ui.getByRole('button', { name: 'Allow', exact: true }));
    const banner = await ui.findByRole('alert', { name: 'Session expired' });
    expect(within(banner).getByText('Your session expired. Sign in to continue. Copy any unsaved text before signing in; signing in will reload this page.')).toBeTruthy();
    expect(picker.textContent).toContain(mailboxB.email);
    expect(ui.getByText('Registered assistant')).toBeTruthy();
    expectBlockedDecisions();
    expect(server.decisions).toHaveLength(1);
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(navigation.reload).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole('button', { name: 'Sign in', exact: true }));
    expect(await ui.findByLabelText('Password')).toBeTruthy();
    expect(ui.queryByRole('button', { name: /Mailbox/ })).toBeNull();
    expect(navigation.location.pathname + navigation.location.search).toBe(authorizationPath);
    expect(server.decisions).toHaveLength(1);
    expect(navigation.assign).not.toHaveBeenCalled();
  }, browserTimeout);

  it('opens consent as soon as session succeeds without starting Inbox or secondary feature collections', async () => {
    const navigation = navigationPorts(), pending = deferred<Response>();
    const server = serverPorts({
      session: () => Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [{ ...mailboxB, provider: 'gmail', displayName: 'Mailbox B', state: 'ready' }] })),
      get: () => pending.promise,
    });
    const ui = await mountBrowser();
    expect(await ui.findByText('Loading consent…', {}, { timeout: 10_000 })).toBeTruthy();
    expect(server.requests.map(request => request.path)).toEqual(['/api/v1/session', authorizationPath]);
    await act(async () => { pending.resolve(Response.json(consent())); await pending.promise; });
    await ui.findByRole('button', { name: /Mailbox/ });
    expect(ui.queryByRole('region', { name: 'Desktop mailbox' })).toBeNull();
    expect(server.requests.map(request => request.path)).toEqual(['/api/v1/session', authorizationPath]);
    expect(server.decisions).toEqual([]);
    expect(navigation.assign).not.toHaveBeenCalled();
  }, browserTimeout);
});
