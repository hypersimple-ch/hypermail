import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { expect, it } from 'vitest';
import { MastraSourceHistory, activityThreadId, userResourceId } from '../src/index.js';

it('keeps legacy history persisted while scoped Mastra resources contain only their own owner sources', async () => {
  const memory = new Memory({ storage: new InMemoryStore({ id: randomUUID() }), options: { semanticRecall: false } });
  const history = new MastraSourceHistory(memory);
  const userId = randomUUID();
  const accounts = [randomUUID(), randomUUID()];
  const legacyResource = `user:${userId}`;
  const globalResource = userResourceId(userId, { scope: 'global' });
  const sources = [
    { resourceId: legacyResource, threadId: 'legacy', text: 'Opaque mixed legacy observation' },
    ...accounts.map((accountId, index) => ({ resourceId: userResourceId(userId, { scope: 'mailbox', accountId }),
      threadId: activityThreadId(userId, accountId, randomUUID()), text: `Private owner instruction ${String(index)}` })),
    { resourceId: globalResource, threadId: `${globalResource}:conversation`, text: 'Explicit global owner instruction' },
  ];
  for (const source of sources) { await history.append(source); await history.append(source); }
  for (const source of sources) {
    const threads = await memory.listThreads({ filter: { resourceId: source.resourceId } });
    expect(threads.threads.map(thread => thread.id)).toEqual([source.threadId]);
    const recalled = await memory.recall({ threadId: source.threadId, resourceId: source.resourceId });
    expect(recalled.messages.map(message => message.content.parts)).toEqual([[{ type: 'text', text: source.text }]]);
  }
});
