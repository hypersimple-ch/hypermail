// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); roots.push(root); return root; } };
});
const browserTimeout = 30_000;
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
beforeEach(() => {
  vi.resetModules();
  entryLoad = undefined;
  app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
});
afterEach(async () => {
  try {
    await entryLoad;
  } finally {
    try {
      act(() => { for (const root of roots.splice(0)) root.unmount(); });
    } finally {
      app.remove();
      sessionStorage.removeItem('hypermail.pending-mailbox.v1');
      window.history.replaceState(null, '', '/');
      vi.unstubAllGlobals();
    }
  }
}, browserTimeout);

describe('browser Gmail callback', () => {
  it('resumes from opaque session metadata, cleans the URL and reloads projections', async () => {
    window.history.replaceState({}, '', '/oauth/gmail/callback?code=callback-code&state=callback-state');
    const authorizationResponse = window.location.href;
    sessionStorage.setItem('hypermail.pending-mailbox.v1', JSON.stringify({ provider: 'gmail', handle: 'opaque-handle', expiresAt: new Date(Date.now() + 60_000).toISOString() }));

    let sessionLoads = 0;
    let completionBody: unknown;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/v1/session') {
        sessionLoads += 1;
        return Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: sessionLoads > 1 ? [{ id: 'gmail', provider: 'gmail', email: 'mail@example.test', displayName: 'Personal Gmail', state: 'ready' }] : [], sendEnabled: false }));
      }
      if (url.startsWith('/api/v1/inbox?')) return Promise.resolve(Response.json({ messages: [], nextCursor: null }));
      if (url.startsWith('/api/v1/activities')) return Promise.resolve(Response.json({ items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } }));
      if (url === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [] }));
      if (url === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
      if (url === '/api/v1/agent' || url === '/api/v1/agent/folders' || url === '/api/v1/agent-connections') return Promise.resolve(new Response(null, { status: 503 }));
      if (url === '/api/v1/mailboxes/complete') {
        if (typeof init?.body !== 'string') throw new Error('Expected completion JSON.');
        completionBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(Response.json({ status: 'ready', account: { id: 'gmail', provider: 'gmail', email: 'mail@example.test', displayName: 'Personal Gmail', state: 'ready' } }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Browser entry mounts at import; install callback URL, session metadata and HTTP fixtures first.
    entryLoad = import('../../src/browser.js');
    await entryLoad;

    await waitFor(() => { expect(completionBody).toEqual({ provider: 'gmail', handle: 'opaque-handle', authorizationResponse }); }, { timeout: 10_000 });
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('hypermail.pending-mailbox.v1')).toBeNull();
    fireEvent.click(within(app).getAllByRole('button', { name: 'Inbox' })[0] as HTMLElement);
    await waitFor(() => { expect(within(app).getAllByRole('button', { name: /Mailbox/ })[0]?.textContent).toContain('Personal Gmail'); }, { timeout: 10_000 });
  }, browserTimeout);
});
