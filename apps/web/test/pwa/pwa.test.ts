import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { activateWaitingUpdate, registerPwaWorker } from '../../src/pwa/registration.js';
import { isNavigationRequest, navigationWithOfflineFallback, OFFLINE_SHELL_URL } from '../../src/pwa/service-worker.js';
import { initialPwaState, installAvailable, installPrompting, installed, prefersReducedMotion, updateActivating, updateAvailable } from '../../src/pwa/state.js';

describe('Android PWA contracts', () => {
  it('ships an Android install manifest and correctly sized PNG icons', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../static/manifest.webmanifest', import.meta.url), 'utf8')) as { display: string; start_url: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any maskable' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any maskable' }),
    ]));
    for (const icon of manifest.icons) {
      const contents = await readFile(new URL(`../../static${icon.src}`, import.meta.url));
      expect(contents.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  });

  it('prevents 360px shell overflow and preserves keyboard/touch affordances', async () => {
    const css = await readFile(new URL('../../static/pwa.css', import.meta.url), 'utf8');
    expect(css).toContain('.shell { box-sizing: border-box;');
    expect(css).toContain('min-block-size: 44px');
    expect(css).toContain('button:focus-visible');
  });

  it('falls back only failed document navigations to the connectivity shell', async () => {
    const navigation = { method: 'GET', mode: 'navigate', url: 'https://app.test/activities/a1' };
    expect(isNavigationRequest(navigation)).toBe(true);
    await expect(navigationWithOfflineFallback(navigation, () => Promise.reject(new Error('offline')), () => Promise.resolve(OFFLINE_SHELL_URL))).resolves.toBe('/offline.html');
    const api = { method: 'POST', mode: 'cors', url: 'https://app.test/api/actions' };
    await expect(navigationWithOfflineFallback(api, () => Promise.resolve('network action'), () => Promise.resolve('offline'))).resolves.toBe('network action');
  });

  it('keeps install and update activation explicit and honors reduced motion', () => {
    const installState = installed(installPrompting(installAvailable(initialPwaState)));
    expect(installState.install).toBe('installed');
    expect(updateActivating(updateAvailable(initialPwaState)).update).toBe('activating');
    expect(prefersReducedMotion({ prefersReducedMotion: () => true })).toBe(true);
    const messages: unknown[] = [];
    activateWaitingUpdate({ waiting: { postMessage: (message) => messages.push(message) }, addEventListener() {}, installing: null });
    expect(messages).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('observes the worker that updatefound installed, even if registration.installing changes', async () => {
    const callbacks: Record<string, () => void> = {};
    const workerCallbacks: Record<string, () => void> = {};
    const firstWorker = { state: 'installing', addEventListener(type: 'statechange', callback: () => void) { workerCallbacks[type] = callback; } };
    const secondWorker = { state: 'installing', addEventListener() {} };
    const registration = {
      waiting: null as { postMessage(message: unknown): void } | null,
      installing: firstWorker as typeof firstWorker | typeof secondWorker | null,
      addEventListener(type: 'updatefound', callback: () => void) { callbacks[type] = callback; },
    };
    const states: string[] = [];
    await registerPwaWorker({ register(url, options) { expect(url).toBe('/pwa/service-worker.js'); expect(options).toEqual({ scope: '/', type: 'module' }); return Promise.resolve(registration); } }, (state) => states.push(state.update), initialPwaState);
    callbacks.updatefound?.();
    registration.installing = secondWorker;
    registration.waiting = { postMessage() {} };
    firstWorker.state = 'installed';
    workerCallbacks.statechange?.();
    expect(states).toEqual(['available']);
  });

  it('keeps the worker policy free of mail, attachment, action, and implicit-update caches', async () => {
    const source = await readFile(new URL('../../src/pwa/service-worker.ts', import.meta.url), 'utf8');
    expect(source).toContain("cache.add(OFFLINE_SHELL_URL)");
    expect(source).not.toMatch(/cache\.(put|addAll)/);
    expect(source).not.toContain("scope.skipWaiting()");
    expect(source).not.toMatch(/attachment|action queue|workbox|serwist/i);
  });
});
