// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent, type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@hypermail/contracts';
import { HypermailShell, type ShellData } from '../../src/ui/index.js';
import type { OwnerSendRequest } from '../../src/send-requests/contracts.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';
import type { ActivityRecord } from '../../src/activity/contracts.js';
import { ToastProvider, toast } from '../../src/components/heroui/toast.js';

const accountId = '33333333-3333-4333-8333-333333333333';
const otherAccountId = '99999999-9999-4999-8999-999999999999';
const conversation: Conversation = { id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', scope: 'mailbox', accountId, contextMessageId: null, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const mail = { id: '88888888-8888-4888-8888-888888888888', accountId, sender: 'Alex', initials: 'A', subject: 'Reader background', preview: 'An exact message', received: 'Today', body: 'Full original message' };
const activity: ActivityRecord = { id: 'activity-background', accountId, messageId: mail.id, state: 'waiting_question', version: 1, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, title: 'Activity background', accountLabel: 'Personal', messageLabel: mail.subject, timeline: [], question: { id: 'question-background', version: 1, prompt: 'Which action should I take?', state: 'open' } };
const data: ShellData = { accounts: [{ id: accountId, label: 'Personal', address: 'mail@example.test' }, { id: otherAccountId, label: 'Work', address: 'work@example.test' }], selectedAccountId: accountId, messages: [mail], activity: { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } } };
const draft: DraftRecord = { id: 'unknown-draft', accountId, sourceMessageId: null, createdBy: 'user', recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Uncertain owner send', body: 'Do not resend this', bodyFormat: 'markdown', state: 'sending', version: 1, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, submission: { approvalId: 'unknown-approval', state: 'unknown', reasonCode: 'PROVIDER_SENT_ID_UNVERIFIABLE', manualReview: null, dispatchMayHaveOccurred: true } };
function request(id: string, state: OwnerSendRequest['state'] = 'pending_owner_approval', mailbox = accountId): OwnerSendRequest {
  return { id, accountId: mailbox, draftId: `draft-${id}`, draftVersion: 1, state, approvalId: null, actionId: null, providerMessageId: null, expiresAt: '2099-01-01T00:00:00Z', completedAt: null, reasonCode: null, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, snapshot: { ...draft, id: `draft-${id}`, accountId: mailbox, createdBy: 'agent', subject: `Subject ${id}`, state: 'ready', submission: null } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function httpFixture(overrides?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const overridden = overrides?.(url, init);
    if (overridden !== undefined) return await overridden;
    if (url.startsWith('/api/v1/conversations?')) return json({ conversations: [], nextCursor: null });
    if (url === '/api/v1/conversations' && init?.method === 'POST') return json({ conversation });
    if (url === `/api/v1/conversations/${conversation.id}/messages`) return json({ conversation, messages: [], nextCursor: null });
    if (url === `/api/v1/messages/${mail.id}/activities`) return json({ items: [] });
    throw new Error(`Unexpected shell fixture request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function mount(props: Partial<React.ComponentProps<typeof HypermailShell>> = {}) {
  return render(<><HypermailShell data={data} ownerEmail="owner@example.test" {...props} /><ToastProvider /></>);
}
const primary = () => {
  const navigation = screen.getAllByRole('navigation', { name: 'Primary' })[0];
  if (!navigation) throw new Error('Primary navigation missing');
  return within(navigation);
};
const ownerTrigger = () => {
  const trigger = screen.getAllByRole('button', { name: 'Account and settings' })[0];
  if (!trigger) throw new Error('Owner trigger missing');
  return trigger;
};
async function openOwner(user: UserEvent) {
  ownerTrigger().focus();
  await user.keyboard('{ArrowDown}');
  return within(await screen.findByRole('menu'));
}

beforeEach(() => { history.replaceState(null, '', '/'); httpFixture(); });
afterEach(() => { toast.clear(); cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

describe('shell owner navigation', () => {
  it.each(['Mailboxes & agents', 'Account & security'])('opens %s from a keyboard owner menu and returns to Inbox', async title => {
    const user = userEvent.setup(); mount();
    const menu = await openOwner(user);
    const item = menu.getByRole('menuitem', { name: new RegExp(title) });
    item.focus(); await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: title });
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to inbox' }));
    expect(screen.getByRole('region', { name: 'Inbox' })).toBeTruthy();
    expect(primary().getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  });

  it('dismisses the owner menu with Escape and returns keyboard focus', async () => {
    const user = userEvent.setup(); mount();
    await openOwner(user); await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(ownerTrigger()); });
  });

  it('allows only one sign-out while pending and permits retry after rejection', async () => {
    const user = userEvent.setup(); const pending = Promise.withResolvers<undefined>();
    const onSignOut = vi.fn<() => Promise<void>>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    mount({ onSignOut });
    await user.click((await openOwner(user)).getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    if (!screen.queryByRole('menu')) await openOwner(user);
    const signingOut = await screen.findByRole('menuitem', { name: 'Signing out…' });
    expect(signingOut.getAttribute('aria-disabled')).toBe('true');
    await user.click(signingOut); expect(onSignOut).toHaveBeenCalledTimes(1);
    await act(async () => { pending.reject(new Error('offline')); await pending.promise.catch(() => undefined); });
    await screen.findByText('Could not sign out. Try again.');
    if (!screen.queryByRole('menu')) await openOwner(user);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => { expect(onSignOut).toHaveBeenCalledTimes(2); });
  });
});

describe('Approvals navigation and counts', () => {
  it('counts pending requests across mailboxes and updates after a rejection refresh without hiding sending outcomes', async () => {
    const user = userEvent.setup(); const requests = [request('first'), request('second', 'pending_owner_approval', otherAccountId), request('rejected', 'rejected')];
    const rejected = vi.fn();
    httpFixture((url, init) => { if (url === '/api/v1/send-requests/first/reject' && init?.method === 'POST') { rejected(); return json({}); } return undefined; });
    function LoadedShell() {
      const [loaded, setLoaded] = React.useState(requests);
      return <HypermailShell data={data} sendRequests={loaded} drafts={[draft]} onRefreshSendRequests={() => { setLoaded(current => current.map(item => item.id === 'first' ? { ...item, state: 'rejected' } : item)); return Promise.resolve(); }} />;
    }
    render(<LoadedShell />);
    expect(primary().getByLabelText('2 pending approvals')).toBeTruthy();
    await user.click(primary().getByRole('button', { name: /Approvals/ }));
    expect(primary().getByRole('button', { name: /Approvals/ }).getAttribute('aria-current')).toBe('page');
    expect(primary().getByRole('button', { name: 'Activity' }).getAttribute('aria-current')).not.toBe('page');
    const awaiting = within(screen.getByRole('region', { name: 'Awaiting approval' }));
    expect(awaiting.getAllByRole('button', { name: 'Reject send request' })).toHaveLength(2);
    const outcomes = within(screen.getByRole('region', { name: 'Sending outcomes' }));
    expect(within(outcomes.getByRole('region', { name: 'Exact send snapshot' })).getByRole('heading', { name: 'Subject rejected' })).toBeTruthy();
    expect(outcomes.getByText('Uncertain owner send')).toBeTruthy();
    expect(outcomes.getByRole('button', { name: 'Verify provider outcome' })).toBeTruthy();
    expect(outcomes.queryByRole('button', { name: 'Confirm this exact send' })).toBeNull();
    const reject = awaiting.getAllByRole('button', { name: 'Reject send request' })[0];
    if (!reject) throw new Error('Pending approval missing rejection action');
    await user.click(reject);
    await waitFor(() => { expect(primary().getByLabelText('1 pending approvals')).toBeTruthy(); });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('region', { name: 'Sending outcomes' })).getAllByText('Subject first')[0]?.textContent).toBe('Subject first');
  });

  it('keeps unknown outcomes visible at zero approvals and never offers an automatic resend', async () => {
    const user = userEvent.setup(); mount({ drafts: [draft], onRefreshSendRequests: () => Promise.resolve() });
    expect(primary().queryByLabelText(/pending approvals/)).toBeNull();
    await user.click(primary().getByRole('button', { name: 'Approvals' }));
    expect(screen.getByText('No requests need your approval.')).toBeTruthy();
    const outcomes = within(screen.getByRole('region', { name: 'Sending outcomes' }));
    expect(outcomes.getByText('Uncertain owner send')).toBeTruthy();
    expect(outcomes.getByRole('button', { name: 'Verify provider outcome' }).disabled).toBe(false);
    expect(outcomes.queryByRole('button', { name: /Review and send|Confirm this exact send|Resend/ })).toBeNull();
  });

  it.each(['loading', 'error'] as const)('does not advertise a loaded approval count during %s', sendingState => {
    mount({ sendingState, sendRequests: [request('first')], onRefreshSendRequests: () => Promise.resolve() });
    expect(primary().queryByLabelText(/pending approvals/)).toBeNull();
    expect(primary().getByRole('button', { name: 'Approvals' })).toBeTruthy();
  });

  it('distinguishes unavailable approvals from an empty loaded review', async () => {
    const user = userEvent.setup(); mount({ sendRequests: [request('first')] });
    expect(primary().queryByLabelText(/pending approvals/)).toBeNull();
    await user.click(primary().getByRole('button', { name: 'Approvals' }));
    expect(screen.getByText('Approvals are unavailable.')).toBeTruthy();
    expect(screen.queryByText('No requests need your approval.')).toBeNull();
  });

  it('keeps last-loaded approvals on refresh failure and allows an explicit retry', async () => {
    const user = userEvent.setup(); const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    mount({ sendRequests: [request('first')], onRefreshSendRequests: refresh });
    await user.click(primary().getByRole('button', { name: /Approvals/ }));
    const approvals = within(screen.getByRole('region', { name: 'Approvals' }));
    await user.click(approvals.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Could not refresh approvals. Try again.');
    expect(within(approvals.getByRole('region', { name: 'Exact send snapshot' })).getByRole('heading', { name: 'Subject first' })).toBeTruthy();
    expect(primary().getByLabelText('1 pending approvals')).toBeTruthy();
    await user.click(approvals.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2); expect(screen.queryByText('Could not refresh approvals. Try again.')).toBeNull(); });
  });
});

describe('Assistant shell history', () => {
  it('opens a direct conversation URL once and minimizes to Inbox without leaving the app', async () => {
    const user = userEvent.setup(); const fetcher = httpFixture(); history.replaceState(null, '', `/chat/${conversation.id}`);
    mount();
    await screen.findByRole('dialog', { name: 'Assistant' });
    await screen.findByLabelText('Votre message');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByRole('region', { name: 'Inbox' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await screen.findByLabelText('Votre message');
    expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/conversations/${conversation.id}/messages`)).toHaveLength(1);
  });

  it('restores the exact Reader on Back and reopens the same conversation and unsent text on Forward', async () => {
    const user = userEvent.setup(); const fetcher = httpFixture(); mount({ onOpenMessage: () => Promise.resolve(mail) });
    await user.click(screen.getByRole('button', { name: `Open message from ${mail.sender}: ${mail.subject}` }));
    await user.click(await screen.findByRole('button', { name: 'Discuss this mail' }));
    await screen.findByRole('dialog', { name: 'Assistant' });
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await user.type(await screen.findByLabelText('Votre message'), 'Preserve this unsent question');
    await waitFor(() => { expect(location.pathname).toBe(`/chat/${conversation.id}`); });
    act(() => { history.back(); });
    await waitFor(() => { expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(within(screen.getByRole('article', { name: 'Message detail' })).getByText(mail.body)).toBeTruthy();
    act(() => { history.forward(); });
    await screen.findByRole('dialog', { name: 'Assistant' });
    expect((await screen.findByLabelText('Votre message')).value).toBe('Preserve this unsent question');
    expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/conversations/${conversation.id}/messages`)).toHaveLength(1);
  });

  it('restores Compose, its history route, and its unsaved subject after leaving Activity', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', `/activity/${activity.id}`);
    httpFixture(url => url === `/api/v1/activities/${activity.id}` ? json({ activity }) : undefined);
    mount();
    await screen.findByRole('article', { name: `Activity detail: ${activity.title}` });
    const composeAction = screen.getAllByRole('button', { name: 'Compose' })[0];
    if (!composeAction) throw new Error('Compose action missing');
    await user.click(composeAction);
    await user.type(screen.getByLabelText('Subject'), 'Keep the unsaved Compose subject');
    expect(location.pathname).toBe('/'); expect(history.state).toMatchObject({ screen: 'compose' });
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await screen.findByRole('dialog', { name: 'Assistant' });
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(location.pathname).toBe('/'); expect(history.state).toMatchObject({ screen: 'compose' }); expect(screen.queryByRole('dialog')).toBeNull(); });
    const compose = within(screen.getByRole('region', { name: 'Compose message' }));
    expect(compose.getByLabelText('Subject').value).toBe('Keep the unsaved Compose subject');
    expect(screen.queryByRole('article', { name: `Activity detail: ${activity.title}` })).toBeNull();
  });

  it('returns to the same Activity detail and preserves an unsubmitted answer after Assistant Back', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', `/activity/${activity.id}`);
    httpFixture(url => url === `/api/v1/activities/${activity.id}` ? json({ activity }) : undefined);
    mount();
    const detail = await screen.findByRole('article', { name: `Activity detail: ${activity.title}` });
    await user.type(within(detail).getByLabelText('Your answer'), 'Keep this unsubmitted activity answer');
    await user.click(within(detail).getByRole('button', { name: 'Discuss this mail' }));
    await screen.findByRole('dialog', { name: 'Assistant' });
    act(() => { history.back(); });
    await waitFor(() => { expect(location.pathname).toBe(`/activity/${activity.id}`); expect(screen.queryByRole('dialog')).toBeNull(); });
    const restored = within(screen.getByRole('article', { name: `Activity detail: ${activity.title}` }));
    expect(restored.getByLabelText('Your answer').value).toBe('Keep this unsubmitted activity answer');
  });

  it('remembers asynchronous conversation creation while minimized without changing the non-chat URL or reopening', async () => {
    const user = userEvent.setup(); const created = Promise.withResolvers<Response>();
    httpFixture((url, init) => url === '/api/v1/conversations' && init?.method === 'POST' ? created.promise : undefined);
    mount(); await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull(); });
    await act(async () => { created.resolve(json({ conversation })); await created.promise; });
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Open Assistant' }).getAttribute('aria-expanded')).toBe('false'); });
    expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await screen.findByLabelText('Votre message');
    expect(location.pathname).toBe(`/chat/${conversation.id}`);
  });

  it('keeps an in-flight message completion while minimized and shows it exactly once on reopen', async () => {
    const user = userEvent.setup(); const posted = Promise.withResolvers<Response>();
    const fetcher = httpFixture((url, init) => url === `/api/v1/conversations/${conversation.id}/messages` && init?.method === 'POST' ? posted.promise : undefined);
    history.replaceState(null, '', `/chat/${conversation.id}`);
    mount();
    await user.type(await screen.findByLabelText('Votre message'), 'Finish while minimized');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull(); });
    const turn = { id: '44444444-4444-4444-8444-444444444444', userMessageId: '55555555-5555-4555-8555-555555555555', state: 'completed', attempt: 1, availableAt: conversation.createdAt, errorCode: null, claimExpiresAt: null };
    const message = { id: turn.userMessageId, conversationId: conversation.id, sequence: 1, role: 'user', content: 'Finish while minimized', requestId: '66666666-6666-4666-8666-666666666666', replyTo: null, createdAt: conversation.createdAt, turn };
    await act(async () => { posted.resolve(json({ conversation: { ...conversation, version: 2 }, message, turn, replayed: false })); await posted.promise; });
    expect(location.pathname).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await screen.findByText(message.content);
    expect(screen.getAllByText(message.content)).toHaveLength(1);
    expect(screen.getByLabelText('Votre message').value).toBe('');
    expect(fetcher.mock.calls.filter(([url, init]) => url === `/api/v1/conversations/${conversation.id}/messages` && init?.method === 'POST')).toHaveLength(1);
  });

  it('shows the existing load error for an invalid conversation deep link without throwing', async () => {
    history.replaceState(null, '', '/chat/%E0%A4%A');
    httpFixture(url => url.includes('/messages') && url.startsWith('/api/v1/conversations/') ? new Response(null, { status: 404 }) : undefined);
    mount();
    await screen.findByRole('dialog', { name: 'Assistant' });
    await screen.findByText('Impossible de charger la conversation. Réessayez.');
    expect(screen.getByRole('button', { name: 'Minimize Assistant' })).toBeTruthy();
  });
});
