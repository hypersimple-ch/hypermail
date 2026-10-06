import type { IncomingMessage } from 'node:http';

export type LimitResult = Readonly<{ status: 400 | 413 | 429; message: 'Invalid request' | 'Payload too large' | 'Too many requests' }> | null;

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

export function requestBodyLimit(request: Pick<IncomingMessage, 'method' | 'url'>): number {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/mcp') return 512 * 1024;
  if (request.method === 'POST' && /^\/api\/v1\/conversations(?:\/[^/]+\/messages)?$/.test(pathname)) return 65_536;
  if (['POST', 'PATCH', 'PUT'].includes(request.method ?? '') && (
    /^\/api\/v1\/drafts(?:\/[^/]+(?:\/approval)?|\/approvals\/[^/]+\/send)?$/.test(pathname) ||
    /^\/api\/v1\/send-requests(?:\/[^/]+(?:\/approval|\/approvals\/[^/]+\/confirm)?)?$/.test(pathname) ||
    /^\/api\/v1\/agent\/proposals\/[^/]+\/review$/.test(pathname)
  )) return 12_100_000;
  return 8_192;
}

export function requestLimit(request: IncomingMessage, throttle: RequestThrottle, clientIp = request.socket.remoteAddress ?? 'unknown'): LimitResult {
  const length = request.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return { status: 400, message: 'Invalid request' };
  if (length !== undefined && Number(length) > requestBodyLimit(request)) return { status: 413, message: 'Payload too large' };
  if (!throttle.take(clientIp)) return { status: 429, message: 'Too many requests' };
  return null;
}
