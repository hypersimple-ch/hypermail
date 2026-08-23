import { mailboxMemoryTextEvidence, type MailboxMemoryTextEvidence } from '@hypermail/db';
import type { DraftActor, DraftFields, Recipient } from './contracts.js';

/**
 * Fixed privacy and size bounds for draft evidence. Two projections plus the
 * event envelope always leave headroom below the 64 KiB memory-event cap.
 */
export const DRAFT_MEMORY_RECIPIENT_LIMIT = 20;
export const DRAFT_MEMORY_ADDRESS_MAX_BYTES = 320;
export const DRAFT_MEMORY_SUBJECT_MAX_BYTES = 998;
export const DRAFT_MEMORY_BODY_MAX_BYTES = 12 * 1024;
export const DRAFT_MEMORY_PROJECTION_MAX_BYTES = 24 * 1024;
export const DRAFT_MEMORY_CHANGE_MAX_BYTES = 2 * DRAFT_MEMORY_PROJECTION_MAX_BYTES + 20;

export type DraftMemoryProjection = Readonly<{
  creator?: DraftActor;
  recipients: readonly Readonly<Pick<Recipient, 'kind' | 'address'>>[];
  subject: MailboxMemoryTextEvidence;
  body: MailboxMemoryTextEvidence;
  bodyFormat: DraftFields['bodyFormat'];
}>;

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Return the longest code-point-safe prefix within a UTF-8 byte limit. */
function utf8Prefix(value: string, maximumBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function evidencePrefix(evidence: MailboxMemoryTextEvidence, maximumBytes: number): MailboxMemoryTextEvidence {
  const text = utf8Prefix(evidence.text, maximumBytes);
  return { ...evidence, text, truncated: evidence.truncated || text !== evidence.text };
}

function fitEvidence(
  projection: DraftMemoryProjection,
  key: 'body' | 'subject',
): DraftMemoryProjection {
  const evidence = projection[key];
  let low = 0;
  let high = Buffer.byteLength(evidence.text, 'utf8');
  let result = { ...projection, [key]: evidencePrefix(evidence, 0) };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...projection, [key]: evidencePrefix(evidence, middle) };
    if (encodedBytes(candidate) <= DRAFT_MEMORY_PROJECTION_MAX_BYTES) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

/**
 * Project canonical draft fields into bounded learning evidence. Canonical
 * draft data is never changed. Digests always cover the complete input text.
 */
export function draftMemoryProjection(fields: DraftFields, creator?: DraftActor): DraftMemoryProjection {
  let projection: DraftMemoryProjection = {
    ...(creator === undefined ? {} : { creator }),
    recipients: fields.recipients.slice(0, DRAFT_MEMORY_RECIPIENT_LIMIT).map(({ kind, address }) => ({
      kind,
      address: utf8Prefix(address, DRAFT_MEMORY_ADDRESS_MAX_BYTES),
    })),
    subject: mailboxMemoryTextEvidence(fields.subject, DRAFT_MEMORY_SUBJECT_MAX_BYTES),
    body: mailboxMemoryTextEvidence(fields.body, DRAFT_MEMORY_BODY_MAX_BYTES),
    bodyFormat: fields.bodyFormat,
  };
  if (encodedBytes(projection) > DRAFT_MEMORY_PROJECTION_MAX_BYTES) projection = fitEvidence(projection, 'body');
  if (encodedBytes(projection) > DRAFT_MEMORY_PROJECTION_MAX_BYTES) projection = fitEvidence(projection, 'subject');
  if (encodedBytes(projection) > DRAFT_MEMORY_PROJECTION_MAX_BYTES) {
    throw new Error('Draft memory projection fixed fields exceed their reserved payload budget.');
  }
  return projection;
}

/** Reserve two equal, deterministic partitions for correction evidence. */
export function draftMemoryChangeProjection(before: DraftFields, after: DraftFields): Readonly<{
  before: DraftMemoryProjection;
  after: DraftMemoryProjection;
}> {
  return { before: draftMemoryProjection(before), after: draftMemoryProjection(after) };
}
