import { describe, expect, it, vi } from 'vitest';
import { ConversationCursorError, type Conversation } from '@hypermail/contracts';
import type { ConversationStore } from '@hypermail/db';
import { ConversationService } from '../src/conversations/service.js';
import { createConversationRoutes, type ConversationRouteRequest } from '../src/conversations/routes.js';
const userId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const turnId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const conversation: Conversation = { id, userId, accountId, scope: 'mailbox', contextMessageId: null, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
function fixture() {
  const store = {
    create: vi.fn<ConversationStore['create']>().mockResolvedValue(conversation),
    get: vi.fn<ConversationStore['get']>().mockResolvedValue(conversation),
    list: vi.fn<ConversationStore['list']>().mockResolvedValue({ conversations: [], nextCursor: null }),
    messages: vi.fn<ConversationStore['messages']>().mockResolvedValue({ messages: [], nextCursor: null }),
    append: vi.fn<ConversationStore['append']>().mockResolvedValue({ kind: 'conflict', currentVersion: 4 }),
    retry: vi.fn<ConversationStore['retry']>().mockResolvedValue({ kind: 'conflict', currentAttempt: 3 }),
  };
  return { store, routes: createConversationRoutes(new ConversationService(store), { expectedOrigin: 'https://mail.example.test' }) };
}
const request: ConversationRouteRequest = { method: 'POST', origin: 'https://mail.example.test', auth: { subjectId: userId, accountIds: [accountId] }, body: {}, query: {} };
describe('conversation HTTP boundary', () => {
  it('requires a session and exact mutation origin before accepting owner text', async () => {
    const { routes, store } = fixture();
    expect((await routes.create({ ...request, auth: null, body: { scope: 'global' } })).status).toBe(401);
    expect((await routes.create({ ...request, origin: 'https://attacker.test', body: { scope: 'global' } })).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
    expect((await routes.list({ ...request, method: 'GET', origin: null, query: { scope: 'global' } })).status).toBe(200);
  });
  it('rejects spoofed actors, implicit global contexts and invalid uncoerced message versions', async () => {
    const { routes, store } = fixture();
    for (const body of [{ scope: 'global', userId }, { scope: 'global', contextMessageId: id }, { scope: 'mailbox', accountId: 'invalid' }]) expect((await routes.create({ ...request, body })).status).toBe(400);
    for (const content of ['', '  ', 'x'.repeat(16001)]) expect((await routes.post({ ...request, body: { requestId, expectedVersion: 1, content } }, id)).status).toBe(400);
    expect((await routes.post({ ...request, body: { requestId, expectedVersion: '1', content: 'hello' } }, id)).status).toBe(400);
    expect(store.append).not.toHaveBeenCalled();
  });
  it('hides missing context and ownership and returns conflict revisions instead of overwriting', async () => {
    const { routes, store } = fixture();
    store.create.mockResolvedValue(null);
    expect((await routes.create({ ...request, body: { scope: 'mailbox', accountId, contextMessageId: id } })).status).toBe(404);
    store.get.mockResolvedValue(null);
    expect((await routes.messages({ ...request, method: 'GET' }, id)).status).toBe(404);
    expect(await routes.post({ ...request, body: { requestId, expectedVersion: 1, content: 'hello' } }, id)).toEqual({ status: 409, body: { error: { code: 'CONFLICT', currentVersion: 4 } } });
    expect(await routes.retry({ ...request, body: { expectedAttempt: 0 } }, id, turnId)).toEqual({ status: 409, body: { error: { code: 'CONFLICT', currentAttempt: 3 } } });
  });
  it('rejects malformed and cross-scope cursors and unauthorized mailbox filters', async () => {
    const { routes, store } = fixture();
    expect((await routes.list({ ...request, method: 'GET', query: { scope: 'global', accountId } })).status).toBe(400);
    expect((await routes.list({ ...request, method: 'GET', query: { scope: 'mailbox', accountId: id } })).status).toBe(404);
    expect((await routes.messages({ ...request, method: 'GET', query: { limit: '1000' } }, id)).status).toBe(400);
    store.list.mockRejectedValue(new ConversationCursorError());
    expect((await routes.list({ ...request, method: 'GET', query: { scope: 'global', cursor: 'foreign' } })).status).toBe(400);
    store.messages.mockRejectedValue(new ConversationCursorError());
    expect((await routes.messages({ ...request, method: 'GET', query: { cursor: 'foreign' } }, id)).status).toBe(400);
  });
});
