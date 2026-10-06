/* eslint-disable @typescript-eslint/require-await -- Synchronous doubles implement asynchronous ports. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { activityThreadId, conversationThreadId, MailboxMemoryUnavailableError, userResourceId, type SourceHistory } from '@hypermail/agent';
import type { ConversationStore, ManagedSqlClient, OwnerMemorySource, SqlClient } from '@hypermail/db';
import { MailboxOwnerMemoryInputs } from '../src/mailbox-memory-inputs.js';

const cutoff = new Date('2026-01-01T00:00:00Z');
const source = (overrides: Partial<OwnerMemorySource> = {}): OwnerMemorySource => ({
  id: `conversation:${randomUUID()}`, scope: 'global', accountId: null, conversationId: randomUUID(), activityId: null,
  content: 'Reply briefly.', createdAt: '2025-12-01T00:00:00.000001Z', ...overrides,
});

/** Session-lock double: independent sessions share user keys, never a transaction. */
function database() {
  const holders = new Map<string, Promise<void>>();
  const events: { operation: 'lock' | 'unlock'; key: string }[] = [];
  const db: Pick<ManagedSqlClient, 'withSession'> = {
    withSession: async operation => {
      let release: (() => void) | undefined;
      const client: SqlClient = {
        query: async (statement, values) => {
          const key = String(values?.[0]);
          if (statement.includes('pg_advisory_unlock')) {
            events.push({ operation: 'unlock', key });
            release?.();
          } else if (statement.includes('pg_advisory_lock')) {
            const previous = holders.get(key);
            const next = Promise.withResolvers<undefined>();
            holders.set(key, next.promise);
            release = () => { next.resolve(undefined); if (holders.get(key) === next.promise) holders.delete(key); };
            await previous;
            events.push({ operation: 'lock', key });
          } else throw new Error('Unexpected SQL');
          return { rows: [] };
        },
        transaction: () => Promise.reject(new Error('Model I/O must not hold a transaction')),
      };
      return operation(client);
    },
  };
  return { db, events };
}

function fixture(sources: readonly OwnerMemorySource[] = []) {
  const sessions = database();
  const appended: Parameters<SourceHistory['append']>[0][] = [];
  const operations: { stage: 'append' | 'observe'; threadId: string }[] = [];
  const history: SourceHistory = {
    append: async input => { appended.push(input); operations.push({ stage: 'append', threadId: input.threadId }); },
    observe: async input => { operations.push({ stage: 'observe', threadId: input.threadId }); },
  };
  const ownerSources = vi.fn<ConversationStore['ownerSources']>(async (_scope, _cutoff, cursor) => {
    const start = cursor ? sources.findIndex(item => item.id === cursor.sourceId) + 1 : 0;
    return sources.slice(start, start + 100);
  });
  const store = { hasPendingOwnerContext: vi.fn(async () => false), ownerSources };
  const inputs = new MailboxOwnerMemoryInputs(store, history, sessions.db);
  return { ...sessions, inputs, store, history, appended, operations };
}

it('blocks reconstruction until earlier mailbox deliveries finish and releases its session lock', async () => {
  const f = fixture([source()]);
  const input = { userId: randomUUID(), accountId: randomUUID(), acceptedBefore: cutoff };
  f.store.hasPendingOwnerContext.mockResolvedValueOnce(true);
  await expect(f.inputs.prepare(input)).rejects.toBeInstanceOf(MailboxMemoryUnavailableError);
  expect(f.store.ownerSources).not.toHaveBeenCalled();
  expect(f.appended).toEqual([]);
  await f.inputs.prepare(input);
  expect(f.store.hasPendingOwnerContext).toHaveBeenCalledWith({ userId: input.userId, accountId: input.accountId }, cutoff);
  expect(f.events.map(event => event.operation)).toEqual(['lock', 'unlock', 'lock', 'unlock']);
  expect(f.appended.map(item => JSON.parse(item.text) as unknown)).toEqual([expect.objectContaining({ content: 'Reply briefly.' })]);
});

it('reconstructs over 100 canonical sources in chronological original threads with exact cursors', async () => {
  const userId = randomUUID();
  const accountId = randomUUID();
  const conversationId = randomUUID();
  const activityId = randomUUID();
  const sources = Array.from({ length: 205 }, (_, index) => source({
    id: `message:${String(index).padStart(3, '0')}`, createdAt: `2025-12-01T00:00:00.${String(index + 1).padStart(6, '0')}Z`,
    scope: index % 2 === 0 ? 'mailbox' : 'global', accountId: index % 2 === 0 ? accountId : null,
    conversationId: index === 0 ? conversationId : index % 2 === 0 ? null : `conversation-${String(index)}`,
    activityId: index === 2 ? activityId : null, content: index === 204 ? 'Correction: give detailed answers.' : `Owner source ${String(index)}`,
  }));
  const f = fixture(sources);
  await f.inputs.prepareGlobal({ userId, acceptedBefore: cutoff, conversationId });
  expect(f.store.hasPendingOwnerContext).not.toHaveBeenCalled();
  expect(f.store.ownerSources.mock.calls).toEqual([
    [{ userId }, cutoff, undefined],
    [{ userId }, cutoff, { createdAt: sources[99]?.createdAt, sourceId: sources[99]?.id }],
    [{ userId }, cutoff, { createdAt: sources[199]?.createdAt, sourceId: sources[199]?.id }],
  ]);
  expect(f.appended.map(item => (JSON.parse(item.text) as OwnerMemorySource).content)).toEqual(sources.map(item => item.content));
  expect(f.appended[0]?.threadId).toBe(conversationThreadId(userId, conversationId));
  expect(f.appended[2]?.threadId).toBe(activityThreadId(userId, accountId, activityId));
  expect(f.appended[4]?.threadId).toBe(`user:${userId}:owner-source:message:004:v3`);
  expect(f.appended.every(item => item.resourceId === userResourceId(userId))).toBe(true);
  expect(JSON.parse(f.appended[0]?.text ?? 'null')).toEqual({ sourceId: sources[0]?.id, provenance: 'user', scope: 'mailbox', accountId,
    content: sources[0]?.content, createdAt: sources[0]?.createdAt });
  expect(f.operations).toEqual(f.appended.flatMap(item => [
    { stage: 'append', threadId: item.threadId }, { stage: 'observe', threadId: item.threadId },
  ]));
});

it('replays exactly the same source payloads without merging observations into the requested thread', async () => {
  const userId = randomUUID();
  const originalThread = randomUUID();
  const otherThread = randomUUID();
  const f = fixture([source({ conversationId: originalThread })]);
  await f.inputs.prepareGlobal({ userId, acceptedBefore: cutoff, conversationId: originalThread });
  await f.inputs.prepareGlobal({ userId, acceptedBefore: cutoff, conversationId: otherThread });
  expect(f.appended).toEqual([f.appended[0], f.appended[0]]);
  expect(f.operations).toEqual([
    { stage: 'append', threadId: conversationThreadId(userId, originalThread) },
    { stage: 'observe', threadId: conversationThreadId(userId, originalThread) },
    { stage: 'append', threadId: conversationThreadId(userId, originalThread) },
    { stage: 'observe', threadId: conversationThreadId(userId, originalThread) },
  ]);
});

it('does not observe or regenerate a profile for an empty canonical page', async () => {
  const f = fixture();
  await f.inputs.prepareGlobal({ userId: randomUUID(), acceptedBefore: cutoff });
  expect(f.operations).toEqual([]);
  expect(f.events.map(event => event.operation)).toEqual(['lock', 'unlock']);
});

it.each(['barrier', 'sources', 'append', 'observe', 'session'] as const)('fails closed on %s outages and permits a subsequent retry', async stage => {
  const f = fixture([source()]);
  const unavailable = new Error('unavailable');
  if (stage === 'barrier') f.store.hasPendingOwnerContext.mockRejectedValueOnce(unavailable);
  if (stage === 'sources') f.store.ownerSources.mockRejectedValueOnce(unavailable);
  if (stage === 'append') f.history.append = vi.fn(f.history.append.bind(f.history)).mockRejectedValueOnce(unavailable);
  if (stage === 'observe') f.history.observe = vi.fn(f.history.observe.bind(f.history)).mockRejectedValueOnce(unavailable);
  if (stage === 'session') {
    const original = f.db.withSession;
    let failed = false;
    f.db.withSession = async operation => {
      if (!failed) { failed = true; throw unavailable; }
      return original(operation);
    };
  }
  const input = { userId: randomUUID(), accountId: randomUUID(), acceptedBefore: cutoff };
  await expect(f.inputs.prepare(input)).rejects.toMatchObject({ code: 'MAILBOX_MEMORY_UNAVAILABLE', retryable: true });
  await f.inputs.prepare(input);
  expect(f.events.map(event => event.operation)).toEqual(stage === 'session' ? ['lock', 'unlock'] : ['lock', 'unlock', 'lock', 'unlock']);
});

it('serializes same-user corrections across preparations but lets another user proceed', async () => {
  const sessions = database();
  const userId = randomUUID();
  const otherUser = randomUUID();
  const oldSource = source({ content: 'Brief answers.' });
  const correction = source({ content: 'Correction: detailed answers.', createdAt: '2025-12-02T00:00:00.000001Z' });
  const entered = Promise.withResolvers<undefined>();
  const continueObservation = Promise.withResolvers<undefined>();
  const applied: { userId: string; content: string }[] = [];
  let ownerReads = 0;
  const store = {
    hasPendingOwnerContext: async () => false,
    ownerSources: async (scope: { userId: string }) => {
      if (scope.userId === otherUser) return [source({ content: 'Other owner.' })];
      ownerReads += 1;
      return ownerReads === 1 ? [oldSource] : [correction];
    },
  };
  let content = '';
  const history: SourceHistory = {
    append: async input => { content = (JSON.parse(input.text) as OwnerMemorySource).content; },
    observe: async input => {
      const observedContent = content;
      if (observedContent === oldSource.content) { entered.resolve(undefined); await continueObservation.promise; }
      applied.push({ userId: input.resourceId, content: observedContent });
    },
  };
  const inputs = new MailboxOwnerMemoryInputs(store, history, sessions.db);
  const first = inputs.prepareGlobal({ userId, acceptedBefore: cutoff });
  await entered.promise;
  const second = inputs.prepare({ userId, accountId: randomUUID(), acceptedBefore: cutoff });
  await inputs.prepareGlobal({ userId: otherUser, acceptedBefore: cutoff });
  expect(ownerReads).toBe(1);
  expect(applied).toEqual([{ userId: userResourceId(otherUser), content: 'Other owner.' }]);
  continueObservation.resolve(undefined);
  await Promise.all([first, second]);
  expect(applied.filter(item => item.userId === userResourceId(userId)).map(item => item.content)).toEqual([oldSource.content, correction.content]);
  expect(sessions.events.filter(event => event.key === `owner-memory:${userId}`).map(event => event.operation)).toEqual(['lock', 'unlock', 'lock', 'unlock']);
});
