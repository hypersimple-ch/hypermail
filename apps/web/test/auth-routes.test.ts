import { describe, expect, it, vi } from 'vitest';
import { createAuthRoutes, type AuthRouteService, type RouteRequest } from '../src/auth/routes.js';

const origin = 'https://mail.example.test';
const cookies = {
  session: (token: string) => `session=${token}; Secure; HttpOnly`,
  expired: () => 'session=; Max-Age=0',
  read: (cookie: string | null) => cookie?.startsWith('session=') ? cookie.slice('session='.length) : null,
};
const request = (overrides: Partial<RouteRequest> = {}): RouteRequest => ({ method: 'POST', origin, cookie: 'session=old-token', remoteAddress: '127.0.0.1', correlationId: 'correlation', body: { currentPassword: 'current password', newPassword: 'replacement password' }, ...overrides });

function service(result: Awaited<ReturnType<AuthRouteService['rotatePassword']>>) {
  const rotatePassword = vi.fn(() => Promise.resolve(result));
  const signOut = vi.fn(() => Promise.resolve());
  const auth: AuthRouteService = {
    bootstrap: vi.fn(),
    signIn: vi.fn(),
    signOut,
    rotatePassword,
    requestRecovery: vi.fn(),
    resetPassword: vi.fn(),
  };
  return { auth, rotatePassword, signOut };
}

describe('authenticated password route', () => {
  it('requires POST, exact same origin, and an active cookie before service work', async () => {
    const { auth, rotatePassword } = service({ ok: true, token: 'fresh-token' });
    const routes = createAuthRoutes(auth, cookies, origin);

    await expect(routes.password(request({ method: 'GET' }))).resolves.toMatchObject({ status: 403 });
    await expect(routes.password(request({ origin: 'https://evil.example' }))).resolves.toMatchObject({ status: 403 });
    await expect(routes.password(request({ cookie: null }))).resolves.toEqual({ status: 401, body: { error: 'invalid_credentials' } });
    expect(rotatePassword).not.toHaveBeenCalled();
  });

  it('rotates the session cookie without reflecting password values', async () => {
    const { auth, rotatePassword } = service({ ok: true, token: 'fresh-token' });
    const routes = createAuthRoutes(auth, cookies, origin);

    const response = await routes.password(request());

    expect(rotatePassword).toHaveBeenCalledWith('old-token', 'current password', 'replacement password', '127.0.0.1', 'correlation');
    expect(response).toEqual({ status: 200, body: { status: 'ok' }, setCookie: 'session=fresh-token; Secure; HttpOnly' });
    expect(JSON.stringify(response)).not.toContain('current password');
    expect(JSON.stringify(response)).not.toContain('replacement password');
  });

  it('revokes the active session and clears its cookie on sign out', async () => {
    const { auth, signOut } = service({ ok: true, token: 'unused' });
    const routes = createAuthRoutes(auth, cookies, origin);

    await expect(routes.logout(request())).resolves.toEqual({ status: 204, body: {}, setCookie: 'session=; Max-Age=0' });
    expect(signOut).toHaveBeenCalledWith('old-token', 'correlation');
    await expect(routes.logout(request({ origin: 'https://evil.example' }))).resolves.toMatchObject({ status: 403 });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps failures generic and distinguishes only throttling status', async () => {
    const invalid = createAuthRoutes(service({ ok: false, reason: 'invalid_credentials' }).auth, cookies, origin);
    const throttled = createAuthRoutes(service({ ok: false, reason: 'throttled' }).auth, cookies, origin);

    await expect(invalid.password(request())).resolves.toEqual({ status: 401, body: { error: 'invalid_credentials' } });
    await expect(throttled.password(request())).resolves.toEqual({ status: 429, body: { error: 'invalid_credentials' } });
  });
});
