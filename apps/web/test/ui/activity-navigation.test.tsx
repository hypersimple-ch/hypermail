// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityPage, ActivityRecord } from '../../src/activity/contracts.js';
import { handleNotificationClick } from '../../src/notifications/service-worker.js';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); roots.push(root); return root; } };
});
const browserTimeout = 30_000;
const accountId = '11111111-1111-4111-8111-111111111111';
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
const record = (id: string, state: ActivityRecord['state'] = 'handled'): ActivityRecord => ({
  id, accountId, accountLabel: 'Personal', messageId: `message-${id}`, messageLabel: `Original ${id}`,
  title: `Work ${id}`, state, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z',
  timeline: [{ id: `event-${id}`, at: '2026-10-01T00:00:00Z', label: `Completed ${id}` }],
});
const page = (items: ActivityRecord[] = [], nextCursor: string | null = null): ActivityPage => ({
  items, nextCursor, counts: { new: items.filter(item => item.state === 'new' || item.state === 'handled').length, questions: items.filter(item => item.state === 'waiting_question').length, failed: items.filter(item => item.state === 'failed').length, history: items.filter(item => item.state === 'acknowledged').length },
});
const detail = (item: ActivityRecord) => Response.json({ activity: item });
const failure = (status = 503) => new Response(null, { status });
const ui = () => within(app);
const activityDetail = (id: string) => ui().findByRole('article', { name: `Activity detail: Work ${id}` });
const activityList = () => within(ui().getByRole('region', { name: 'Activity' }));
const primary = () => within(ui().getByRole('navigation', { name: 'Primary' }));
const backToActivity = () => fireEvent.click(within(ui().getByRole('region', { name: 'Workspace' })).getByRole('button', { name: 'Activity', exact: true }));
const assistant = () => within(document.body).findByRole('dialog', { name: 'Assistant' });

type HttpFixture = (url: URL, init?: RequestInit) => Promise<Response> | undefined;
function installFetch(fixture: HttpFixture): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    const response = fixture(url, init); if (response) return response;
    if (url.pathname === '/api/v1/session') return Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [{ id: accountId, email: 'personal@example.test', displayName: 'Personal', provider: 'gmail', state: 'ready' }] }));
    if (url.pathname === '/api/v1/inbox') return Promise.resolve(Response.json({ messages: [{ id: 'inbox-only', account_id: accountId, sender: 'Inbox sender', subject: 'Inbox-only message', preview: 'INBOX PREVIEW IS NOT A BODY', received_at: '2026-10-01T12:00:00Z' }], nextCursor: null }));
    if (url.pathname === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [] }));
    if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
    if (url.pathname === '/api/v1/activities' || url.pathname.endsWith('/activities')) return Promise.resolve(Response.json(page()));
    if (url.pathname === '/api/v1/conversations') return Promise.resolve(Response.json({ conversations: [], nextCursor: null }));
    if (url.pathname.startsWith('/api/v1/conversations/') && url.pathname.endsWith('/messages')) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return Promise.resolve(Response.json({ conversation: { id, userId: 'owner', scope: 'mailbox', accountId, contextMessageId: null, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }, messages: [{ id: `chat-message-${id}`, conversationId: id, sequence: 1, role: 'assistant', content: `Conversation body ${id}`, requestId: null, replyTo: null, createdAt: '2026-10-01T00:00:00Z', turn: null }], nextCursor: null }));
    }
    // Unused agent/settings features fail independently of the navigation under test.
    return Promise.resolve(failure());
  }));
}
async function mount(path = '/'): Promise<void> {
  history.replaceState(null, '', path);
  entryLoad = import('../../src/browser.js'); await entryLoad;
  await ui().findByRole('region', { name: 'Workspace', hidden: true }, { timeout: 10_000 });
}
function applyHistory(path: string, state: unknown = null): void {
  act(() => { history.pushState(state, '', path); window.dispatchEvent(new PopStateEvent('popstate', { state })); });
}
async function traverseHistory(direction: 'back' | 'forward'): Promise<void> {
  await act(async () => {
    const changed = new Promise<void>(resolve => { window.addEventListener('popstate', () => { resolve(); }, { once: true }); });
    history[direction](); await changed;
  });
}
beforeEach(() => {
  vi.resetModules(); entryLoad = undefined;
  history.replaceState(null, '', '/');
  app = document.createElement('div'); app.id = 'app'; document.body.append(app);
});
afterEach(async () => {
  try { await entryLoad; } finally {
    try { act(() => { for (const root of roots.splice(0)) root.unmount(); }); }
    finally { app.remove(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); }
  }
}, browserTimeout);

describe('Activity detail navigation and recovery', () => {
  it('falls back to Inbox when root history refers to a message without a restorable selection', async () => {
    installFetch(() => undefined);
    await mount('/');
    applyHistory('/', { screen: 'message' });
    expect(primary().getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(await ui().findByText('Inbox-only message')).toBeTruthy();
  }, browserTimeout);

  it.each(['success', 'failure'] as const)('keeps B selected when an older A detail finishes with %s', async outcome => {
    const a = Promise.withResolvers<Response>(); let requestedA = false;
    installFetch(url => {
      if (url.pathname === '/api/v1/activities/A') { requestedA = true; return a.promise; }
      if (url.pathname === '/api/v1/activities/B') return Promise.resolve(detail(record('B')));
      return undefined;
    });
    await mount('/activity/A');
    await waitFor(() => { expect(requestedA).toBe(true); });
    applyHistory('/activity/B'); await activityDetail('B');
    await act(async () => { a.resolve(outcome === 'success' ? detail(record('A')) : failure()); await a.promise; });
    expect(ui().getByRole('article', { name: 'Activity detail: Work B' })).toBeTruthy();
    expect(ui().queryByRole('article', { name: 'Activity detail: Work A' })).toBeNull();
    expect(ui().queryByText('Could not load this activity.')).toBeNull();
    backToActivity();
    expect(ui().queryByText(/Could not load activity\./i)).toBeNull();
  }, browserTimeout);

  it('recovers a first-detail failure only after explicit retry', async () => {
    let attempts = 0;
    installFetch(url => url.pathname === '/api/v1/activities/retry' ? Promise.resolve(++attempts === 1 ? failure() : detail(record('retry'))) : undefined);
    await mount('/activity/retry');
    await ui().findByText('Could not load this activity.');
    expect(ui().queryByText('Loading Activity…')).toBeNull();
    fireEvent.click(ui().getByRole('button', { name: 'Try again' }));
    await activityDetail('retry');
    expect(ui().queryByText('Could not load this activity.')).toBeNull();
  }, browserTimeout);

  it('offers Activity back rather than an endless loader for an unavailable target', async () => {
    installFetch(url => url.pathname === '/api/v1/activities/gone' ? Promise.resolve(failure(404)) : undefined);
    await mount('/activity/gone'); await ui().findByText('This activity is unavailable.');
    expect(ui().queryByText('Loading Activity…')).toBeNull();
    backToActivity();
    expect(await ui().findByText('No new activity.')).toBeTruthy();
    expect(ui().queryByText('This activity is unavailable.')).toBeNull();
  }, browserTimeout);

  it.each([false, true])('opens a real notification target with failed-first-read=%s', async failFirst => {
    const id = 'notice with spaces'; let attempts = 0;
    installFetch(url => decodeURIComponent(url.pathname) === `/api/v1/activities/${id}` ? Promise.resolve(++attempts === 1 && failFirst ? failure() : detail(record(id))) : undefined);
    // The actual notification adapter chooses a destination; its browser client navigates there.
    await handleNotificationClick(id, { focusExisting: () => Promise.resolve(false), open: url => { history.replaceState(null, '', url); return Promise.resolve(); } }, location.origin);
    const destination = location.pathname;
    await mount(destination);
    if (failFirst) {
      await ui().findByText('Could not load this activity.');
      fireEvent.click(ui().getByRole('button', { name: 'Try again' }));
    }
    expect(await activityDetail(id)).toBeTruthy();
    expect(ui().getByText(`Completed ${id}`)).toBeTruthy();
  }, browserTimeout);

  it('applies canonical routes and root screen state while preserving the minimized Assistant', async () => {
    installFetch(url => url.pathname === '/api/v1/activities/route' ? Promise.resolve(detail(record('route'))) : undefined);
    await mount('/chat/thread');
    const dialog = within(await assistant());
    expect(await dialog.findByText('Conversation body thread')).toBeTruthy();
    const composer = dialog.getByRole('textbox', { name: 'Votre message' });
    fireEvent.change(composer, { target: { value: 'Keep this unsent text' } });
    applyHistory('/');
    expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    await waitFor(() => { expect(within(document.body).queryByRole('dialog', { name: 'Assistant' })).toBeNull(); });
    applyHistory('/activity'); expect(await ui().findByText('No new activity.')).toBeTruthy();
    applyHistory('/activity/route'); await activityDetail('route');
    fireEvent.click(ui().getByRole('button', { name: 'Open Assistant' }));
    applyHistory('/chat', history.state);
    const reopened = within(await assistant());
    expect(reopened.getByText('Conversation body thread')).toBeTruthy();
    expect(reopened.getByRole<HTMLTextAreaElement>('textbox', { name: 'Votre message' }).value).toBe('Keep this unsent text');
    applyHistory('/activity/route');
    await activityDetail('route');
    await waitFor(() => { expect(within(document.body).queryByRole('dialog', { name: 'Assistant' })).toBeNull(); });
    applyHistory('/', { screen: 'sent' }); expect(await ui().findByText('No sent messages.')).toBeTruthy();
    expect(primary().getByRole('button', { name: 'Sent' }).getAttribute('aria-current')).toBe('page');
    applyHistory('/', { screen: 'activity-detail' }); expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    applyHistory('/unknown'); expect(ui().getByRole('region', { name: 'Inbox' })).toBeTruthy();
  }, browserTimeout);

  it('keeps actual Back and Forward in sync after leaving an Activity deep link', async () => {
    installFetch(url => url.pathname === '/api/v1/activities/history' ? Promise.resolve(detail(record('history'))) : url.pathname === '/api/v1/activities' ? Promise.resolve(Response.json(page([record('history')]))) : undefined);
    await mount('/');
    fireEvent.click(primary().getByRole('button', { name: 'Activity' }));
    fireEvent.click(await ui().findByRole('button', { name: 'Open: Work history' })); await activityDetail('history');
    fireEvent.click(primary().getByRole('button', { name: 'Inbox' }));
    expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    await traverseHistory('back'); await activityDetail('history');
    await traverseHistory('back'); expect(await ui().findByRole('button', { name: 'Open: Work history' })).toBeTruthy();
    await traverseHistory('forward'); await activityDetail('history');
    await traverseHistory('forward'); expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    expect(ui().queryByRole('article', { name: 'Activity detail: Work history' })).toBeNull();
  }, browserTimeout);

  it('recovers an invalid encoded Activity link to Inbox', async () => {
    installFetch(() => undefined); await mount('/activity/%E0%A4%A');
    await ui().findByText('This link is invalid.');
    fireEvent.click(ui().getByRole('button', { name: 'Back to Inbox' }));
    expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    expect(ui().queryByText('This link is invalid.')).toBeNull();
    expect(await ui().findByRole('button', { name: 'Open message from Inbox sender: Inbox-only message' })).toBeTruthy();
  }, browserTimeout);

  it('opens a malformed chat link without crashing and retries its failed conversation load', async () => {
    let attempts = 0;
    const conversationPath = `/api/v1/conversations/${encodeURIComponent('%E0%A4%A')}/messages`;
    installFetch(url => url.pathname === conversationPath && ++attempts === 1 ? Promise.resolve(failure()) : undefined);
    await mount('/chat/%E0%A4%A');
    const dialog = within(await assistant());
    await dialog.findByRole('alert');
    expect(dialog.queryByRole('textbox', { name: 'Votre message' })).toBeNull();
    expect(attempts).toBe(1);
    fireEvent.click(dialog.getByRole('button', { name: 'Recharger la conversation' }));
    expect(await dialog.findByText('Conversation body %E0%A4%A')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(dialog.queryByRole('alert')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Minimize Assistant' }));
    expect(await ui().findByRole('region', { name: 'Inbox' })).toBeTruthy();
    await waitFor(() => { expect(within(document.body).queryByRole('dialog', { name: 'Assistant' })).toBeNull(); });
    expect(location.pathname).toBe('/');
    expect(await ui().findByRole('button', { name: 'Open message from Inbox sender: Inbox-only message' })).toBeTruthy();
  }, browserTimeout);

  it.each([503, 404])('loads an original outside Inbox and retries provider status %s without inventing a body', async status => {
    const body = Promise.withResolvers<Response>(); let reads = 0;
    installFetch(url => {
      if (url.pathname === '/api/v1/activities/original') return Promise.resolve(detail(record('original')));
      if (url.pathname === '/api/v1/messages/message-original') return ++reads === 1 ? body.promise : Promise.resolve(Response.json({ message: { body: 'ACTUAL COMPLETE ORIGINAL BODY', sender: 'Actual provider sender', senderAddress: 'provider@example.test', subject: 'Actual provider subject', attachments: [{ id: 'attachment', name: 'original.pdf', sizeBytes: 42 }] } }));
      return undefined;
    });
    await mount('/activity/original'); await activityDetail('original');
    fireEvent.click(ui().getByRole('button', { name: 'Open original message' }));
    const reader = within(await ui().findByRole('article', { name: 'Message detail' }));
    expect(reader.getByText('Loading full message…')).toBeTruthy();
    expect(reader.queryByText('INBOX PREVIEW IS NOT A BODY')).toBeNull();
    await act(async () => { body.resolve(failure(status)); await body.promise; });
    await reader.findByText(status === 404 ? 'This message no longer exists at the provider.' : 'The provider is unavailable. Retry to load the full message.');
    fireEvent.click(reader.getByRole('button', { name: 'Retry message' }));
    expect(await reader.findByText('ACTUAL COMPLETE ORIGINAL BODY')).toBeTruthy();
    expect(reader.getByText('Actual provider sender')).toBeTruthy();
    expect(reader.getByRole('heading', { name: 'Actual provider subject' })).toBeTruthy();
    expect(reader.getByRole('button', { name: 'Download attachment original.pdf' })).toBeTruthy();
  }, browserTimeout);
});

describe('Activity paging and acknowledged projections', () => {
  it('opens record 26 after a failed-more retry without duplicating the first 25', async () => {
    const items = Array.from({ length: 26 }, (_, index) => record(`page-${String(index + 1)}`)); let more = 0;
    const overlapping = items[24], last = items[25];
    if (!overlapping || !last) throw new Error('paging fixture must include records 25 and 26');
    installFetch(url => {
      if (url.pathname === '/api/v1/activities') return Promise.resolve(url.searchParams.has('cursor') ? ++more === 1 ? failure() : Response.json(page([overlapping, last])) : Response.json(page(items.slice(0, 25), 'opaque cursor/+=')));
      if (url.pathname === '/api/v1/activities/page-26') return Promise.resolve(detail(last));
      return undefined;
    });
    await mount('/activity'); await ui().findByRole('button', { name: 'Open: Work page-25' });
    expect(ui().queryByRole('button', { name: 'Open: Work page-26' })).toBeNull();
    fireEvent.click(activityList().getByRole('button', { name: 'Load more' }));
    await activityList().findByText('Could not load Activity.');
    expect(activityList().getByRole('button', { name: 'Open: Work page-1' })).toBeTruthy();
    fireEvent.click(activityList().getByRole('button', { name: 'Try again' }));
    fireEvent.click(await ui().findByRole('button', { name: 'Open: Work page-26' })); await activityDetail('page-26');
    backToActivity();
    for (const item of items) expect(activityList().getAllByRole('button', { name: `Open: ${item.title}`, exact: true })).toHaveLength(1);
    expect(activityList().queryByRole('button', { name: 'Load more' })).toBeNull();
  }, browserTimeout);

  it('discards a delayed old-filter page when Questions becomes current', async () => {
    const oldMore = Promise.withResolvers<Response>(); const question = { ...record('question', 'waiting_question'), question: { state: 'open' as const, prompt: 'Where should it go?' } };
    installFetch(url => {
      if (url.pathname !== '/api/v1/activities') return undefined;
      if (url.searchParams.get('filter') === 'questions') return Promise.resolve(Response.json(page([question])));
      return url.searchParams.has('cursor') ? oldMore.promise : Promise.resolve(Response.json(page([record('new')], 'next-new')));
    });
    await mount('/activity'); await ui().findByRole('button', { name: 'Open: Work new' });
    fireEvent.click(activityList().getByRole('button', { name: 'Load more' }));
    fireEvent.click(activityList().getByRole('button', { name: /^Questions/ }));
    await ui().findByRole('button', { name: 'Open: Work question' });
    await act(async () => { oldMore.resolve(Response.json(page([record('late-new')]))); await oldMore.promise; });
    expect(activityList().queryByRole('button', { name: 'Open: Work late-new' })).toBeNull();
    expect(activityList().queryByRole('button', { name: 'Open: Work new', exact: true })).toBeNull();
    expect(activityList().getByRole('button', { name: /^Questions/ }).getAttribute('aria-pressed')).toBe('true');
  }, browserTimeout);

  it.each([false, true])('removes acknowledged New work and refreshes counts, readback-fails=%s, without replaying the action', async failReadback => {
    let acknowledged = false, posts = 0, failed = false;
    const item = record('ack'); const completed = { ...item, state: 'acknowledged' as const, version: 2 };
    installFetch((url, init) => {
      if (url.pathname === '/api/v1/activities/ack/acknowledge' && init?.method === 'POST') { acknowledged = true; posts += 1; return Promise.resolve(detail(completed)); }
      if (url.pathname === '/api/v1/activities/ack') {
        if (acknowledged && failReadback && !failed) { failed = true; return Promise.resolve(failure()); }
        return Promise.resolve(detail(acknowledged ? completed : item));
      }
      if (url.pathname === '/api/v1/activities') return Promise.resolve(Response.json({ ...page(acknowledged ? [] : [item]), counts: { new: acknowledged ? 0 : 1, questions: 0, failed: 0, history: acknowledged ? 1 : 0 } }));
      return undefined;
    });
    await mount('/activity'); fireEvent.click(await ui().findByRole('button', { name: 'Open: Work ack' })); await activityDetail('ack');
    fireEvent.click(ui().getByRole('button', { name: 'Acknowledge', exact: true }));
    if (failReadback) {
      await ui().findByText('Could not refresh this activity.');
      expect(ui().getByRole('article', { name: 'Activity detail: Work ack' })).toBeTruthy();
      fireEvent.click(ui().getByRole('button', { name: 'Try again' }));
    }
    await within(await activityDetail('ack')).findByText('Acknowledged');
    backToActivity();
    await activityList().findByText('No new activity.');
    expect(activityList().queryByRole('button', { name: 'Open: Work ack' })).toBeNull();
    const filters = within(activityList().getByRole('group', { name: 'Activity filters' }));
    expect(within(filters.getByRole('button', { name: /^New/ })).getByLabelText('0 items')).toBeTruthy();
    expect(within(filters.getByRole('button', { name: /^History/ })).getByLabelText('1 items')).toBeTruthy();
    expect(posts).toBe(1);
  }, browserTimeout);
});
