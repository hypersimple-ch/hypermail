import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { activateWaitingUpdate, registerPwaWorker } from '../../src/pwa/registration.js';
import { isNavigationRequest, navigationWithOfflineFallback, OFFLINE_SHELL_URL } from '../../src/pwa/service-worker.js';
import { initialPwaState, installAvailable, installPrompting, installed, prefersReducedMotion, updateActivating, updateAvailable } from '../../src/pwa/state.js';

const browserSource = () => readFile(new URL('../../src/browser.tsx', import.meta.url), 'utf8');
const webPackage = async () => JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } };

describe('Android PWA contracts', () => {
  it('ships an Android install manifest and correctly sized PNG icons', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../static/manifest.webmanifest', import.meta.url), 'utf8')) as { display: string; start_url: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any maskable' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any maskable' }),
    ]));
    for (const icon of manifest.icons) expect((await readFile(new URL(`../../static${icon.src}`, import.meta.url))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('forces clean server emission and verifies every runtime asset during the production build', async () => {
    const build = (await webPackage()).scripts.build;
    expect(build).toContain('rm -rf dist && tsc -b tsconfig.json --force');
    for (const artifact of ['dist/index.js', 'dist/app.js', 'dist/app.css']) {
      expect(build).toContain(`test -f ${artifact}`);
    }
  });

  it('keeps the Node entrypoint separate from browser-only UI modules', async () => {
    const entrypoint = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(entrypoint).not.toContain("export * from './ui/index.js'");
    expect(entrypoint).not.toContain("from '@/");
  });

  it('keeps the static shell to document metadata, the React root, app.css, and the application script', async () => {
    const html = await readFile(new URL('../../static/index.html', import.meta.url), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).not.toContain('pwa.css');
    expect(html).not.toContain('Application utilities');
  });

  it('renders loading, authentication, connectivity, install, and update presentation with shared JSX primitives', async () => {
    const browser = await browserSource();
    for (const primitive of ['Toast', 'Button', 'Card', 'Field', 'Input', 'Spinner']) expect(browser).toContain(`@/components/heroui/${primitive.toLowerCase()}`);
    expect(browser).toContain('function AuthCard');
    expect(browser).toContain('<Spinner className="size-6" />');
    expect(browser).toContain('role="status" aria-live="polite"');
    expect(browser).toContain('aria-label="Application utilities"');
    expect(browser).toContain('<Button type="button" variant="outline" onClick={install}>Install Hypermail</Button>');
    expect(browser).toContain('<Button type="button" variant="outline" onClick={update}>Reload to update</Button>');
    expect(browser).not.toContain('React.createElement');
  });

  it('keeps first-run setup private and validated in the shared form controls', async () => {
    const browser = await browserSource();
    expect(browser).toContain('fetch(\'/api/v1/auth/bootstrap\'');
    expect(browser).toContain('response.status === 201');
    expect(browser).toContain('response.status === 409');
    expect(browser).toContain('<FieldSet disabled={pending}>');
    expect(browser).toContain('autoComplete="new-password"');
    expect(browser).toContain('minLength={12} maxLength={1024}');
    expect(browser).toContain('name="confirmPassword"');
    expect(browser).toContain('Passwords do not match.');
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
    const registration = { waiting: null as { postMessage(message: unknown): void } | null, installing: firstWorker as typeof firstWorker | typeof secondWorker | null, addEventListener(type: 'updatefound', callback: () => void) { callbacks[type] = callback; } };
    const states: string[] = [];
    await registerPwaWorker({ register(url, options) { expect(url).toBe('/pwa/service-worker.js'); expect(options).toEqual({ scope: '/', type: 'module' }); return Promise.resolve(registration); } }, (state) => states.push(state.update), initialPwaState);
    callbacks.updatefound?.(); registration.installing = secondWorker; registration.waiting = { postMessage() {} }; firstWorker.state = 'installed'; workerCallbacks.statechange?.();
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
