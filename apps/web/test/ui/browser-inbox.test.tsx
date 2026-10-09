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
// Cold browser imports load the whole application graph under the parallel suite.
const browserTimeout = 30_000;
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
type MessageRowApi = { id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string };
const message = (id: string, account: string, subject: string): MessageRowApi => ({ id, account_id: account, sender: 'Sender', subject, preview: 'SHORT PREVIEW', received_at: '2026-10-01T12:00:00Z' });
const page = (messages: MessageRowApi[], nextCursor: string | null = null) => Response.json({ messages, nextCursor });
const inbox = () => within(within(app).getAllByRole('region', { name: 'Inbox' })[0] as HTMLElement);
const reader = () => within(within(app).getAllByRole('article', { name: 'Message detail' })[0] as HTMLElement);
function installFetch(mail: (url: URL) => Promise<Response>, resource?: (url: URL) => Promise<Response> | undefined): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(path, window.location.origin);
    const override = resource?.(url); if (override) return override;
    if (url.pathname === '/api/v1/session') return Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [{ id: a, email: 'a@example.test', displayName: 'Mailbox A', provider: 'gmail', state: 'ready' }, { id: b, email: 'b@example.test', displayName: 'Mailbox B', provider: 'gmail', state: 'ready' }] }));
    if (url.pathname === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [] }));
    if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
    if (url.pathname === '/api/v1/activities' || url.pathname.endsWith('/activities')) return Promise.resolve(Response.json({ items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } }));
    if (url.pathname.startsWith('/api/v1/agent')) return Promise.resolve(new Response(null, { status: 503 }));
    return mail(url);
  }));
}
beforeEach(() => {
  vi.resetModules();
  entryLoad = undefined;
  window.history.replaceState(null, '', '/');
  app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
});
afterEach(async () => {
  try {
    // A timed-out import must settle before its root and HTTP fixtures are removed.
    await entryLoad;
  } finally {
    try {
      act(() => { for (const root of roots.splice(0)) root.unmount(); });
    } finally {
      app.remove();
      vi.unstubAllGlobals();
    }
  }
}, browserTimeout);

describe('provider-backed browser Inbox', () => {
  it('retries a failed session without mistaking it for a provider failure', async () => {
    let attempts = 0;
    installFetch(url => {
      if (url.pathname === '/api/v1/inbox') return Promise.resolve(page([message('recovered', a, 'Recovered Inbox')]));
      throw new Error(`Unexpected request: ${url.pathname}`);
    }, url => url.pathname === '/api/v1/session' && ++attempts === 1 ? Promise.resolve(new Response(null, { status: 503 })) : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    expect(await within(app).findByText('Could not load your session.', {}, { timeout: 10_000 })).toBeTruthy();
    expect(within(app).queryByText(/mail provider is unavailable/i)).toBeNull();
    fireEvent.click(within(app).getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(inbox().getByRole('button', { name: 'Open message from Sender: Recovered Inbox' })).toBeTruthy(); });
  }, browserTimeout);

  it('starts settings and Inbox while Activity and sending are still pending', async () => {
    const activities = Promise.withResolvers<Response>(), sending = Promise.withResolvers<Response>();
    installFetch(url => {
      if (url.pathname === '/api/v1/inbox') return Promise.resolve(page([message('independent', a, 'Independent Inbox')]));
      throw new Error(`Unexpected request: ${url.pathname}`);
    }, url => url.pathname === '/api/v1/activities' ? activities.promise : url.pathname === '/api/v1/drafts' ? sending.promise : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await waitFor(() => { expect(inbox().getByRole('button', { name: 'Open message from Sender: Independent Inbox' })).toBeTruthy(); }, { timeout: 10_000 });
    fireEvent.click(within(within(app).getByRole('complementary', { name: 'Mailbox navigation' })).getByRole('button', { name: 'Account and settings' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Mailboxes & agents/ }));
    fireEvent.click(await within(app).findByRole('button', { name: 'Add mailbox', exact: true }));
    expect(within(app).getByRole<HTMLButtonElement>('button', { name: 'Continue with Gmail', exact: true }).disabled).toBe(false);
    await act(() => { activities.resolve(new Response(null, { status: 503 })); sending.resolve(new Response(null, { status: 503 })); return Promise.all([activities.promise, sending.promise]); });
    expect(within(app).queryByText('Could not load your session.')).toBeNull();
    fireEvent.click(within(app).getAllByRole('button', { name: 'Inbox' })[0] as HTMLElement);
    expect(inbox().getByRole('button', { name: 'Open message from Sender: Independent Inbox' })).toBeTruthy();
  }, browserTimeout);

  it('opens onboarding with zero mailboxes even when secondary collections fail', async () => {
    const provider = vi.fn(() => Promise.resolve(page([])));
    installFetch(provider, url => url.pathname === '/api/v1/session' ? Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [] })) : ['/api/v1/activities', '/api/v1/drafts', '/api/v1/send-requests'].includes(url.pathname) ? Promise.resolve(new Response(null, { status: 503 })) : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await within(app).findByText('Select or connect a mailbox.', {}, { timeout: 10_000 });
    fireEvent.click(within(within(app).getByRole('complementary', { name: 'Mailbox navigation' })).getByRole('button', { name: 'Account and settings' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Mailboxes & agents/ }));
    expect(within(app).getByText('No mailboxes connected.')).toBeTruthy();
    fireEvent.click(await within(app).findByRole('button', { name: 'Add mailbox', exact: true }));
    expect(within(app).getByRole<HTMLButtonElement>('button', { name: 'Continue with Gmail', exact: true }).disabled).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(within(app).queryByText(/mail provider is unavailable/i)).toBeNull();
  }, browserTimeout);

  it('discards old-mailbox and pre-refresh pages, and deduplicates overlapping provider pages', async () => {
    const oldMailbox = Promise.withResolvers<Response>(), oldMore = Promise.withResolvers<Response>();
    let bLoads = 0, moreLoads = 0;
    installFetch(url => {
      if (url.pathname !== '/api/v1/inbox') throw new Error(`Unexpected mail request: ${url.pathname}`);
      if (url.searchParams.get('accountId') === a) return oldMailbox.promise;
      if (url.searchParams.has('cursor')) return ++moreLoads === 1 ? Promise.resolve(page([message('b1', b, 'B first'), message('b2', b, 'B second')], 'next-b')) : oldMore.promise;
      return Promise.resolve(++bLoads === 1 ? page([message('b1', b, 'B first')], 'next-b') : page([message('fresh', b, 'Refreshed B')]));
    });
    // Exercise browser entry loading after DOM/HTTP fixtures; static import mounts too early.
    entryLoad = import('../../src/browser.js');
    await entryLoad;
    const picker = await waitFor(() => inbox().getByRole('button', { name: /Mailbox/ }), { timeout: 10_000 });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'Mailbox B' }));
    await waitFor(() => { expect(inbox().getByRole('button', { name: 'Open message from Sender: B first' })).toBeTruthy(); });
    await act(() => { oldMailbox.resolve(page([message('old-a', a, 'Stale A')])); return oldMailbox.promise; });
    expect(inbox().queryByRole('button', { name: 'Open message from Sender: Stale A' })).toBeNull();
    fireEvent.click(inbox().getByRole('button', { name: 'Load more' }));
    await waitFor(() => { expect(inbox().getByRole('button', { name: 'Open message from Sender: B second' })).toBeTruthy(); });
    expect(inbox().getAllByRole('button', { name: 'Open message from Sender: B first' })).toHaveLength(1);
    fireEvent.click(inbox().getByRole('button', { name: 'Load more' }));
    fireEvent.click(inbox().getByRole('button', { name: 'Refresh' }));
    await waitFor(() => { expect(inbox().getByRole('button', { name: 'Open message from Sender: Refreshed B' })).toBeTruthy(); });
    await act(() => { oldMore.resolve(page([message('late', b, 'Stale page')])); return oldMore.promise; });
    expect(inbox().queryByRole('button', { name: 'Open message from Sender: Stale page' })).toBeNull();
    expect(inbox().queryByRole('button', { name: 'Load more' })).toBeNull();
  }, browserTimeout);

  it('never substitutes preview for full body and ignores a late previous-message detail', async () => {
    const firstDetail = Promise.withResolvers<Response>();
    installFetch(url => {
      if (url.pathname === '/api/v1/inbox') return Promise.resolve(page([message('first', a, 'First message'), message('second', a, 'Second message')]));
      if (url.pathname === '/api/v1/messages/first') return firstDetail.promise;
      if (url.pathname === '/api/v1/messages/second') return Promise.resolve(Response.json({ message: { body: 'COMPLETE SECOND BODY', sender: 'Sender', senderAddress: 'sender@example.test', subject: 'Second message', attachments: [] } }));
      throw new Error(`Unexpected mail request: ${url.pathname}`);
    });
    // Exercise fresh browser entry loading after DOM/HTTP fixtures are installed.
    entryLoad = import('../../src/browser.js');
    await entryLoad;
    fireEvent.click(await waitFor(() => inbox().getByRole('button', { name: 'Open message from Sender: First message' }), { timeout: 10_000 }));
    expect(reader().queryByText('SHORT PREVIEW')).toBeNull();
    fireEvent.click(inbox().getByRole('button', { name: 'Open message from Sender: Second message' }));
    await waitFor(() => { expect(reader().getByText('COMPLETE SECOND BODY')).toBeTruthy(); });
    await act(() => { firstDetail.resolve(Response.json({ message: { body: 'STALE FIRST BODY', sender: 'Sender', subject: 'First message', attachments: [] } })); return firstDetail.promise; });
    expect(reader().queryByText('STALE FIRST BODY')).toBeNull();
    expect(reader().getByText('COMPLETE SECOND BODY')).toBeTruthy();
  }, browserTimeout);
});
