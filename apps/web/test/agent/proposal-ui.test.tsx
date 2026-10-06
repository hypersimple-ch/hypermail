// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProposalCard } from '../../src/agent/ui.js';
import type { AgentProposal, ProposalReviewRequest } from '../../src/agent/contracts.js';

afterEach(cleanup);

const accountId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const folderId = '33333333-3333-4333-8333-333333333333';
const proposal: AgentProposal = {
  id: '44444444-4444-4444-8444-444444444444', activityId: '55555555-5555-4555-8555-555555555555', accountId,
  runId: '66666666-6666-4666-8666-666666666666', origin: 'model', kind: 'archive',
  payload: { kind: 'archive', key: 'archive_mail', target: { accountId, messageId }, confidence: 0.5999, reason: 'A completed discussion.', evidenceIds: [], dependsOn: [] },
  confidence: 0.5999, threshold: 0.6, revision: 1, state: 'waiting_review', reason: 'A completed discussion.', evidenceSnapshot: [], dependencies: [], action: null,
  supersedesProposalId: null, createdAt: '2026-10-01T10:00:00.000Z',
};

describe('Proposal review interactions', () => {
  it('retains an idempotency key for uncertain retries but changes it when submitted content changes', async () => {
    const requests: ProposalReviewRequest[] = [];
    const onReview = vi.fn((input: ProposalReviewRequest) => { requests.push(input); return Promise.reject(new Error('Temporary network failure')); });
    render(<AgentProposalCard proposal={proposal} onReview={onReview} />);
    fireEvent.change(screen.getByLabelText('Review comment (optional)'), { target: { value: 'Keep this context' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve unchanged' }));
    await waitFor(() => { expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Approve unchanged' })).disabled).toBe(false); });
    fireEvent.click(screen.getByRole('button', { name: 'Approve unchanged' }));
    await waitFor(() => { expect(requests).toHaveLength(2); });
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(requests[0]).toMatchObject({ decision: 'approve', reason: 'Keep this context', expectedRevision: 1 });
    await waitFor(() => { expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Approve unchanged' })).disabled).toBe(false); });
    fireEvent.change(screen.getByLabelText('Review comment (optional)'), { target: { value: 'Different context' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve unchanged' }));
    await waitFor(() => { expect(requests).toHaveLength(3); });
    expect(requests[2]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
  });

  it('preserves a correction across conflicts and reloads without resubmitting, using the refreshed revision explicitly', async () => {
    const requests: ProposalReviewRequest[] = [];
    const onReview = vi.fn((input: ProposalReviewRequest) => { requests.push(input); return requests.length === 1 ? Promise.reject(Object.assign(new Error('Stale'), { status: 409 })) : Promise.resolve(); });
    const onReload = vi.fn(() => Promise.resolve());
    const props = { proposalFolders: [{ id: folderId, name: 'Projects', accountId }, { id: '77777777-7777-4777-8777-777777777777', name: 'Other mailbox', accountId: '88888888-8888-4888-8888-888888888888' }], onReview, onReloadProposals: onReload };
    const view = render(<AgentProposalCard proposal={proposal} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Correction reason (required)'), { target: { value: 'File in Projects instead' } });
    await userEvent.click(screen.getByRole('button', { name: /Corrected action/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'move' }));
    await userEvent.click(screen.getByRole('button', { name: /Destination folder/ }));
    expect(screen.queryByRole('option', { name: 'Other mailbox' })).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: 'Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm displayed correction' }));
    await screen.findByRole('button', { name: 'Reload current proposal' });
    expect((screen.getByLabelText<HTMLTextAreaElement>('Correction reason (required)')).value).toBe('File in Projects instead');
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm displayed correction' })).disabled).toBe(true);
    view.rerender(<AgentProposalCard proposal={{ ...proposal, revision: 2 }} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload current proposal' }));
    await waitFor(() => { expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm displayed correction' })).disabled).toBe(false); });
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm displayed correction' }));
    await waitFor(() => { expect(requests).toHaveLength(2); });
    expect(requests[1]).toMatchObject({ expectedRevision: 2, correction: { kind: 'move', target: { accountId, messageId, destinationFolderId: folderId }, reason: 'File in Projects instead' } });
    expect(requests[1]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
  });

  it('validates recipient errors locally and supports explicitly entered owner HTML without changing the message target', async () => {
    const onReview = vi.fn<(input: ProposalReviewRequest) => Promise<void>>().mockResolvedValue(undefined);
    render(<AgentProposalCard proposal={proposal} onReview={onReview} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    await userEvent.click(screen.getByRole('button', { name: /Corrected action/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'draft create' }));
    fireEvent.change(screen.getByLabelText('Correction reason (required)'), { target: { value: 'Prepare my reply' } });
    fireEvent.change(screen.getByLabelText('TO (comma-separated)'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm displayed correction' }));
    expect(onReview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('TO (comma-separated)'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('CC (comma-separated)'), { target: { value: 'colleague@example.test' } });
    await userEvent.click(screen.getByRole('button', { name: /Body format/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'HTML' }));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'My reply' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '<p>Approved by me</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm displayed correction' }));
    await waitFor(() => { expect(onReview).toHaveBeenCalledOnce(); });
    expect(onReview.mock.calls[0]?.[0].correction).toEqual({ kind: 'draft_create', target: { accountId, messageId }, reason: 'Prepare my reply', draft: { recipients: [{ kind: 'to', address: 'owner@example.test' }, { kind: 'cc', address: 'colleague@example.test' }], subject: 'My reply', body: '<p>Approved by me</p>', bodyFormat: 'html' } });
  });

  it('keeps an independent proposal editable while another review is in flight', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<undefined>();
    const onReview = vi.fn<(input: ProposalReviewRequest) => Promise<void>>().mockReturnValue(promise);
    const sibling: AgentProposal = { ...proposal, id: '99999999-9999-4999-8999-999999999999', kind: 'draft_create', payload: { ...proposal.payload, kind: 'draft_create', target: { accountId, messageId }, draft: { recipients: [{ kind: 'to', address: 'owner@example.test' }], subject: 'Reply', body: 'Thanks.', bodyFormat: 'markdown' } } };
    const view = render(<><AgentProposalCard proposal={proposal} onReview={onReview} /><AgentProposalCard proposal={sibling} onReview={onReview} /></>);
    const first = within(screen.getByLabelText('Proposal: archive'));
    const second = within(screen.getByLabelText('Proposal: draft_create'));
    fireEvent.click(first.getByRole('button', { name: 'Approve unchanged' }));
    expect(first.getByRole<HTMLButtonElement>('button', { name: 'Approve unchanged' }).disabled).toBe(true);
    expect(second.getByRole<HTMLButtonElement>('button', { name: 'Approve unchanged' }).disabled).toBe(false);
    fireEvent.change(second.getByLabelText('Review comment (optional)'), { target: { value: 'My independent correction context' } });
    expect(second.getByLabelText<HTMLTextAreaElement>('Review comment (optional)').value).toBe('My independent correction context');
    await act(async () => { finish(undefined); await promise; });
    view.rerender(<><AgentProposalCard proposal={{ ...proposal, state: 'ready', revision: 2 }} onReview={onReview} /><AgentProposalCard proposal={sibling} onReview={onReview} /></>);
    expect(first.queryByRole('button', { name: 'Approve unchanged' })).toBeNull();
    expect(second.getByLabelText<HTMLTextAreaElement>('Review comment (optional)').value).toBe('My independent correction context');
  });
});
