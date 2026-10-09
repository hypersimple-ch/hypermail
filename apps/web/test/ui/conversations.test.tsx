// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationMessage, ConversationTurn } from '@hypermail/contracts';
import { ChatSurface as ConversationSurface } from '../../src/conversations/ui.js';
import type { ChatSurfaceProps, ConversationApi } from '../../src/conversations/ui.js';
import { ConversationHttpError } from '../../src/conversations/contracts.js';
import type { ConversationMessages } from '../../src/conversations/contracts.js';
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
function ChatSurface({ onConversationOpened, ...props }: Omit<ChatSurfaceProps, 'isOpen' | 'onOpenChange' | 'launcherRef'>) {
  const [isOpen, setOpen] = useState(true);
  const [rememberedId, setRememberedId] = useState<string>();
  const launcherRef = useRef<HTMLButtonElement>(null);
  return <><button ref={launcherRef} onClick={() => { setOpen(true); }}>Open Assistant</button><ConversationSurface {...props} conversationId={props.conversationId ?? rememberedId} isOpen={isOpen} onOpenChange={setOpen} launcherRef={launcherRef} onConversationOpened={(id) => { setRememberedId(id); onConversationOpened?.(id); }} /></>;
}
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
    await waitFor(() => { expect(api.create.mock.calls[1]?.[0]).toEqual({ scope: 'global' }); });
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
  it('minimizes with Escape, restores launcher focus and preserves unsent text on reopen', async () => {
    const api = fixture(); const user = userEvent.setup();
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Unsent draft');
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Assistant' })); });
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect((await screen.findByLabelText('Votre message')).value).toBe('Unsent draft');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('retains a failed send and its request identity across minimize and reopen', async () => {
    const api = fixture(); const user = userEvent.setup();
    api.post.mockRejectedValueOnce(new Error('offline'));
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), message.content);
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await screen.findByRole('alert');
    const request = api.post.mock.calls[0]?.[1];
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect((await screen.findByLabelText('Votre message')).value).toBe(message.content);
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => { expect(api.post).toHaveBeenCalledTimes(2); });
    expect(api.post.mock.calls[1]?.[1]).toEqual(request);
  });
  it('continues polling while minimized and reveals a completed response only once', async () => {
    const api = fixture(); const user = userEvent.setup();
    const polled = Promise.withResolvers<ConversationMessages>();
    api.messages.mockResolvedValueOnce({ conversation, messages: [message], nextCursor: null }).mockImplementation(() => polled.promise);
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(api.messages).toHaveBeenCalledTimes(2); }, { timeout: 4000 });
    const reply = { ...message, id: 'reply', sequence: 2, role: 'assistant' as const, content: 'Completed while minimized', requestId: null, replyTo: message.id, turn: null };
    await act(async () => { polled.resolve({ conversation, messages: [{ ...message, turn: { ...turn, state: 'completed' } }, reply], nextCursor: null }); await polled.promise; });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    await screen.findByText(reply.content);
    expect(screen.getAllByText(reply.content)).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('attaches newly discussed context without discarding the existing conversation or draft', async () => {
    const api = fixture(); const user = userEvent.setup();
    const view = render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Keep my draft');
    const context = { accountId, messageId: 'new-discussed-message' };
    view.rerender(<ChatSurface accounts={accounts} conversationId={conversation.id} initialContext={context} api={api} />);
    expect(screen.getByLabelText('Votre message').value).toBe('Keep my draft');
    expect(api.create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await waitFor(() => { expect(api.create).toHaveBeenCalledWith({ scope: 'mailbox', accountId, contextMessageId: context.messageId }); });
  });
  it('reattaches the same discussed mail after context removal without clearing the draft', async () => {
    const api = fixture(); const user = userEvent.setup();
    const context = { accountId, messageId: 'revisited-message' };
    const view = render(<ChatSurface accounts={accounts} conversationId={conversation.id} initialContext={context} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Draft retained for repeated discussion');
    await user.click(screen.getByRole('button', { name: 'Retirer le contexte' }));
    expect(screen.queryByRole('button', { name: 'Retirer le contexte' })).toBeNull();
    view.rerender(<ChatSurface accounts={accounts} conversationId={conversation.id} initialContext={{ ...context }} api={api} />);
    await screen.findByRole('button', { name: 'Retirer le contexte' });
    expect(screen.getByLabelText('Votre message').value).toBe('Draft retained for repeated discussion');
    expect(api.create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await waitFor(() => { expect(api.create).toHaveBeenCalledWith({ scope: 'mailbox', accountId, contextMessageId: context.messageId }); });
  });
  it('does not reload a just-created conversation when the owner records its id', async () => {
    const api = fixture(); const user = userEvent.setup();
    render(<ChatSurface accounts={accounts} api={api} />);
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    await user.type(await screen.findByLabelText('Votre message'), 'Draft after creation');
    await user.click(screen.getByRole('button', { name: 'Minimize Assistant' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect((await screen.findByLabelText('Votre message')).value).toBe('Draft after creation');
    expect(api.messages).toHaveBeenCalledTimes(1);
  });
  it('keeps earlier conversations available while paging the collapsed history', async () => {
    const api = fixture(); const user = userEvent.setup();
    const later = { ...conversation, id: '99999999-9999-4999-8999-999999999999', createdAt: '2026-10-02T00:00:00Z' };
    api.list.mockResolvedValueOnce({ conversations: [conversation], nextCursor: 'history-cursor' }).mockResolvedValue({ conversations: [later], nextCursor: null });
    render(<ChatSurface accounts={accounts} api={api} />);
    await user.click(screen.getByText('Conversations'));
    await user.click(await screen.findByRole('button', { name: 'Plus de conversations' }));
    expect(await screen.findByRole('button', { name: `Conversation du ${new Date(conversation.createdAt).toLocaleString()}` })).toBeTruthy();
    api.messages.mockResolvedValue({ conversation: later, messages: [], nextCursor: null });
    await user.click(await screen.findByRole('button', { name: `Conversation du ${new Date(later.createdAt).toLocaleString()}` }));
    await user.type(await screen.findByLabelText('Votre message'), 'Question in the selected older conversation');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => { expect(api.post.mock.calls[0]?.[0]).toBe(later.id); });
  });
  it.each(['resolve', 'reject'] as const)('ignores a delayed post that %s after selecting another conversation', async (outcome) => {
    const api = fixture(); const user = userEvent.setup();
    const delayed = Promise.withResolvers<{ conversation: Conversation; message: ConversationMessage; turn: ConversationTurn; replayed: boolean }>();
    api.post.mockImplementationOnce(() => delayed.promise);
    const other = { ...conversation, id: '99999999-9999-4999-8999-999999999999' };
    const view = render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Old question');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    api.messages.mockResolvedValue({ conversation: other, messages: [], nextCursor: null });
    view.rerender(<ChatSurface accounts={accounts} conversationId={other.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'New conversation draft');
    await act(async () => {
      if (outcome === 'resolve') delayed.resolve({ conversation, message, turn, replayed: false });
      else delayed.reject(new ConversationHttpError(409, 'CONFLICT'));
      await delayed.promise.catch(() => undefined);
    });
    expect(screen.getByLabelText('Votre message').value).toBe('New conversation draft');
    expect(screen.queryByText(message.content)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => { expect(api.post.mock.calls[1]?.[0]).toBe(other.id); });
    expect(api.post.mock.calls[1]?.[1].content).toBe('New conversation draft');
  });
  it('ignores a delayed creation after a different conversation is deep-linked', async () => {
    const api = fixture(); const user = userEvent.setup();
    const delayed = Promise.withResolvers<{ conversation: Conversation }>();
    api.create.mockImplementationOnce(() => delayed.promise);
    const other = { ...conversation, id: '99999999-9999-4999-8999-999999999999' };
    const onConversationOpened = vi.fn();
    const view = render(<ChatSurface accounts={accounts} api={api} onConversationOpened={onConversationOpened} />);
    await user.click(screen.getByRole('button', { name: 'Nouveau chat' }));
    api.messages.mockResolvedValue({ conversation: other, messages: [], nextCursor: null });
    view.rerender(<ChatSurface accounts={accounts} conversationId={other.id} api={api} onConversationOpened={onConversationOpened} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Draft on deep link');
    await act(async () => { delayed.resolve({ conversation }); await delayed.promise; });
    expect(screen.getByLabelText('Votre message').value).toBe('Draft on deep link');
    expect(onConversationOpened).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => { expect(api.post.mock.calls[0]?.[0]).toBe(other.id); });
  });
  it('ignores a delayed reply retry failure after selecting another conversation', async () => {
    const api = fixture(); const user = userEvent.setup();
    const delayed = Promise.withResolvers<{ turn: ConversationTurn }>();
    api.retry.mockImplementationOnce(() => delayed.promise);
    api.messages.mockResolvedValueOnce({ conversation, messages: [{ ...message, turn: { ...turn, state: 'failed' } }], nextCursor: null });
    const other = { ...conversation, id: '99999999-9999-4999-8999-999999999999' };
    const view = render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Réessayer la réponse' }));
    api.messages.mockResolvedValue({ conversation: other, messages: [], nextCursor: null });
    view.rerender(<ChatSurface accounts={accounts} conversationId={other.id} api={api} />);
    await user.type(await screen.findByLabelText('Votre message'), 'Different conversation');
    await act(async () => { delayed.reject(new Error('offline')); await delayed.promise.catch(() => undefined); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Votre message').value).toBe('Different conversation');
    expect(screen.getByRole('button', { name: 'Envoyer' }).disabled).toBe(false);
  });
  it('keeps keyboard focus inside the dialog when submitting disables the send button', async () => {
    const api = fixture(); const user = userEvent.setup();
    const delayed = Promise.withResolvers<{ conversation: Conversation; message: ConversationMessage; turn: ConversationTurn; replayed: boolean }>();
    api.post.mockImplementationOnce(() => delayed.promise);
    render(<ChatSurface accounts={accounts} conversationId={conversation.id} api={api} />);
    const composer = await screen.findByLabelText('Votre message');
    await user.type(composer, message.content);
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(screen.getByRole('button', { name: 'En cours…' }).disabled).toBe(true);
    expect(document.activeElement).toBe(composer);
    await act(async () => { delayed.resolve({ conversation, message, turn, replayed: false }); await delayed.promise; });
    expect(screen.getByRole('button', { name: 'Envoyer' }).disabled).toBe(true);
    expect(document.activeElement).toBe(composer);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Assistant' })); });
  });
});
