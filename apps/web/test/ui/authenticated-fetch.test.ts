// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch, SessionExpiredError } from '../../src/lib/authenticated-fetch.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('authenticated requests', () => {
  it('shares validation for concurrent failures and never replays mutations', async () => {
    const validation = Promise.withResolvers<Response>();
    let validations = 0, mutations = 0;
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/api/v1/session') { validations++; return validation.promise; }
      mutations++; return Promise.resolve(new Response(null, { status: 401 }));
    }));
    const expired = vi.fn();
    window.addEventListener('hypermail:session-expired', expired);
    try {
      const outcomes = Promise.allSettled([
        authenticatedFetch('/api/v1/drafts', { method: 'POST' }),
        authenticatedFetch('/api/v1/auth/password', { method: 'POST' }),
      ]);
      await vi.waitFor(() => { expect(validations).toBe(1); });
      validation.resolve(new Response(null, { status: 401 }));
      const results = await outcomes;
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(SessionExpiredError);
      }
      expect(expired).toHaveBeenCalledTimes(1);
      expect(mutations).toBe(2);
      await expect(authenticatedFetch('/api/v1/drafts')).rejects.toThrow('Your session expired. Sign in to continue.');
      expect(validations).toBe(2);
    } finally { window.removeEventListener('hypermail:session-expired', expired); }
  });

  it.each(['valid', 'unavailable', 'network'] as const)('preserves the original 401 when validation is %s', async state => {
    const original = Response.json({ error: { code: 'FRESH_AUTH_REQUIRED' } }, { status: 401 });
    vi.stubGlobal('fetch', vi.fn((path: string) => path === '/api/v1/session'
      ? state === 'network' ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: state === 'valid' ? 200 : 503 }))
      : Promise.resolve(original)));
    const expired = vi.fn();
    window.addEventListener('hypermail:session-expired', expired);
    try {
      const response = await authenticatedFetch('/api/v1/auth/reauthenticate', { method: 'POST' });
      expect(response).toBe(original);
      expect(await response.json()).toEqual({ error: { code: 'FRESH_AUTH_REQUIRED' } });
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener('hypermail:session-expired', expired); }
  });
});
