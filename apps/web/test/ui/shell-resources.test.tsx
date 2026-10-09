// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HypermailShell, type ShellData, type Screen } from '../../src/ui/index.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';
import type { ActivityRecord } from '../../src/activity/contracts.js';

const data: ShellData = { accounts: [], messages: [], activity: { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } } };
const draft: DraftRecord = { id: 'draft-1', accountId: 'mailbox-1', sourceMessageId: null, createdBy: 'user', recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Saved subject', body: 'Saved body', bodyFormat: 'markdown', state: 'editing', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const activity: ActivityRecord = { id: 'activity-1', accountId: 'mailbox-1', accountLabel: 'Personal', messageId: null, messageLabel: 'Message', title: 'Retained activity', state: 'new', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', timeline: [] };

afterEach(() => { cleanup(); history.replaceState({}, '', '/'); });

it.each(['error', 'loading'] as const)('does not turn Inbox %s into an Activity failure', state => {
  render(<HypermailShell data={data} initialScreen="activity" initialState={state} />);
  expect(screen.getByText('No new activity.')).toBeTruthy();
  expect(screen.queryByText('Could not load activity.')).toBeNull();
  expect(screen.queryByText('Loading activity…')).toBeNull();
});

it('keeps Activity loading/error local, retries, then shows the successful projection', async () => {
  const user = userEvent.setup();
  const retry = vi.fn().mockResolvedValue(undefined);
  const view = render(<HypermailShell data={{ ...data, activityState: 'loading' }} initialScreen="activity" onActivityFilter={retry} />);
  expect(screen.getByText('Loading activity…')).toBeTruthy();
  expect(screen.queryByText('No new activity.')).toBeNull();
  view.rerender(<HypermailShell data={{ ...data, activityState: 'error', activityError: 'Activity service unavailable.' }} initialScreen="activity" onActivityFilter={retry} />);
  expect(screen.getByText('Activity service unavailable.')).toBeTruthy();
  expect(screen.queryByText('No new activity.')).toBeNull();
  retry.mockImplementation(() => { view.rerender(<HypermailShell data={{ ...data, activityState: 'ready', activity: { ...data.activity, items: [activity] } }} initialScreen="activity" onActivityFilter={retry} />); return Promise.resolve(); });
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: 'Open: Retained activity' })).toBeTruthy();
  expect(screen.queryByText('Activity service unavailable.')).toBeNull();
});

it('retains successful Activity rows on a refresh failure with an explicit retry', () => {
  render(<HypermailShell data={{ ...data, activityState: 'error', activity: { ...data.activity, items: [activity] } }} initialScreen="activity" onActivityFilter={() => Promise.resolve()} />);
  expect(screen.getByRole('button', { name: 'Open: Retained activity' })).toBeTruthy();
  expect(screen.getByText('Could not load activity.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it.each([['drafts', 'No drafts yet.'], ['sent', 'No sent messages.'], ['pending-sends', 'No send requests are waiting.']] as const)('does not present %s as empty while sending is unavailable and recovers after retry', async (destination, empty) => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const props = { data, initialScreen: destination as Screen, onRefreshSendRequests: () => Promise.resolve(), onRetrySending: retry };
  const view = render(<HypermailShell {...props} sendingState="loading" />);
  expect(screen.getByText('Loading sending…')).toBeTruthy();
  expect(screen.queryByText(empty)).toBeNull();
  view.rerender(<HypermailShell {...props} sendingState="error" sendingError="Sending service unavailable." />);
  expect(screen.getByText('Sending service unavailable.')).toBeTruthy();
  expect(screen.queryByText(empty)).toBeNull();
  retry.mockImplementation(() => { view.rerender(<HypermailShell {...props} sendingState="ready" />); });
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText(empty)).toBeTruthy();
  expect(screen.queryByText('Sending service unavailable.')).toBeNull();
});

it.each(['drafts', 'sent'] as const)('keeps successful %s rows visible after a failed refresh', destination => {
  render(<HypermailShell data={data} initialScreen={destination} drafts={[{ ...draft, state: destination === 'sent' ? 'sent' : 'editing' }]} sendingState="error" onRetrySending={() => undefined} />);
  expect(screen.getByText('Saved subject')).toBeTruthy();
  expect(screen.getByText('Could not load sending.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('keeps pending send review available during a collection refresh failure', () => {
  render(<HypermailShell data={data} initialScreen="pending-sends" sendingState="error" onRetrySending={() => undefined} onRefreshSendRequests={() => Promise.resolve()} sendRequests={[{ id: 'request-1', accountId: draft.accountId, draftId: draft.id, draftVersion: draft.version, state: 'pending_owner_approval', approvalId: null, actionId: null, providerMessageId: null, expiresAt: '2099-01-01T00:00:00Z', completedAt: null, reasonCode: null, createdAt: draft.createdAt, updatedAt: draft.updatedAt, snapshot: draft }]} />);
  expect(screen.getByRole('button', { name: 'Review and send' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reject send request' })).toBeTruthy();
  expect(screen.getByText('Could not load sending.')).toBeTruthy();
  expect(screen.queryByText('No send requests are waiting.')).toBeNull();
});

it('keeps unsaved draft fields mounted when independent resource refreshes fail or update the saved projection', async () => {
  const user = userEvent.setup();
  const props = { data, initialScreen: 'drafts' as const, drafts: [draft], onUpdateDraft: () => Promise.resolve() };
  const view = render(<HypermailShell {...props} />);
  await user.click(screen.getByRole('button', { name: 'Open draft Saved subject' }));
  await user.clear(screen.getByLabelText('Subject'));
  await user.type(screen.getByLabelText('Subject'), 'Unsaved subject');
  await user.type(screen.getByLabelText('Message (markdown)'), ' with local changes');
  const subject = screen.getByLabelText<HTMLInputElement>('Subject');
  const message = screen.getByLabelText<HTMLTextAreaElement>('Message (markdown)');
  view.rerender(<HypermailShell {...props} drafts={[{ ...draft, subject: 'New saved version', version: 2 }]} data={{ ...data, activityState: 'error' }} sendingState="error" sendingError="Sending unavailable." />);
  expect(screen.getByLabelText('Subject')).toBe(subject);
  expect(subject.value).toBe('Unsaved subject');
  expect(screen.getByLabelText('Message (markdown)')).toBe(message);
  expect(message.value).toContain('with local changes');
  expect(screen.getByText('Version 2 · User-created draft')).toBeTruthy();
});

it('retains a new message editor across independent Activity and sending state transitions', async () => {
  const user = userEvent.setup();
  const view = render(<HypermailShell data={data} initialScreen="compose" />);
  await user.type(screen.getByLabelText('To'), 'recipient@example.test');
  await user.type(screen.getByLabelText('Subject'), 'Unsaved new message');
  view.rerender(<HypermailShell data={{ ...data, activityState: 'loading' }} initialScreen="compose" sendingState="loading" />);
  view.rerender(<HypermailShell data={{ ...data, activityState: 'error' }} initialScreen="compose" sendingState="error" />);
  expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe('recipient@example.test');
  expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('Unsaved new message');
  expect(screen.queryByText('Could not load sending.')).toBeNull();
});

it('keeps Inbox and Settings usable when both secondary collections fail', async () => {
  const user = userEvent.setup();
  render(<HypermailShell data={{ ...data, activityState: 'error', activityError: 'Activity unavailable.' }} sendingState="error" sendingError="Sending unavailable." />);
  expect(screen.getByText('Select or connect a mailbox.')).toBeTruthy();
  expect(screen.queryByText('Activity unavailable.')).toBeNull();
  expect(screen.queryByText('Sending unavailable.')).toBeNull();
  await user.click(within(screen.getByRole('navigation', { name: 'Mobile primary' })).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('button', { name: /^Settings/ }));
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByText('Could not load mail.')).toBeNull();
});
