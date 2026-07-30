/**
 * Framework-neutral Better Auth route adapter. Pass the handler exported by
 * @hypermail/auth to a Fetch-compatible server without importing Next.js.
 */
export type BetterAuthFetchHandler = (request: Request) => Promise<Response>;

export function createBetterAuthRoute(handler: BetterAuthFetchHandler) {
  return {
    GET: handler,
    POST: handler,
  } as const;
}
