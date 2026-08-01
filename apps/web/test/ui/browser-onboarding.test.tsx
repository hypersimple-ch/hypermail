// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('browser Gmail callback', () => {
  it('resumes from opaque session metadata, cleans the URL and reloads projections', async () => {
    document.body.innerHTML = '<div id="app"></div>';
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
      if (url === '/api/v1/inbox') return Promise.resolve(Response.json({ messages: [] }));
      if (url.startsWith('/api/v1/activities')) return Promise.resolve(Response.json({ items: [] }));
      if (url === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [] }));
      if (url === '/api/v1/agent') return Promise.resolve(new Response(null, { status: 503 }));
      if (url === '/api/v1/mailboxes/complete') {
        if (typeof init?.body !== 'string') throw new Error('Expected completion JSON.');
        completionBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(Response.json({ status: 'ready', account: { id: 'gmail', provider: 'gmail', email: 'mail@example.test', displayName: 'Personal Gmail', state: 'ready' } }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('../../src/browser.js');

    await waitFor(() => { expect(completionBody).toEqual({ provider: 'gmail', handle: 'opaque-handle', authorizationResponse }); });
    await waitFor(() => { expect(sessionLoads).toBeGreaterThanOrEqual(2); });
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('hypermail.pending-mailbox.v1')).toBeNull();
    expect((await screen.findAllByText('Personal Gmail')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mailbox connected.').length).toBeGreaterThan(0);
  });
});
