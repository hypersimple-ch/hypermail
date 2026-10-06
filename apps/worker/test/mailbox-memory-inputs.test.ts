import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { MailboxMemoryUnavailableError, type SourceHistory } from '@hypermail/agent';
import { MailboxOwnerMemoryInputs } from '../src/mailbox-memory-inputs.js';

it('blocks owner context reconstruction until earlier deliveries have completed', async () => {
  let pending = true;
  let reads = 0;
  const appended: Parameters<SourceHistory['append']>[0][] = [];
  const input = { userId: randomUUID(), accountId: randomUUID(), acceptedBefore: new Date('2026-01-01T00:00:00Z') };
  const source = { id: randomUUID(), scope: 'global' as const, content: 'Keep global receipts', createdAt: '2025-12-01T00:00:00Z' };
  const barrier = new MailboxOwnerMemoryInputs({
    hasPendingOwnerContext: () => Promise.resolve(pending),
    ownerSources: () => { reads += 1; return Promise.resolve([source]); },
    globalOwnerSources: () => Promise.resolve([]),
  }, { append: value => { appended.push(value); return Promise.resolve(); } });
  await expect(barrier.prepare(input)).rejects.toBeInstanceOf(MailboxMemoryUnavailableError);
  expect(reads).toBe(0);
  expect(appended).toEqual([]);
  pending = false;
  await barrier.prepare(input);
  expect(appended[0]?.resourceId).toBe(`user:${input.userId}:mailbox:${input.accountId}:v2`);
  expect(JSON.parse(appended[0]?.text ?? 'null')).toEqual({ sourceId: source.id, provenance: 'user', scope: 'global', content: source.content, createdAt: source.createdAt });
});

it.each(['barrier', 'sources', 'history'] as const)('fails closed on %s outages', async stage => {
  const unavailable = new Error('unavailable');
  const barrier = new MailboxOwnerMemoryInputs({
    hasPendingOwnerContext: () => stage === 'barrier' ? Promise.reject(unavailable) : Promise.resolve(false),
    ownerSources: () => stage === 'sources' ? Promise.reject(unavailable) : Promise.resolve([
      { id: randomUUID(), scope: 'mailbox' as const, content: 'Private local owner instruction', createdAt: '2025-12-01T00:00:00Z' },
    ]),
    globalOwnerSources: () => Promise.resolve([]),
  }, { append: () => Promise.reject(unavailable) });
  await expect(barrier.prepare({ userId: randomUUID(), accountId: randomUUID(), acceptedBefore: new Date() }))
    .rejects.toMatchObject({ code: 'MAILBOX_MEMORY_UNAVAILABLE', retryable: true });
});
