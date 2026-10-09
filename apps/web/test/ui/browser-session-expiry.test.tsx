// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); roots.push(root); return root; } };
});
const browserTimeout = 30_000;
const accountId = '11111111-1111-4111-8111-111111111111';
const draft = { id: 'draft-one', accountId, sourceMessageId: null, createdBy: 'user', state: 'editing', version: 1, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Saved subject', body: 'Saved body', bodyFormat: 'markdown' };
const session = () => Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [{ id: accountId, email: 'mailbox@example.test', displayName: 'Mailbox', provider: 'gmail', state: 'ready' }] });
const expired = () => new Response(null, { status: 401 });
const bannerCopy = 'Your session expired. Sign in to continue. Copy any unsaved text before signing in; signing in will reload this page.';
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
function installFetch(operation: (url: URL, init?: RequestInit) => Promise<Response> | undefined) {
  const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const custom = operation(url, init);
    if (custom) return custom;
    if (url.pathname === '/api/v1/session') return Promise.resolve(session());
    if (url.pathname === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [draft] }));
    if (url.pathname === '/api/v1/drafts/draft-one') return Promise.resolve(Response.json({ draft }));
    if (url.pathname === '/api/v1/drafts/draft-one/history') return Promise.resolve(Response.json({ revisions: [] }));
    if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
    if (url.pathname === '/api/v1/activities') return Promise.resolve(Response.json({ items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } }));
    if (url.pathname === '/api/v1/inbox') return Promise.resolve(Response.json({ messages: [{ id: 'message-one', account_id: accountId, sender: 'Sender', subject: 'Message subject', preview: 'Preview only', received_at: '2026-10-01T12:00:00Z' }], nextCursor: null }));
    if (url.pathname.startsWith('/api/v1/agent')) return Promise.resolve(new Response(null, { status: 503 }));
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function mount(): Promise<void> {
  entryLoad = import('../../src/browser.js');
  await entryLoad;
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Open message from Sender: Message subject' })).toBeTruthy(); }, { timeout: 10_000 });
}
async function openDraft(): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByRole('button', { name: 'Drafts', exact: true })[0] as HTMLElement);
  fireEvent.click(await screen.findByRole('button', { name: 'Open draft Saved subject' }));
  return screen.findByRole('textbox', { name: 'Subject', exact: true });
}
beforeEach(() => {
  vi.resetModules(); entryLoad = undefined;
  window.history.replaceState(null, '', '/'); sessionStorage.clear();
  app = document.createElement('div'); app.id = 'app'; document.body.append(app);
});
afterEach(async () => {
  try { await entryLoad; }
  finally {
    try { act(() => { for (const root of roots.splice(0)) root.unmount(); }); }
    finally { app.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); }
  }
}, browserTimeout);

describe('explicit browser session-expiry recovery', () => {
  it('keeps typed draft edits and the pending OAuth handle until explicit Sign in, without misclassifying the save as a conflict', async () => {
    let sessionExpired = false;
    const fetcher = installFetch((url, init) => {
      if (url.pathname === '/api/v1/session' && sessionExpired) return Promise.resolve(expired());
      if (url.pathname === '/api/v1/drafts/draft-one' && init?.method === 'POST') { sessionExpired = true; return Promise.resolve(expired()); }
      return undefined;
    });
    const pending = JSON.stringify({ provider: 'gmail', handle: 'pending-handle', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    sessionStorage.setItem('hypermail.pending-mailbox.v1', pending);
    await mount();
    const subject = await openDraft();
    fireEvent.change(subject, { target: { value: 'My unsaved subject' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message (markdown)' }), { target: { value: 'My unsaved message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft', exact: true }));
    expect(await screen.findByText(bannerCopy)).toBeTruthy();
    expect((subject as HTMLInputElement).value).toBe('My unsaved subject');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message (markdown)' }).value).toBe('My unsaved message');
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft', exact: true }).disabled).toBe(false); });
    expect(screen.queryByText(/The draft could not be saved/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload saved version and compare' })).toBeNull();
    expect(sessionStorage.getItem('hypermail.pending-mailbox.v1')).toBe(pending);
    expect(fetcher.mock.calls.filter(([input, init]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) === '/api/v1/drafts/draft-one' && init?.method === 'POST')).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('alert', { name: 'Session expired' })).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByText('Your session expired. Sign in to continue.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Subject', exact: true })).toBeNull();
    expect(sessionStorage.getItem('hypermail.pending-mailbox.v1')).toBe(pending);
  }, browserTimeout);

  it('shows expiry rather than a provider error when message detail loses authentication', async () => {
    let sessionExpired = false;
    installFetch(url => {
      if (url.pathname === '/api/v1/session' && sessionExpired) return Promise.resolve(expired());
      if (url.pathname === '/api/v1/messages/message-one') { sessionExpired = true; return Promise.resolve(expired()); }
      return undefined;
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open message from Sender: Message subject' }));
    expect(await screen.findByText(bannerCopy)).toBeTruthy();
    expect(screen.queryByText('The provider is unavailable. Retry to load the full message.')).toBeNull();
    expect(within(screen.getByRole('article', { name: 'Message detail' })).queryByText('Preview only')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  }, browserTimeout);

  it('does not leave Login or launch follow-up reads when a pre-login draft mutation finishes late', async () => {
    const save = Promise.withResolvers<Response>();
    const fetcher = installFetch((url, init) => url.pathname === '/api/v1/drafts/draft-one' && init?.method === 'POST' ? save.promise : undefined);
    await mount();
    fireEvent.change(await openDraft(), { target: { value: 'Pending edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft', exact: true }));
    await waitFor(() => { expect(fetcher.mock.calls.some(([input, init]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) === '/api/v1/drafts/draft-one' && init?.method === 'POST')).toBe(true); });
    act(() => { window.dispatchEvent(new Event('hypermail:session-expired')); });
    fireEvent.click(within(screen.getByRole('alert', { name: 'Session expired' })).getByRole('button', { name: 'Sign in' }));
    const requestsAtLogin = fetcher.mock.calls.length;
    await act(async () => { save.resolve(Response.json({ draft: { ...draft, subject: 'Pending edit', version: 2 } })); await save.promise; });
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Desktop mailbox' })).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(requestsAtLogin);
    expect(screen.queryByText(/Draft saved;/)).toBeNull();
  }, browserTimeout);

  it('discards a late startup Activity page after explicit Login without starting its dependent collections', async () => {
    const activity = Promise.withResolvers<Response>();
    const fetcher = installFetch(url => url.pathname === '/api/v1/activities' ? activity.promise : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await waitFor(() => { expect(fetcher.mock.calls.some(([input]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).startsWith('/api/v1/activities'))).toBe(true); }, { timeout: 10_000 });
    act(() => { window.dispatchEvent(new Event('hypermail:session-expired')); });
    fireEvent.click(within(screen.getByRole('alert', { name: 'Session expired' })).getByRole('button', { name: 'Sign in' }));
    const requestsAtLogin = fetcher.mock.calls.length;
    await act(async () => { activity.resolve(Response.json({ items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } })); await activity.promise; });
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(fetcher.mock.calls).toHaveLength(requestsAtLogin);
    expect(screen.queryByRole('region', { name: 'Desktop mailbox' })).toBeNull();
  }, browserTimeout);

  it('stops active proposal polling while the expired-session banner preserves the shell', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let dashboardReads = 0;
    const delayedPoll = Promise.withResolvers<Response>();
    const fetcher = installFetch(url => {
      if (url.pathname === '/api/v1/agent') {
        dashboardReads += 1;
        if (dashboardReads === 2) return delayedPoll.promise;
        return Promise.resolve(Response.json({ dashboard: {
          actions: [], questions: [], alerts: [], autonomy: { global: { state: 'running', version: 1 }, accounts: {} },
          proposals: [{ id: 'proposal-one', activityId: 'activity-one', accountId, runId: 'run-one', origin: 'model', kind: 'archive', payload: { kind: 'archive', target: { accountId, messageId: 'message-one' } }, confidence: 1, threshold: 0.9, revision: 1, state: 'ready', reason: 'Archive after verification', evidenceSnapshot: {}, dependencies: [], action: null, supersedesProposalId: null, createdAt: '2026-10-01T12:00:00Z' }],
        } }));
      }
      if (url.pathname === '/api/v1/agent/folders') return Promise.resolve(Response.json({ folders: [] }));
      return undefined;
    });
    try {
      await mount();
      await waitFor(() => { expect(dashboardReads).toBe(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(dashboardReads).toBe(2);
      act(() => { window.dispatchEvent(new Event('hypermail:session-expired')); });
      const callsAtExpiry = fetcher.mock.calls.length;
      await act(async () => {
        delayedPoll.resolve(Response.json({ dashboard: { actions: [], questions: [], alerts: [], proposals: [], autonomy: { global: { state: 'running', version: 1 }, accounts: {} } } }));
        await delayedPoll.promise;
      });
      expect(fetcher.mock.calls).toHaveLength(callsAtExpiry);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(dashboardReads).toBe(2);
      expect(screen.getByText(bannerCopy)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open message from Sender: Message subject' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  }, browserTimeout);

  it('keeps a wrong current password local when session validation still succeeds', async () => {
    installFetch((url, init) => url.pathname === '/api/v1/auth/password' && init?.method === 'POST' ? Promise.resolve(expired()) : undefined);
    await mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'More', exact: true })[0] as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: /Account/ }));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new password value' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new password value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password', exact: true }));
    expect(await screen.findByText('Your current password was not accepted.')).toBeTruthy();
    expect(screen.queryByText(bannerCopy)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Current password').value).toBe('wrong password');
  }, browserTimeout);
});
