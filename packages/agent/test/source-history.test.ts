import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { expect, it } from 'vitest';
import { MastraSourceHistory, activityThreadId, conversationThreadId, userResourceId } from '../src/index.js';

it('shares an owner profile while persisting isolated conversation and activity sources without replay duplicates', async () => {
  const memory = new Memory({ storage: new InMemoryStore({ id: randomUUID() }), options: { semanticRecall: false } });
  const history = new MastraSourceHistory(memory);
  const userId = randomUUID();
  const accounts = [randomUUID(), randomUUID()];
  const legacyResource = `user:${userId}`;
  const resourceId = userResourceId(userId);
  const otherUserId = randomUUID();
  const sources = [
    { resourceId: legacyResource, threadId: 'legacy', text: 'Opaque mixed legacy observation' },
    ...accounts.map((accountId, index) => ({ resourceId,
      threadId: activityThreadId(userId, accountId, randomUUID()), text: `Private owner instruction ${String(index)}` })),
    { resourceId, threadId: conversationThreadId(userId, randomUUID()), text: 'Explicit global owner instruction' },
    { resourceId, threadId: conversationThreadId(userId, randomUUID()), text: 'Separate conversation task' },
    { resourceId: userResourceId(otherUserId), threadId: conversationThreadId(otherUserId, randomUUID()),
      text: 'Another owner private instruction' },
  ];
  for (const source of sources) { await history.append(source); await history.append(source); }
  const ownerThreads = await memory.listThreads({ filter: { resourceId } });
  expect(ownerThreads.threads.map(thread => thread.id).sort()).toEqual(
    sources.filter(source => source.resourceId === resourceId).map(source => source.threadId).sort());
  const otherOwnerThreads = await memory.listThreads({ filter: { resourceId: userResourceId(otherUserId) } });
  expect(otherOwnerThreads.threads.map(thread => thread.id)).toEqual([sources.at(-1)?.threadId]);
  for (const source of sources) {
    const recalled = await memory.recall({ threadId: source.threadId, resourceId: source.resourceId });
    expect(recalled.messages.map(message => message.content.parts)).toEqual([[{ type: 'text', text: source.text }]]);
  }
});

it('refuses observation when the configured native engine is absent', async () => {
  const memory = new Memory({ storage: new InMemoryStore({ id: randomUUID() }), options: { semanticRecall: false } });
  const history = new MastraSourceHistory(memory);
  await expect(history.observe({ resourceId: userResourceId(randomUUID()), threadId: randomUUID() }))
    .rejects.toThrow('OBSERVATIONAL_MEMORY_REQUIRED');
});
