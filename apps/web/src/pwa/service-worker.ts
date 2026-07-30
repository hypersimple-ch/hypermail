import { displayPushNotification, handleNotificationClick } from '../notifications/service-worker.js';

export const OFFLINE_CACHE = 'hypermail-offline-v1';
export const OFFLINE_SHELL_URL = '/offline.html';

export type NavigationRequest = Readonly<{ method: string; mode: string; url: string }>;
export function isNavigationRequest(request: NavigationRequest): boolean {
  return request.method === 'GET' && request.mode === 'navigate';
}

/** Only failed document navigations receive the static connectivity shell. */
export async function navigationWithOfflineFallback(
  request: NavigationRequest,
  network: (request: NavigationRequest) => Promise<unknown>,
  offlineShell: () => Promise<unknown>,
): Promise<unknown> {
  if (!isNavigationRequest(request)) return network(request);
  try { return await network(request); } catch { return offlineShell(); }
}

type WaitableEvent = { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = WaitableEvent & { request: NavigationRequest; respondWith(promise: Promise<unknown>): void };
type PushEvent = WaitableEvent & { data: { json(): unknown } | null };
type NotificationClickEvent = WaitableEvent & { notification: { data: unknown; close(): void } };
type CacheLike = { add(url: string): Promise<void>; match(url: string): Promise<unknown> };
type CacheStorageLike = { open(name: string): Promise<CacheLike>; keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
type WorkerScope = {
  location: { origin: string };
  caches: CacheStorageLike;
  registration: { showNotification(title: string, options: Readonly<{ body: string; tag: string; data: Readonly<{ activityId: string }> }>): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(options: Readonly<{ type: 'window'; includeUncontrolled: boolean }>): Promise<Array<{ url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown> }>>; openWindow(url: string): Promise<unknown> };
  fetch(request: NavigationRequest): Promise<unknown>;
  addEventListener(type: 'install' | 'activate' | 'fetch' | 'push' | 'notificationclick' | 'message', listener: (event: never) => void): void;
};

function pushPayload(event: PushEvent): unknown {
  try { return event.data?.json(); } catch { return undefined; }
}

/** Attach this in the emitted module worker; it stores only the static offline page. */
export function attachPwaWorker(scope: WorkerScope): void {
  scope.addEventListener('install', (event: InstallEvent) => {
    event.waitUntil(scope.caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_SHELL_URL)));
  });
  scope.addEventListener('activate', (event: WaitableEvent) => {
    event.waitUntil(scope.caches.keys().then(async (names) => {
      await Promise.all(names.filter((name) => name.startsWith('hypermail-offline-') && name !== OFFLINE_CACHE).map((name) => scope.caches.delete(name)));
      await scope.clients.claim();
    }));
  });
  scope.addEventListener('fetch', (event: FetchEvent) => {
    event.respondWith(navigationWithOfflineFallback(event.request, (request) => scope.fetch(request), async () => {
      const cachedShell = await (await scope.caches.open(OFFLINE_CACHE)).match(OFFLINE_SHELL_URL);
      return cachedShell ?? new Response('Hypermail is offline. Reconnect and try again.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }));
  });
  scope.addEventListener('push', (event: PushEvent) => {
    event.waitUntil(displayPushNotification(pushPayload(event), { show: (title, options) => scope.registration.showNotification(title, options) }));
  });
  scope.addEventListener('notificationclick', (event: NotificationClickEvent) => {
    event.notification.close();
    const activityId = typeof (event.notification.data as { activityId?: unknown } | null)?.activityId === 'string' ? (event.notification.data as { activityId: string }).activityId : null;
    if (!activityId) return;
    event.waitUntil(handleNotificationClick(activityId, {
      async focusExisting(url) {
        const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const match = windows.find((window) => new URL(window.url).origin === scope.location.origin);
        if (!match) return false;
        await match.navigate?.(url);
        await match.focus();
        return true;
      },
      async open(url) { await scope.clients.openWindow(url); },
    }, scope.location.origin));
  });
  scope.addEventListener('message', (event: { data: unknown }) => {
    if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') {
      // Deliberately no implicit skipWaiting: only a visible, user-confirmed update may activate.
      const worker = scope as WorkerScope & { skipWaiting(): Promise<void> };
      void worker.skipWaiting();
    }
  });
}

type InstallEvent = WaitableEvent;
declare const self: WorkerScope & { skipWaiting(): Promise<void> };
if (typeof self !== 'undefined') attachPwaWorker(self);
