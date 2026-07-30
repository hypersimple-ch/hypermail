import type { IncomingMessage } from 'node:http';

export type LimitResult = Readonly<{ status: 413 | 429; message: 'Payload too large' | 'Too many requests' }> | null;

/** Bounded in-memory edge throttle for this static host. API/auth throttles remain authoritative in their packages. */
export class RequestThrottle {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly limit = 120, private readonly windowMs = 60_000, private readonly maxSubjects = 1_024, private readonly now: () => number = () => Date.now()) {}
  take(subject: string): boolean {
    const now = this.now();
    const existing = this.buckets.get(subject);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      if (this.buckets.size >= this.maxSubjects) this.buckets.delete(this.buckets.keys().next().value as string);
      this.buckets.set(subject, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.limit;
  }
}

export function requestLimit(request: IncomingMessage, throttle: RequestThrottle): LimitResult {
  const length = request.headers['content-length'];
  const contentLength = typeof length === 'string' ? Number(length) : 0;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 8_192 || request.headers['transfer-encoding']) return { status: 413, message: 'Payload too large' };
  if (!throttle.take(request.socket.remoteAddress ?? 'unknown')) return { status: 429, message: 'Too many requests' };
  return null;
}
