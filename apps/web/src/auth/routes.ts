/** Framework-neutral route contract. A Next/Fetch adapter supplies request parsing and headers. */
export type RouteRequest = Readonly<{
  method: string;
  origin: string | null;
  cookie: string | null;
  remoteAddress: string;
  correlationId: string;
  body: Readonly<Record<string, unknown>>;
}>;
export type RouteResponse = Readonly<{ status: number; body: Readonly<Record<string, string>>; setCookie?: string }>;

type LoginResult = { ok: true; token: string } | { ok: false; reason: string };
export interface AuthRouteService {
  bootstrap(email: string, password: string, correlationId: string): Promise<LoginResult>;
  signIn(email: string, password: string, subject: string, correlationId: string): Promise<LoginResult>;
  signOut(token: string, correlationId: string): Promise<void>;
  rotatePassword(token: string, currentPassword: string, newPassword: string, subject: string, correlationId: string): Promise<LoginResult>;
  requestRecovery(email: string, subject: string, correlationId: string): Promise<void>;
  resetPassword(token: string, password: string, correlationId: string): Promise<LoginResult>;
}
export interface AuthCookieContract { session(token: string): string; expired(): string; read(cookie: string | null): string | null; }

/** Routes intentionally return generic recovery responses and never reflect credentials or tokens. */
export function createAuthRoutes(service: AuthRouteService, cookies: AuthCookieContract, appOrigin: string) {
  const protectedMutation = (request: RouteRequest): RouteResponse | null =>
    request.method !== 'POST' || request.origin !== appOrigin
      ? { status: 403, body: { error: 'forbidden' } }
      : null;
  const text = (body: Readonly<Record<string, unknown>>, key: string): string => typeof body[key] === 'string' ? body[key] : '';

  return {
    async bootstrap(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      const result = await service.bootstrap(text(request.body, 'email'), text(request.body, 'password'), request.correlationId);
      return result.ok ? { status: 201, body: { status: 'ok' }, setCookie: cookies.session(result.token) } : { status: result.reason === 'bootstrap_locked' ? 409 : 401, body: { error: 'unable_to_bootstrap' } };
    },
    async login(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      const result = await service.signIn(text(request.body, 'email'), text(request.body, 'password'), request.remoteAddress, request.correlationId);
      return result.ok ? { status: 200, body: { status: 'ok' }, setCookie: cookies.session(result.token) } : { status: result.reason === 'throttled' ? 429 : 401, body: { error: 'invalid_credentials' } };
    },
    async logout(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      const token = cookies.read(request.cookie); if (token) await service.signOut(token, request.correlationId);
      return { status: 204, body: {}, setCookie: cookies.expired() };
    },
    async password(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      const token = cookies.read(request.cookie);
      if (!token) return { status: 401, body: { error: 'invalid_credentials' } };
      const result = await service.rotatePassword(token, text(request.body, 'currentPassword'), text(request.body, 'newPassword'), request.remoteAddress, request.correlationId);
      return result.ok ? { status: 200, body: { status: 'ok' }, setCookie: cookies.session(result.token) } : { status: result.reason === 'throttled' ? 429 : 401, body: { error: 'invalid_credentials' } };
    },
    async recovery(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      await service.requestRecovery(text(request.body, 'email'), request.remoteAddress, request.correlationId);
      return { status: 202, body: { status: 'if_an_account_exists_a_message_was_sent' } };
    },
    async reset(request: RouteRequest): Promise<RouteResponse> {
      const denied = protectedMutation(request); if (denied) return denied;
      const result = await service.resetPassword(text(request.body, 'token'), text(request.body, 'password'), request.correlationId);
      return result.ok ? { status: 200, body: { status: 'ok' }, setCookie: cookies.session(result.token) } : { status: 400, body: { error: 'invalid_or_expired_recovery' } };
    },
  };
}

/** Executable Playwright-equivalent scenario inventory for a later browser harness. */
export const playwrightRouteScenarios = [
  'POST /auth/login rejects a missing or cross-site Origin',
  'POST /auth/login throttles after repeated failures without changing its credential error body',
  'POST /auth/recovery returns the same 202 body for known and unknown accounts',
  'POST /auth/reset consumes a recovery token once and expires all prior sessions',
  'POST /auth/logout clears the __Host-hypermail_session cookie',
  'POST /auth/password verifies the current password, revokes prior sessions, and rotates the session cookie',
] as const;
