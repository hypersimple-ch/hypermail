// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Root } from 'react-dom/client';
import type * as ReactDomModule from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRecord, DraftRevision } from '../../src/drafts/contracts.js';
import type { ActivityPage } from '../../src/activity/contracts.js';

const roots = vi.hoisted(() => [] as Root[]);
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); roots.push(root); return root; } };
});
const timeout = 30_000;
const accountId = '11111111-1111-4111-8111-111111111111';
const draft: DraftRecord = { id: 'draft-one', accountId, sourceMessageId: null, createdBy: 'user', state: 'editing', version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Saved subject', body: 'Original body', bodyFormat: 'markdown' };
const revision = (record: DraftRecord): DraftRevision => ({ draftId: record.id, version: record.version, editor: 'user', snapshot: { recipients: record.recipients, subject: record.subject, body: record.body, bodyFormat: record.bodyFormat }, createdAt: record.updatedAt });
const activity = (title: string): ActivityPage => ({ items: [{ id: title, accountId, messageId: null, state: 'acknowledged', version: 1, createdAt: draft.createdAt, updatedAt: draft.updatedAt, title, accountLabel: 'Mailbox', messageLabel: 'Message', timeline: [] }], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 1 } });
let app: HTMLDivElement;
let entryLoad: Promise<unknown> | undefined;
function fixture(resource: (url: URL, init?: RequestInit) => Promise<Response> | undefined): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    const response = resource(url, init); if (response) return response;
    if (url.pathname === '/api/v1/session') return Promise.resolve(Response.json({ user: { id: 'owner', email: 'owner@example.test' }, accounts: [{ id: accountId, email: 'mail@example.test', displayName: 'Mailbox', provider: 'gmail', state: 'ready' }] }));
    if (url.pathname === '/api/v1/inbox') return Promise.resolve(Response.json({ messages: [], nextCursor: null }));
    if (url.pathname === '/api/v1/activities') return Promise.resolve(Response.json(activity('Initial activity')));
    if (url.pathname === '/api/v1/drafts') return Promise.resolve(Response.json({ drafts: [draft] }));
    if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [] }));
    if (url.pathname.startsWith('/api/v1/agent')) return Promise.resolve(new Response(null, { status: 503 }));
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
}
const navigate = (name: string): void => { fireEvent.click(within(app).getAllByRole('button', { name })[0] as HTMLElement); };
beforeEach(() => { vi.resetModules(); entryLoad = undefined; history.replaceState(null, '', '/'); app = document.createElement('div'); app.id = 'app'; document.body.append(app); });
afterEach(async () => {
  try { await entryLoad; } finally { act(() => { for (const root of roots.splice(0)) root.unmount(); }); app.remove(); vi.unstubAllGlobals(); }
}, timeout);

describe('browser resource generations', () => {
  it('retains a folder failure when an independent delayed dashboard succeeds', async () => {
    const dashboard = Promise.withResolvers<Response>();
    fixture(url => url.pathname === '/api/v1/agent' ? dashboard.promise : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await within(app).findByRole('region', { name: 'Inbox' }, { timeout: 10_000 });
    navigate('Activity');
    await within(app).findByText('Could not refresh agent folders. Existing input has been kept.');
    await act(async () => {
      dashboard.resolve(Response.json({ dashboard: { actions: [], questions: [], alerts: [], proposals: [], autonomy: { global: { state: 'running', version: 1 }, accounts: {} } } }));
      await dashboard.promise;
    });
    expect(within(app).getByText('Could not refresh agent folders. Existing input has been kept.')).toBeTruthy();
  }, timeout);

  it('treats drafts and send requests as one retryable projection', async () => {
    let requests = 0;
    fixture(url => url.pathname === '/api/v1/send-requests' ? Promise.resolve(++requests === 1 ? new Response(null, { status: 503 }) : Response.json({ requests: [] })) : undefined);
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await waitFor(() => { expect(requests).toBe(1); }, { timeout: 10_000 });
    navigate('Drafts');
    expect(await within(app).findByText('Could not refresh sending state.')).toBeTruthy();
    expect(within(app).queryByRole('button', { name: 'Open draft Saved subject' })).toBeNull();
    expect(within(app).queryByText('No drafts yet.')).toBeNull();
    fireEvent.click(within(app).getByRole('button', { name: 'Try again' }));
    expect(await within(app).findByRole('button', { name: 'Open draft Saved subject' })).toBeTruthy();
    expect(within(app).queryByText('Could not refresh sending state.')).toBeNull();
  }, timeout);

  it.each([false, true])('keeps newer Activity after an old response fails=%s', async fail => {
    const old = Promise.withResolvers<Response>();
    let historyRequested = false;
    fixture(url => {
      if (url.pathname === '/api/v1/activities' && url.searchParams.get('filter') === 'history') { historyRequested = true; return old.promise; }
      return url.pathname === '/api/v1/activities' && url.searchParams.get('filter') === 'failed' ? Promise.resolve(Response.json(activity('Current failed activity'))) : undefined;
    });
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await waitFor(() => { expect(within(app).getAllByRole('button', { name: 'Activity' }).length).toBeGreaterThan(0); }, { timeout: 10_000 });
    navigate('Activity');
    await within(app).findByText('Initial activity');
    const filters = within(within(app).getByRole('group', { name: 'Activity filters' }));
    fireEvent.click(filters.getByRole('button', { name: /^History/ }));
    await waitFor(() => { expect(historyRequested).toBe(true); });
    fireEvent.click(filters.getByRole('button', { name: /^Failed/ }));
    await within(app).findByText('Current failed activity');
    await act(() => { old.resolve(fail ? new Response(null, { status: 503 }) : Response.json(activity('Stale history activity'))); return old.promise; });
    expect(within(app).getByText('Current failed activity')).toBeTruthy();
    expect(within(app).queryByText('Stale history activity')).toBeNull();
    expect(within(app).queryByText('Could not load Activity.')).toBeNull();
  }, timeout);

  it.each([false, true])('does not let old collections or draft history downgrade a saved edit, old collection fails=%s', async fail => {
    const oldCollection = Promise.withResolvers<Response>(), oldDetail = Promise.withResolvers<Response>(), oldHistory = Promise.withResolvers<Response>();
    let collectionReads = 0, detailReads = 0, historyReads = 0;
    const saved = { ...draft, version: 2, body: 'My saved edit' };
    fixture((url, init) => {
      if (url.pathname === '/api/v1/drafts') return ++collectionReads === 2 ? oldCollection.promise : Promise.resolve(Response.json({ drafts: [draft] }));
      if (url.pathname === '/api/v1/send-requests') return Promise.resolve(Response.json({ requests: [{ id: 'request-one', accountId, draftId: draft.id, draftVersion: 1, state: 'pending_owner_approval', approvalId: null, actionId: null, providerMessageId: null, expiresAt: '2099-01-01T00:00:00Z', completedAt: null, reasonCode: null, createdAt: draft.createdAt, updatedAt: draft.updatedAt }] }));
      if (url.pathname === '/api/v1/send-requests/request-one/reject') return Promise.resolve(Response.json({}));
      if (url.pathname === `/api/v1/drafts/${draft.id}`) {
        if (init?.method === 'POST') return Promise.resolve(Response.json({ draft: saved }));
        return ++detailReads === 1 ? oldDetail.promise : Promise.resolve(Response.json({ draft: saved }));
      }
      if (url.pathname === `/api/v1/drafts/${draft.id}/history`) return ++historyReads === 1 ? oldHistory.promise : Promise.resolve(Response.json({ revisions: [revision(draft), revision(saved)] }));
      return undefined;
    });
    entryLoad = import('../../src/browser.js'); await entryLoad;
    await waitFor(() => { expect(collectionReads).toBe(1); }, { timeout: 10_000 });
    navigate('More');
    fireEvent.click(within(app).getByRole('button', { name: /^Pending sends/ }));
    fireEvent.click(await within(app).findByRole('button', { name: 'Reject send request' }));
    await waitFor(() => { expect(collectionReads).toBe(2); });
    navigate('Drafts');
    fireEvent.click(await within(app).findByRole('button', { name: 'Open draft Saved subject' }));
    await waitFor(() => { expect(detailReads).toBe(1); expect(historyReads).toBe(1); });
    fireEvent.change(within(app).getByLabelText('Message (markdown)'), { target: { value: 'My saved edit' } });
    fireEvent.click(within(app).getByRole('button', { name: 'Save draft' }));
    await within(app).findByText('Version 2 · User-created draft');
    await within(app).findByText('2 saved versions');
    await act(() => {
      oldCollection.resolve(fail ? new Response(null, { status: 503 }) : Response.json({ drafts: [draft] }));
      oldDetail.resolve(Response.json({ draft })); oldHistory.resolve(Response.json({ revisions: [revision(draft)] }));
      return Promise.all([oldCollection.promise, oldDetail.promise, oldHistory.promise]);
    });
    expect(within(app).getByText('Version 2 · User-created draft')).toBeTruthy();
    expect(within(app).getByText('2 saved versions')).toBeTruthy();
    expect(within(app).getByLabelText<HTMLTextAreaElement>('Message (markdown)').value).toBe('My saved edit');
    expect(within(app).queryByText('Could not refresh sending state.')).toBeNull();
  }, timeout);
});
