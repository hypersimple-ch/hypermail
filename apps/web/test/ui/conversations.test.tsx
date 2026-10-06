// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationMessage, ConversationTurn } from '@hypermail/contracts';
import { ChatSurface } from '../../src/conversations/ui.js';
import type { ConversationApi } from '../../src/conversations/ui.js';
import { ConversationHttpError } from '../../src/conversations/contracts.js';
const accountId = '33333333-3333-4333-8333-333333333333';
const conversation: Conversation = { id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', scope: 'mailbox', accountId, contextMessageId: null, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const turn: ConversationTurn = { id: '44444444-4444-4444-8444-444444444444', userMessageId: '55555555-5555-4555-8555-555555555555', state: 'pending', attempt: 0, availableAt: conversation.createdAt, errorCode: null, claimExpiresAt: null };
const message: ConversationMessage = { id: turn.userMessageId, conversationId: conversation.id, sequence: 1, role: 'user', content: 'Keep this question', requestId: '66666666-6666-4666-8666-666666666666', replyTo: null, createdAt: conversation.createdAt, turn };
function fixture() {
  return {
    create: vi.fn<ConversationApi['create']>().mockResolvedValue({ conversation }),
    list: vi.fn<ConversationApi['list']>().mockResolvedValue({ conversations: [], nextCursor: null }),
    messages: vi.fn<ConversationApi['messages']>().mockResolvedValue({ conversation, messages: [], nextCursor: null }),
    post: vi.fn<ConversationApi['post']>().mockResolvedValue({ conversation: { ...conversation, version: 2 }, message, turn, replayed: false }),
    retry: vi.fn<ConversationApi['retry']>().mockResolvedValue({ turn }),
  };
}
const accounts = [{ id: accountId, label: 'Personal' }];
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('durable ChatSurface', () => {
  it('freezes an in-flight owner message and cannot create a duplicate post', async () => {
    const api = fixture(); const user = userEvent.setup();
    const deferred = Promise.withResolvers<undefined>();
    api.post.mockImplementation(async () => { await deferred.promise; return { conversation: { ...conversation, version: 2 }, message, turn, replayed: false }; });
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), message.content);
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(screen.getByRole('button', { name: 'En cours…' }).disabled).toBe(true);
    expect(screen.getByLabelText('Votre message').readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: 'En cours…' }));
    expect(api.post).toHaveBeenCalledTimes(1);
    deferred.resolve(undefined);
    await screen.findByRole('status');
    expect(screen.getByLabelText('Votre message').value).toBe('');
  });
  it('keeps exact content and request identity after network failure and waits for explicit review after conflict', async () => {
    const api = fixture(); const user = userEvent.setup();
    api.post.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new ConversationHttpError(409, 'CONFLICT'));
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), '  Keep this question  ');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Votre message').value).toBe('  Keep this question  ');
    const identity = api.post.mock.calls[0]?.[1];
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await screen.findByRole('button', { name: 'Recharger et relire' });
    expect(api.post.mock.calls[1]?.[1]).toEqual(identity);
    expect(screen.getByRole('button', { name: 'Envoyer' }).disabled).toBe(true);
    api.messages.mockResolvedValue({ conversation: { ...conversation, version: 4 }, messages: [], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Recharger et relire' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Envoyer' }).disabled).toBe(false); });
    expect(api.post).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => { expect(api.post).toHaveBeenCalledTimes(3); });
    expect(api.post.mock.calls[2]?.[1]).toEqual({ ...identity, expectedVersion: 4 });
    await waitFor(() => { expect(screen.getByLabelText('Votre message').value).toBe(''); });
    expect(screen.getByText(message.content)).toBeTruthy();
  });
  it('does not post another owner source when retrying a failed reply', async () => {
    const api = fixture(); const user = userEvent.setup();
    api.messages.mockResolvedValue({ conversation, messages: [{ ...message, turn: { ...turn, state: 'failed', attempt: 3, errorCode: 'MODEL_TEMPORARY' } }], nextCursor: null });
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Réessayer la réponse' }));
    await screen.findByRole('status');
    expect(api.retry).toHaveBeenCalledWith(conversation.id, turn.id, 3);
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getAllByText(message.content)).toHaveLength(1);
  });
  it('polls a pending turn into exactly one assistant response', async () => {
    const api = fixture();
    api.messages.mockResolvedValueOnce({ conversation, messages: [message], nextCursor: null });
    const reply = { ...message, id: '77777777-7777-4777-8777-777777777777', sequence: 2, role: 'assistant' as const, content: 'Answer from assistant', requestId: null, replyTo: message.id, turn: null };
    api.messages.mockResolvedValue({ conversation: { ...conversation, version: 2 }, messages: [{ ...message, turn: { ...turn, state: 'completed' } }, reply], nextCursor: null });
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await screen.findByRole('status');
    await screen.findByText(reply.content, {}, { timeout: 4000 });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByText(reply.content)).toHaveLength(1);
  });
  it('attaches mailbox context only for the mailbox selection and never for explicit global', async () => {
    const api = fixture(); const user = userEvent.setup();
    const context = { accountId, messageId: '88888888-8888-4888-8888-888888888888' };
    render(<ChatSurface accounts={accounts} initialContext={context} api={api} />);
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await screen.findByLabelText('Votre message');
    expect(api.create.mock.calls[0]?.[0]).toEqual({ scope: 'mailbox', accountId: context.accountId, contextMessageId: context.messageId });
    await user.click(screen.getByRole('button', { name: /Portée du nouveau chat/ }));
    await user.click(await screen.findByRole('option', { name: 'Toutes les boîtes (global explicite)' }));
    api.create.mockResolvedValue({ conversation: { ...conversation, scope: 'global', accountId: null, contextMessageId: null } });
    api.messages.mockResolvedValue({ conversation: { ...conversation, scope: 'global', accountId: null, contextMessageId: null }, messages: [], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await screen.findByRole('heading', { name: 'Chat — Toutes les boîtes' });
    expect(api.create.mock.calls[1]?.[0]).toEqual({ scope: 'global' });
    expect(screen.queryByText(/Mail attaché/)).toBeNull();
  });
  it('appends the next stable message page without losing previously read messages', async () => {
    const api = fixture(); const user = userEvent.setup();
    api.messages.mockResolvedValueOnce({ conversation, messages: [{ ...message, turn: null }], nextCursor: 'sequence-cursor' }).mockResolvedValue({ conversation, messages: [{ ...message, id: 'next', sequence: 51, content: 'Later question', turn: null }], nextCursor: null });
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Messages suivants' }));
    await screen.findByText('Later question');
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(api.messages).toHaveBeenLastCalledWith(conversation.id, 'sequence-cursor');
  });
});
