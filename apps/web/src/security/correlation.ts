import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const VALID_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/** Accept only opaque, bounded IDs; never reflect arbitrary request data into headers or logs. */
export function correlationId(headers: IncomingHttpHeaders): string {
  const candidate = headers['x-correlation-id'];
  const value = Array.isArray(candidate) ? undefined : candidate;
  return value && VALID_CORRELATION_ID.test(value) ? value : randomUUID();
}
