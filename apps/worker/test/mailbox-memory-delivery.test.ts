import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { MailboxMemory } from '@hypermail/agent';
import type { ClaimedMailboxMemoryEvent, MailboxMemoryEvent, MailboxMemoryEventStore } from '@hypermail/db';
import { MailboxCurrentEmailRetainer, MailboxMemoryEventDeliveryWorker, type HydratedMailboxMessage } from '../src/mailbox-memory-delivery.js';

const userId = '00000000-0000-4000-8000-000000000001';
const mailboxId = '00000000-0000-4000-8000-000000000002';
const messageId = '00000000-0000-4000-8000-000000000003';
const attachmentId = '00000000-0000-4000-8000-000000000004';
const eventId = '00000000-0000-4000-8000-000000000005';
const occurredAt = '2026-01-01T00:00:00.000Z';

function memory(calls: string[], failFile = false): MailboxMemory {
  return {
    retain: () => { calls.push('email'); return Promise.resolve(); },
    recall: () => Promise.resolve({ entries: [] }),
    retainFile: (input) => { calls.push(`file:${input.filename}:${String(input.file.size)}`); return failFile ? Promise.reject(new Error('provider outage')) : Promise.resolve(); },
    deleteMailbox: () => Promise.resolve(), readiness: () => Promise.resolve({ version: '1.0.0' }),
  };
}

const input = (attachments: Array<{ sourceId: string; providerAttachmentId: string; filename: string; mediaType: string; sizeBytes: number }>) => ({
  scope: { userId, mailboxId }, canonicalMessageId: messageId, providerMessageId: 'provider-message',
  accountEmail: 'mailbox@example.test', receivedAt: occurredAt,
  message: { id: 'provider-message', account: 'mailbox@example.test', subject: 'subject', body: 'complete body', bodyFormat: 'text' as const },
  attachments,
});

const opened = (bytes: Uint8Array, cleanup: () => void) => ({
  metadata: { id: 'provider-attachment', name: 'document.pdf' }, contentDisposition: 'attachment',
  stream: Readable.from([bytes]), cleanup: () => { cleanup(); return Promise.resolve(); }, cancel: () => Promise.resolve(),
});

describe('MailboxCurrentEmailRetainer', () => {
  it('uploads direct and scanned PDFs as opaque files and waits before returning', async () => {
    const calls: string[] = []; let cleanups = 0;
    const retainer = new MailboxCurrentEmailRetainer(memory(calls), { tempDirectory: '/private/attachments', maxBytes: 10 });
    const attachments = [
      { sourceId: attachmentId, providerAttachmentId: 'direct', filename: 'direct.pdf', mediaType: 'application/pdf', sizeBytes: 3 },
      { sourceId: '00000000-0000-4000-8000-000000000006', providerAttachmentId: 'scan', filename: 'scan.pdf', mediaType: 'application/pdf', sizeBytes: 3 },
    ];
    const client = { openAttachment: () => Promise.resolve(opened(Uint8Array.from([1, 2, 3]), () => { cleanups++; }) as never) };
    await expect(retainer.retainCurrentEmail({ ...input(attachments), client })).resolves.toEqual({ attachmentsRetained: 2, attachmentsSkipped: [] });
    expect(calls).toEqual(['email', 'file:direct.pdf:3', 'file:scan.pdf:3']);
    expect(cleanups).toBe(2);
  });

  it('shares one in-process retention across the automatic and durable delivery paths', async () => {
    const calls: string[] = []; let opens = 0;
    const retainer = new MailboxCurrentEmailRetainer(memory(calls), { tempDirectory: '/private/attachments', maxBytes: 10 });
    const attachment = { sourceId: attachmentId, providerAttachmentId: 'pdf', filename: 'doc.pdf', mediaType: 'application/pdf', sizeBytes: 3 };
    const client = { openAttachment: () => { opens++; return Promise.resolve(opened(Uint8Array.from([1, 2, 3]), () => undefined) as never); } };
    const request = { ...input([attachment]), client };
    const [automatic, durable] = await Promise.all([retainer.retainCurrentEmail(request), retainer.retainCurrentEmail(request)]);
    expect(automatic).toEqual(durable);
    expect(opens).toBe(1);
    expect(calls).toEqual(['email', 'file:doc.pdf:3']);
  });

  it('retains email while bounding unsupported and oversized skip metadata without opening files', async () => {
    const calls: string[] = []; let openedCount = 0;
    const retainer = new MailboxCurrentEmailRetainer(memory(calls), { tempDirectory: '/private/attachments', maxBytes: 3 });
    const attachments = [
      { sourceId: attachmentId, providerAttachmentId: 'binary', filename: 'payload.bin', mediaType: 'application/octet-stream', sizeBytes: 1 },
      { sourceId: '00000000-0000-4000-8000-000000000006', providerAttachmentId: 'large', filename: 'large.pdf', mediaType: 'application/pdf', sizeBytes: 4 },
    ];
    const result = await retainer.retainCurrentEmail({ ...input(attachments), client: { openAttachment: () => { openedCount++; return Promise.reject(new Error('must not open')); } } });
    expect(calls).toEqual(['email']); expect(openedCount).toBe(0);
    expect(result.attachmentsSkipped).toEqual([{ sourceId: attachmentId, reason: 'unsupported' },
      { sourceId: '00000000-0000-4000-8000-000000000006', reason: 'oversized' }]);
  });

  it('cleans materialized bytes when streaming is cancelled', async () => {
    const calls: string[] = []; let cleaned = false;
    const retainer = new MailboxCurrentEmailRetainer(memory(calls), { tempDirectory: '/private/attachments', maxBytes: 10 });
    const attachment = { sourceId: attachmentId, providerAttachmentId: 'pdf', filename: 'doc.pdf', mediaType: 'application/pdf', sizeBytes: 3 };
    const stream = new Readable({ read() { this.destroy(new Error('cancelled')); } });
    const materialized = { metadata: { id: 'pdf', name: 'doc.pdf' }, contentDisposition: 'attachment', stream,
      cleanup: () => { cleaned = true; return Promise.resolve(); }, cancel: () => Promise.resolve() };
    await expect(retainer.retainCurrentEmail({ ...input([attachment]), client: { openAttachment: () => Promise.resolve(materialized as never) } })).rejects.toThrow('cancelled');
    expect(cleaned).toBe(true);
  });

  it('cleans materialized bytes when Hindsight upload fails', async () => {
    const calls: string[] = []; let cleaned = false;
    const retainer = new MailboxCurrentEmailRetainer(memory(calls, true), { tempDirectory: '/private/attachments', maxBytes: 10 });
    const attachment = { sourceId: attachmentId, providerAttachmentId: 'pdf', filename: 'doc.pdf', mediaType: 'application/pdf', sizeBytes: 3 };
    await expect(retainer.retainCurrentEmail({ ...input([attachment]), client: { openAttachment: () => Promise.resolve(opened(Uint8Array.from([1, 2, 3]), () => { cleaned = true; }) as never) } })).rejects.toThrow('outage');
    expect(cleaned).toBe(true);
  });
});

const baseEvent: MailboxMemoryEvent = {
  id: eventId, userId, mailboxId, sourceType: 'message', sourceId: messageId, sourceVersion: 1,
  kind: 'email_received', contentDigest: 'a'.repeat(64), contentPayload: {}, state: 'processing', attemptCount: 1,
  maxAttempts: 8, claimGeneration: 1, availableAt: occurredAt, occurredAt, completedAt: null, deadLetteredAt: null,
  resultMetadata: null, lastErrorCode: null, lastErrorMetadata: null, createdAt: occurredAt, updatedAt: occurredAt,
};
const claim: ClaimedMailboxMemoryEvent = { event: baseEvent, fence: { eventId, userId, mailboxId, generation: 1, token: '00000000-0000-4000-8000-000000000006' } };
const hydrated: HydratedMailboxMessage = { userId, mailboxId, accountEmail: 'mailbox@example.test', canonicalMessageId: messageId,
  providerMessageId: 'provider-message', receivedAt: occurredAt, attachments: [] };

describe('MailboxMemoryEventDeliveryWorker', () => {
  it('defers a sanitized outage and completes the same durable event after recovery', async () => {
    const actions: string[] = []; let available = false;
    const store = {
      claim: () => Promise.resolve([claim]), recoverExpiredClaims: () => Promise.resolve(0), renew: () => Promise.resolve(), enqueue: () => Promise.reject(new Error()),
      complete: () => { actions.push('complete'); return Promise.resolve({ ...baseEvent, state: 'completed' as const }); },
      defer: (_fence, failure) => { actions.push(`defer:${failure.code}`); return Promise.resolve({ ...baseEvent, state: 'pending' as const }); },
    } satisfies MailboxMemoryEventStore;
    const worker = new MailboxMemoryEventDeliveryWorker(store, { isMailboxReady: () => Promise.resolve(true), hydrate: () => Promise.resolve(hydrated) },
      { clientForUser: () => ({ initialize: () => Promise.resolve(),
        readMessage: () => available ? Promise.resolve({ id: 'provider-message', account: 'mailbox@example.test', body: 'body' }) : Promise.reject(new Error('secret provider response')),
        openAttachment: () => Promise.reject(new Error('unused')) }) },
      { retainCurrentEmail: () => Promise.resolve({ attachmentsRetained: 0, attachmentsSkipped: [] }), retainGenericEvent: () => Promise.resolve() }, 'worker');
    await worker.runOnce(); available = true; await worker.runOnce();
    expect(actions).toEqual(['defer:MAILBOX_MEMORY_DEPENDENCY_UNAVAILABLE', 'complete']);
  });

  it('retains generic decision events without provider hydration and completes their exact event identity', async () => {
    const generic = { ...baseEvent, id: '00000000-0000-4000-8000-000000000007', kind: 'question_answered',
      sourceType: 'question', contentPayload: { answer: 'Keep future invoices' } };
    const genericClaim = { event: generic, fence: { ...claim.fence, eventId: generic.id } };
    const retained: MailboxMemoryEvent[] = []; const completions: unknown[] = [];
    const store = { claim: () => Promise.resolve([genericClaim]), recoverExpiredClaims: () => Promise.resolve(0), renew: () => Promise.resolve(), enqueue: () => Promise.reject(new Error()),
      complete: (_fence, metadata) => { completions.push(metadata); return Promise.resolve({ ...generic, state: 'completed' as const }); },
      defer: () => Promise.resolve(generic) } satisfies MailboxMemoryEventStore;
    const worker = new MailboxMemoryEventDeliveryWorker(store, { isMailboxReady: () => Promise.resolve(true), hydrate: () => Promise.reject(new Error('must not hydrate')) },
      { clientForUser: () => { throw new Error('must not open provider'); } },
      { retainCurrentEmail: () => Promise.reject(new Error('must not retain email')), retainGenericEvent: (event) => { retained.push(event); return Promise.resolve(); } }, 'worker');
    await worker.runOnce();
    expect(retained).toEqual([generic]);
    expect(completions).toEqual([{ kind: 'question_answered' }]);
  });

  it('defers without external I/O when the Mailbox was disabled after claim', async () => {
    const actions: string[] = [];
    const store = { claim: () => Promise.resolve([claim]), recoverExpiredClaims: () => Promise.resolve(0), renew: () => Promise.resolve(), enqueue: () => Promise.reject(new Error()),
      complete: () => Promise.reject(new Error('must not complete')), defer: (_fence, failure) => { actions.push(failure.code); return Promise.resolve(baseEvent); } } satisfies MailboxMemoryEventStore;
    const worker = new MailboxMemoryEventDeliveryWorker(store, { isMailboxReady: () => Promise.resolve(false), hydrate: () => Promise.reject(new Error('must not hydrate')) },
      { clientForUser: () => { throw new Error('must not contact provider'); } },
      { retainCurrentEmail: () => Promise.reject(new Error('must not retain')), retainGenericEvent: () => Promise.reject(new Error('must not retain')) }, 'worker');
    await worker.runOnce();
    expect(actions).toEqual(['MAILBOX_MEMORY_MAILBOX_INACTIVE']);
  });

  it('passes only the claimed tenant to hydration and the private tenant client', async () => {
    const tenants: string[] = [];
    const store = { claim: () => Promise.resolve([claim]), recoverExpiredClaims: () => Promise.resolve(0), renew: () => Promise.resolve(), enqueue: () => Promise.reject(new Error()),
      complete: () => Promise.resolve({ ...baseEvent, state: 'completed' as const }), defer: () => Promise.resolve(baseEvent) } satisfies MailboxMemoryEventStore;
    const worker = new MailboxMemoryEventDeliveryWorker(store, { isMailboxReady: () => Promise.resolve(true), hydrate: (event) => { tenants.push(`${event.userId}:${event.mailboxId}`); return Promise.resolve(hydrated); } },
      { clientForUser: (requestedUser) => { tenants.push(requestedUser); return { initialize: () => Promise.resolve(),
        readMessage: () => Promise.resolve({ id: 'provider-message', account: 'mailbox@example.test' }), openAttachment: () => Promise.reject(new Error('unused')) }; } },
      { retainCurrentEmail: () => Promise.resolve({ attachmentsRetained: 0, attachmentsSkipped: [] }), retainGenericEvent: () => Promise.resolve() }, 'worker');
    await worker.runOnce();
    expect(tenants).toEqual([`${userId}:${mailboxId}`, userId]);
  });
});
