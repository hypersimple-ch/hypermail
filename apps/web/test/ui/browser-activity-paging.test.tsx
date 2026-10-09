// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityPage, ActivityRecord } from '../../src/activity/contracts.js';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); roots.push(root); return root; } };
});
const timeout = 30_000;
const cursor = 'opaque+/= cursor?&';
const records: ActivityRecord[] = Array.from({ length: 26 }, (_, index) => ({ id: `activity-${String(index + 1)}`, accountId: 'mailbox', messageId: null, state: 'new', version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', title: `Work ${String(index + 1)}`, accountLabel: 'Mailbox', messageLabel: 'Message', timeline: [] }));
function recordAt(index: number): ActivityRecord {
  const record = records[index];
  if (!record) throw new Error(`activity fixture is missing index ${String(index)}`);
  return record;
}
const counts = { new: 26, questions: 0, failed: 1, history: 0 };
const page = (items: readonly ActivityRecord[], nextCursor: string | null = null): Response => Response.json({ items, nextCursor, counts } satisfies ActivityPage);
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
let featureRequests: string[];
function fixture(activityResponse: (url: URL) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.pathname === '/api/v1/activities') return activityResponse(url);
    if (url.pathname.startsWith('/api/v1/activities/')) return Promise.resolve(Response.json({ activity: records[25] }));
    featureRequests.push(url.pathname);
    if (url.pathname === '/api/v1/session') return Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [] }));
    if (url.pathname === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [] }));
    if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
    if (url.pathname.startsWith('/api/v1/agent')) return Promise.resolve(new Response(null, { status: 503 }));
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
}
async function openActivity(): Promise<void> {
  entryLoad = import('../../src/browser.js'); await entryLoad;
  await waitFor(() => { expect(within(app).getAllByRole('button', { name: 'Activity' }).length).toBeGreaterThan(0); }, { timeout: 10_000 });
  fireEvent.click(within(app).getAllByRole('button', { name: 'Activity' })[0] as HTMLElement);
  await within(app).findByRole('button', { name: 'Open: Work 1' });
}
const selectFailed = (): void => { fireEvent.click(within(within(app).getByRole('group', { name: 'Activity filters' })).getByRole('button', { name: /^Failed/ })); };
beforeEach(() => { vi.resetModules(); entryLoad = undefined; featureRequests = []; history.replaceState(null, '', '/'); app = document.createElement('div'); app.id = 'app'; document.body.append(app); });
afterEach(async () => { try { await entryLoad; } finally { act(() => { for (const root of roots.splice(0)) root.unmount(); }); app.remove(); vi.unstubAllGlobals(); } }, timeout);

describe('browser Activity paging', () => {
  it('reaches and opens record 26, preserves server order and counts, and deduplicates overlapping pages', async () => {
    const requests: URL[] = [];
    const more = Promise.withResolvers<Response>();
    fixture(url => { requests.push(url); return url.searchParams.has('cursor') ? more.promise : Promise.resolve(page(records.slice(0, 25), cursor)); });
    await openActivity();
    expect(within(app).queryByRole('button', { name: 'Open: Work 26' })).toBeNull();
    expect(requests[0]?.searchParams.get('filter')).toBe('new');
    expect(requests[0]?.searchParams.get('limit')).toBe('25');
    fireEvent.click(within(app).getByRole('button', { name: 'Load more' }));
    const pending = within(app).getByRole('button', { name: 'Loading…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(requests.length).toBe(2);
    expect(requests[1]?.searchParams.get('cursor')).toBe(cursor);
    expect(requests[1]?.search).toContain(`cursor=${encodeURIComponent(cursor)}`);
    expect(requests[1]?.searchParams.get('limit')).toBe('25');
    await act(() => { more.resolve(page([recordAt(24), recordAt(25)])); return more.promise; });
    const buttons = within(app).getAllByRole('button', { name: /^Open: Work/ });
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(records.map(record => `Open: ${record.title}`));
    expect(within(within(app).getByRole('group', { name: 'Activity filters' })).getByRole('button', { name: /^New/ }).textContent).toContain('26');
    expect(within(app).queryByRole('button', { name: 'Load more' })).toBeNull();
    fireEvent.click(within(app).getByRole('button', { name: 'Open: Work 26' }));
    expect(await within(app).findByRole('article', { name: 'Activity detail: Work 26' })).toBeTruthy();
  }, timeout);

  it('retains rows and cursor after a failed more request and retries without duplicates', async () => {
    let moreRequests = 0;
    fixture(url => url.searchParams.has('cursor') ? Promise.resolve(++moreRequests === 1 ? new Response(null, { status: 503 }) : page([recordAt(24), recordAt(25)])) : Promise.resolve(page(records.slice(0, 25), cursor)));
    await openActivity();
    fireEvent.click(within(app).getByRole('button', { name: 'Load more' }));
    await within(app).findByText('Could not load Activity.');
    expect(within(app).getAllByRole('button', { name: /^Open: Work/ }).length).toBe(25);
    fireEvent.click(within(app).getByRole('button', { name: 'Try again' }));
    await within(app).findByRole('button', { name: 'Open: Work 26' });
    expect(moreRequests).toBe(2);
    expect(within(app).getAllByRole('button', { name: /^Open: Work/ }).length).toBe(26);
    expect(within(app).queryByText('Could not load Activity.')).toBeNull();
  }, timeout);

  it.each([false, true])('fences a late old-filter page (failure=%s) without reloading other features', async fail => {
    const oldMore = Promise.withResolvers<Response>();
    const failed = { ...recordAt(0), id: 'failed-work', title: 'Current failure', state: 'failed' as const };
    fixture(url => url.searchParams.has('cursor') ? oldMore.promise : Promise.resolve(url.searchParams.get('filter') === 'failed' ? page([failed]) : page(records.slice(0, 25), cursor)));
    await openActivity();
    const before = [...featureRequests];
    fireEvent.click(within(app).getByRole('button', { name: 'Load more' }));
    selectFailed();
    await within(app).findByRole('button', { name: 'Open: Current failure' });
    await act(() => { oldMore.resolve(fail ? new Response(null, { status: 503 }) : page([recordAt(25)])); return oldMore.promise; });
    expect(within(app).getByRole('button', { name: 'Open: Current failure' })).toBeTruthy();
    expect(within(app).queryByRole('button', { name: /^Open: Work/ })).toBeNull();
    expect(within(app).queryByText('Could not load Activity.')).toBeNull();
    expect(within(app).queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(featureRequests).toEqual(before);
  }, timeout);

  it('never presents old-filter rows or cursor after a filter load fails', async () => {
    const failed = Promise.withResolvers<Response>();
    const failedRequests: URL[] = [];
    fixture(url => {
      if (url.searchParams.get('filter') !== 'failed') return Promise.resolve(page(records.slice(0, 25), cursor));
      failedRequests.push(url);
      return failedRequests.length === 1 ? failed.promise : Promise.resolve(page([]));
    });
    await openActivity();
    selectFailed();
    expect(within(app).queryByRole('button', { name: /^Open: Work/ })).toBeNull();
    expect(within(app).queryByRole('button', { name: 'Load more' })).toBeNull();
    await act(() => { failed.resolve(new Response(null, { status: 503 })); return failed.promise; });
    await within(app).findByText('Could not load Activity.');
    expect(within(app).queryByRole('button', { name: /^Open: Work/ })).toBeNull();
    expect(within(app).queryByRole('button', { name: 'Load more' })).toBeNull();
    fireEvent.click(within(app).getByRole('button', { name: 'Try again' }));
    await within(app).findByText('No failed activity.');
    expect(failedRequests.length).toBe(2);
    expect(failedRequests[1]?.searchParams.get('limit')).toBe('25');
    expect(failedRequests[1]?.searchParams.has('cursor')).toBe(false);
  }, timeout);
});
