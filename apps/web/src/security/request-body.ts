import type { IncomingMessage, ServerResponse } from 'node:http';

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) { super('Invalid request body'); }
}

/** Read once, count actual bytes (including chunked), and stop consuming on failure. */
export function readRequestBytes(request: IncomingMessage, maximum: number, timeoutMs = 30_000): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = []; let size = 0;
  const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', failed); };
  const failed = (error: Error) => { cleanup(); request.pause(); reject(error); };
  const aborted = () => { failed(new RequestBodyError(400)); };
  const data = (part: Buffer | string) => {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maximum) { failed(new RequestBodyError(413)); return; }
    chunks.push(chunk);
  };
  const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
  const timer = setTimeout(() => { failed(new RequestBodyError(408)); }, timeoutMs);
  timer.unref();
  request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', failed);
  return promise;
}

/** Flush the error response before closing, without draining an unbounded attacker body. */
export function closeRejectedBody(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Connection', 'close');
  response.once('finish', () => { request.socket.destroySoon(); });
}
