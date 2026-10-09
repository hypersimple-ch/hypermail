// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendApprovalFlow, SendUiError, sendApprovalHttpApi } from '../../src/drafts/send-approval.js';
import type { PreparedSend, SendApprovalApi } from '../../src/drafts/send-approval.js';
import { DraftCompose } from '../../src/drafts/surfaces.js';
import type { DraftComposeProps } from '../../src/drafts/surfaces.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';
import { PendingSendReview } from '../../src/send-requests/surfaces.js';
import type { OwnerSendRequest } from '../../src/send-requests/contracts.js';
import { SessionExpiredError } from '../../src/lib/authenticated-fetch.js';
const target = { kind: 'draft' as const, id: 'draft-1', version: 1 };
const snapshot: PreparedSend['snapshot'] = { accountId: 'mailbox-1', recipients: [{ kind: 'to', address: 'to@example.com' }, { kind: 'bcc', address: 'hidden@example.com' }], subject: 'Exact subject', body: '<img src="https://remote.invalid/pixel">', bodyFormat: 'html' };
const prepared: PreparedSend = { approvalId: 'approval-1', expiresAt: '2099-01-01T00:00:00Z', snapshot };
function fixture() {
  return { prepare: vi.fn<SendApprovalApi['prepare']>().mockResolvedValue(prepared), confirm: vi.fn<SendApprovalApi['confirm']>().mockResolvedValue(), reauthenticate: vi.fn<SendApprovalApi['reauthenticate']>().mockResolvedValue(), reconcile: vi.fn<SendApprovalApi['reconcile']>().mockResolvedValue(), manualReview: vi.fn<SendApprovalApi['manualReview']>().mockResolvedValue() };
}
function requestFixture(id: string, state: OwnerSendRequest['state'] = 'pending_owner_approval'): OwnerSendRequest & { snapshot: DraftRecord } {
  return {
    id, accountId: snapshot.accountId, draftId: `draft-${id}`, draftVersion: 1, state,
    approvalId: null, actionId: null, providerMessageId: null, expiresAt: '2099-01-01T00:00:00Z',
    completedAt: null, reasonCode: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    snapshot: { ...snapshot, subject: `Subject ${id}`, id: `draft-${id}`, sourceMessageId: null, createdBy: 'agent', state: 'ready', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('owner send approval', () => {
  it.each(['FRESH_AUTH_REQUIRED', 'INVALID_PASSWORD'])('keeps a valid-session HTTP 401 as the send-local %s error', async (code) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/v1/session') return Promise.resolve(Response.json({ ownerEmail: 'owner@example.test', accounts: [] }));
      return Promise.resolve(Response.json({ error: { code } }, { status: 401 }));
    }));
    const operation = code === 'FRESH_AUTH_REQUIRED'
      ? sendApprovalHttpApi.confirm(target, prepared.approvalId, 'confirmation')
      : sendApprovalHttpApi.reauthenticate('wrong-password');
    await expect(operation).rejects.toMatchObject({ code, status: 401 });
  });
  it('never allows another confirmation or preparation after session expiry during a send', async () => {
    const user = userEvent.setup(); const api = fixture();
    api.confirm.mockRejectedValue(new SessionExpiredError());
    render(<SendApprovalFlow target={target} api={api} onRefresh={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm this exact send' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reload and review' }).disabled).toBe(false); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm this exact send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review and send' })).toBeNull();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);
  });
  it.each([new SessionExpiredError(), new SendUiError('INVALID_PASSWORD', 401)])('preserves the entered reauthentication password on failure (%s)', async (failure) => {
    const user = userEvent.setup(); const api = fixture();
    api.prepare.mockRejectedValueOnce(new SendUiError('FRESH_AUTH_REQUIRED', 401));
    api.reauthenticate.mockRejectedValue(failure);
    render(<SendApprovalFlow target={target} api={api} onRefresh={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.type(await screen.findByLabelText('Confirm your password'), 'keep-this-password');
    await user.click(screen.getByRole('button', { name: 'Authenticate and prepare again' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Authenticate and prepare again' }).disabled).toBe(false); });
    expect(screen.getByLabelText('Confirm your password').value).toBe('keep-this-password');
    expect(Boolean(screen.queryByRole('alert'))).toBe(!(failure instanceof SessionExpiredError));
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it('preserves composer text without a save conflict on session expiry', async () => {
    const user = userEvent.setup();
    const draft: DraftRecord = { ...snapshot, id: target.id, sourceMessageId: null, createdBy: 'user', state: 'editing', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const save = vi.fn<NonNullable<DraftComposeProps['onAutosave']>>().mockRejectedValue(new SessionExpiredError());
    render(<DraftCompose draft={draft} revisions={[]} onAutosave={save} onRefresh={vi.fn().mockResolvedValue(undefined)} />);
    await user.clear(screen.getByLabelText('Subject'));
    await user.type(screen.getByLabelText('Subject'), 'Keep this local edit');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Save draft' }).disabled).toBe(false); });
    expect(screen.getByLabelText('Subject').value).toBe('Keep this local edit');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload saved version and compare' })).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    { ...prepared, snapshot: null },
    { ...prepared, expiresAt: 'not-a-date' },
    { ...prepared, snapshot: { ...snapshot, recipients: [{ kind: 'to', address: 'invalid' }] } },
    { ...prepared, snapshot: { ...snapshot, bodyFormat: 'text' } },
  ])('refuses a malformed HTTP approval snapshot instead of allowing confirmation (%j)', async (approval: unknown) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ approval }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(sendApprovalHttpApi.prepare(target, 'confirmation')).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', status: 502 });
  });
  it('loads the saved draft for comparison without replacing local edits until explicitly discarded', async () => {
    const user = userEvent.setup();
    const draft: DraftRecord = { ...snapshot, id: target.id, sourceMessageId: null, createdBy: 'user', state: 'editing', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const refresh = vi.fn<NonNullable<DraftComposeProps['onRefresh']>>().mockResolvedValue();
    const view = render(<DraftCompose draft={draft} onRefresh={refresh} />);
    await user.clear(screen.getByLabelText('Subject'));
    await user.type(screen.getByLabelText('Subject'), 'Local unsaved subject');
    await user.click(screen.getByRole('button', { name: 'Load saved history' }));
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1); });
    const saved = { ...draft, version: 2, subject: 'Saved concurrent subject', body: 'Saved concurrent body' };
    view.rerender(<DraftCompose draft={saved} revisions={[{ draftId: saved.id, version: saved.version, editor: 'user', snapshot: saved, createdAt: saved.updatedAt }]} onRefresh={refresh} />);
    expect(screen.getByLabelText('Subject').value).toBe('Local unsaved subject');
    await user.click(screen.getByRole('button', { name: 'Saved version for comparison' }));
    expect(screen.getByText('Saved concurrent subject')).toBeTruthy();
    expect(screen.getByText('Saved concurrent body')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard local edits and use saved version' }));
    expect(screen.getByLabelText('Subject').value).toBe(saved.subject);
    expect(screen.getByLabelText('Message (html)').value).toBe(saved.body);
    expect(screen.queryByRole('button', { name: 'Saved version for comparison' })).toBeNull();
  });
  it('restarts preparation after fresh authentication and requires a second explicit confirmation of the new snapshot', async () => {
    const user = userEvent.setup(); const api = fixture();
    api.confirm.mockRejectedValueOnce(new SendUiError('FRESH_AUTH_REQUIRED', 401));
    api.prepare.mockResolvedValueOnce(prepared).mockResolvedValue({ ...prepared, approvalId: 'approval-2', snapshot: { ...snapshot, subject: 'New approved snapshot' } });
    render(<SendApprovalFlow target={target} api={api} onRefresh={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await screen.findByText('Exact subject');
    expect(screen.getByText('hidden@example.com')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirm this exact send' }));
    await user.type(await screen.findByLabelText('Confirm your password'), '  secret  ');
    await user.click(screen.getByRole('button', { name: 'Authenticate and prepare again' }));
    await screen.findByText('New approved snapshot');
    expect(api.reauthenticate).toHaveBeenCalledWith('  secret  ');
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.prepare.mock.calls[1]?.[1]).not.toBe(api.prepare.mock.calls[0]?.[1]);
    await user.click(screen.getByRole('button', { name: 'Confirm this exact send' }));
    await waitFor(() => { expect(api.confirm).toHaveBeenCalledTimes(2); });
    expect(api.confirm.mock.calls[1]?.[1]).toBe('approval-2');
  });
  it('never offers another send after an unreadable confirmation outcome and exposes read-only verification after refresh', async () => {
    const user = userEvent.setup(); const api = fixture(); api.confirm.mockRejectedValue(new Error('connection lost'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<SendApprovalFlow target={target} api={api} onRefresh={refresh} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm this exact send' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Review and send' })).toBeNull();
    view.rerender(<SendApprovalFlow target={target} api={api} onRefresh={refresh} submission={{ approvalId: 'approval-1', state: 'unknown', reasonCode: 'PROVIDER_SENT_ID_UNVERIFIABLE', manualReview: null, dispatchMayHaveOccurred: true }} />);
    await user.click(screen.getByRole('button', { name: 'Verify provider outcome' }));
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1); });
    await user.type(screen.getByLabelText('Manual review note'), 'Checked Sent myself');
    await user.click(screen.getByRole('button', { name: 'I observed it in Sent' }));
    await waitFor(() => { expect(api.manualReview).toHaveBeenCalledWith(target, 'approval-1', 'observed_sent', 'Checked Sent myself'); });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);
  });
  it('invalidates a prepared snapshot on conflict and requires reload before preparing again', async () => {
    const user = userEvent.setup(); const api = fixture(); api.confirm.mockRejectedValueOnce(new SendUiError('CONFLICT', 409));
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<SendApprovalFlow target={target} api={api} onRefresh={refresh} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm this exact send' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Review and send' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Confirm this exact send' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Review and send' }).disabled).toBe(false); });
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });
  it('preserves composer edits on conflict and submits the edited content rather than its original snapshot', async () => {
    const user = userEvent.setup();
    const draft: DraftRecord = { ...snapshot, id: target.id, sourceMessageId: null, createdBy: 'user', state: 'editing', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const save = vi.fn<NonNullable<DraftComposeProps['onAutosave']>>().mockRejectedValue(new Error('conflict'));
    const view = render(<DraftCompose draft={draft} revisions={[]} onAutosave={save} />);
    await user.clear(screen.getByLabelText('Subject')); await user.type(screen.getByLabelText('Subject'), 'Keep my edit');
    await user.clear(screen.getByLabelText('TO')); await user.type(screen.getByLabelText('TO'), 'first@example.com, second@example.com');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('alert');
    view.rerender(<DraftCompose draft={{ ...draft, version: 2, subject: 'Concurrent change' }} revisions={[]} onAutosave={save} />);
    expect(screen.getByLabelText('Subject').value).toBe('Keep my edit');
    expect(save.mock.calls[0]?.[0].subject).toBe('Keep my edit');
    expect(save.mock.calls[0]?.[0].recipients.filter(recipient => recipient.kind === 'to').map(recipient => recipient.address)).toEqual(['first@example.com', 'second@example.com']);
    expect(screen.getByRole('button', { name: 'Review and send' }).disabled).toBe(true);
  });
  it('requires a new explicit approval after provably undispatched expiry, without offering ambiguous-send verification', async () => {
    const user = userEvent.setup(); const api = fixture();
    render(<SendApprovalFlow target={{ ...target, version: 2 }} api={api} onRefresh={() => Promise.resolve()} submission={{ approvalId: 'expired-approval', state: 'rejected', reasonCode: 'APPROVAL_EXPIRED_UNDISPATCHED', dispatchMayHaveOccurred: false, manualReview: null }} />);
    expect(screen.queryByRole('button', { name: 'Verify provider outcome' })).toBeNull();
    expect(api.confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await screen.findByRole('button', { name: 'Confirm this exact send' });
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
  });
});

describe('approvals review surface', () => {
  it('separates actionable requests from rejected and uncertain outcomes without duplicating represented drafts', async () => {
    const user = userEvent.setup();
    const api = fixture();
    const firstPending = requestFixture('first');
    const secondPending = requestFixture('second');
    const pending = [firstPending, secondPending];
    const rejected = requestFixture('rejected', 'rejected');
    const unknownDraft: DraftRecord = {
      ...snapshot, id: 'unknown-draft', subject: 'Uncertain owner send', sourceMessageId: null,
      createdBy: 'user', state: 'sending', version: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      submission: { approvalId: 'unknown-approval', state: 'unknown', reasonCode: 'PROVIDER_SENT_ID_UNVERIFIABLE', manualReview: null, dispatchMayHaveOccurred: true },
    };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<PendingSendReview requests={[rejected, ...pending]} drafts={[firstPending.snapshot, unknownDraft]} onRefresh={refresh} api={api} />);
    const awaiting = within(screen.getByRole('region', { name: 'Awaiting approval' }));
    const outcomes = within(screen.getByRole('region', { name: 'Sending outcomes' }));
    expect(awaiting.getAllByRole('button', { name: 'Reject send request' })).toHaveLength(2);
    expect(awaiting.queryByRole('heading', { name: 'Subject rejected' })).toBeNull();
    expect(outcomes.getAllByRole('heading', { name: 'Subject rejected' })[0]).toBeTruthy();
    expect(outcomes.queryByRole('heading', { name: 'Subject first' })).toBeNull();
    expect(outcomes.getByRole('button', { name: 'Review and send' }).disabled).toBe(true);
    await user.click(outcomes.getByRole('button', { name: 'Verify provider outcome' }));
    await waitFor(() => { expect(api.reconcile).toHaveBeenCalledWith({ kind: 'draft', id: unknownDraft.id, version: 1 }, 'unknown-approval'); });
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })));
    const firstRejectButton = awaiting.getAllByRole('button', { name: 'Reject send request' })[0];
    if (!firstRejectButton) throw new Error('Expected a pending request rejection control');
    await user.click(firstRejectButton);
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2); });
    expect(fetch).toHaveBeenCalledWith('/api/v1/send-requests/first/reject', expect.objectContaining({ method: 'POST' }));
    view.rerender(<PendingSendReview requests={[rejected, { ...firstPending, state: 'rejected' }, secondPending]} drafts={[unknownDraft]} onRefresh={refresh} api={api} />);
    expect(within(screen.getByRole('region', { name: 'Awaiting approval' })).getAllByRole('button', { name: 'Reject send request' })).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'Sending outcomes' })).getAllByRole('heading', { name: 'Subject first' })[0]).toBeTruthy();
    view.rerender(<PendingSendReview requests={[]} drafts={[unknownDraft]} onRefresh={refresh} api={api} />);
    expect(screen.getByText('No requests need your approval.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify provider outcome' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review and send' })).toBeNull();
  });

  it('keeps loaded cards during pending refresh and a failure, then allows a successful retry', async () => {
    const user = userEvent.setup();
    let rejectRefresh: ((reason: Error) => void) | undefined;
    const refresh = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValue(undefined);
    render(<PendingSendReview requests={[requestFixture('loaded')]} onRefresh={refresh} api={fixture()} />);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' }).disabled).toBe(true);
    expect(screen.getAllByRole('heading', { name: 'Subject loaded' })[0]).toBeTruthy();
    vi.useFakeTimers();
    try {
      // Disabled buttons receive pointer events but no native click. Let their
      // queued fallback run only after the failed refresh enables the button.
      const disabled = screen.getByRole('button', { name: 'Refreshing…' });
      const pointer = { button: 0, pointerId: 1, pointerType: 'mouse', width: 1, height: 1, clientX: 0, clientY: 0 };
      fireEvent.pointerDown(disabled, pointer);
      fireEvent.pointerUp(disabled, pointer);
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (!rejectRefresh) throw new Error('Expected a pending refresh request');
        rejectRefresh(new Error('offline'));
        await Promise.resolve();
      });
      expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Could not refresh approvals. Try again.');
      expect(screen.getAllByRole('heading', { name: 'Subject loaded' })[0]).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toBeTruthy();
    } finally { vi.useRealTimers(); }
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(false);
  });

  it('invalidates a prepared request snapshot when its draft version changes and requires fresh review', async () => {
    const user = userEvent.setup();
    const api = fixture();
    const request = requestFixture('updated');
    api.prepare.mockResolvedValueOnce(prepared).mockResolvedValue({
      ...prepared, approvalId: 'approval-new-version', snapshot: { ...snapshot, subject: 'Updated request snapshot' },
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<PendingSendReview requests={[request]} onRefresh={refresh} api={api} />);
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await screen.findByRole('button', { name: 'Confirm this exact send' });
    view.rerender(<PendingSendReview requests={[{ ...request, draftVersion: 2 }]} onRefresh={refresh} api={api} />);
    expect(screen.queryByRole('button', { name: 'Confirm this exact send' })).toBeNull();
    expect(api.confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Review and send' }));
    await screen.findByText('Updated request snapshot');
    await user.click(screen.getByRole('button', { name: 'Confirm this exact send' }));
    await waitFor(() => {
      expect(api.confirm).toHaveBeenCalledWith(
        { kind: 'send_request', id: request.id, version: 2 }, 'approval-new-version', expect.any(String),
      );
    });
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps a request actionable after failed rejection without reporting a refreshed state', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PendingSendReview requests={[requestFixture('retry-rejection')]} onRefresh={refresh} api={fixture()} />);
    await user.click(screen.getByRole('button', { name: 'Reject send request' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent', 'Could not reject this request. Reload to check its current state.',
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reject send request' }).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Reject send request' }));
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a snapshot subject or an explicit fallback while retaining snapshot content and review actions', () => {
    const noSubject = requestFixture('empty');
    const noSnapshot: OwnerSendRequest = { ...requestFixture('missing') };
    const { snapshot: missingSnapshot, ...requestWithoutSnapshot } = noSnapshot;
    if (!missingSnapshot) throw new Error('Expected the request fixture to include a snapshot');
    render(<PendingSendReview requests={[{ ...noSubject, snapshot: { ...noSubject.snapshot, subject: '' } }, requestWithoutSnapshot]} onRefresh={vi.fn().mockResolvedValue(undefined)} api={fixture()} />);
    expect(screen.getAllByRole('heading', { name: '(No subject)' })[0]).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Draft draft-missing' })).toBeTruthy();
    expect(screen.getByText('hidden@example.com')).toBeTruthy();
    expect(screen.getByText(snapshot.body)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Review and send' })).toHaveLength(2);
  });
});
