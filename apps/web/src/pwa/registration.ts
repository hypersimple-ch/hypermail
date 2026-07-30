import { updateAvailable } from './state.js';
import type { PwaState } from './state.js';

export interface ServiceWorkerRegistrationLike {
  waiting: { postMessage(message: unknown): void } | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  installing: { addEventListener(type: 'statechange', listener: () => void): void; state: string } | null;
}

export interface ServiceWorkerContainerLike {
  register(url: string, options: Readonly<{ scope: string; type: 'module' }>): Promise<ServiceWorkerRegistrationLike>;
}

/**
 * Register the standards-based worker from a browser host. This library does not
 * create a browser host itself; deploy /pwa/service-worker.js with the static assets.
 */
export async function registerPwaWorker(
  serviceWorker: ServiceWorkerContainerLike,
  onState: (state: PwaState) => void,
  state: PwaState,
): Promise<ServiceWorkerRegistrationLike> {
  const registration = await serviceWorker.register('/pwa/service-worker.js', { scope: '/', type: 'module' });
  const notifyIfWaiting = (): void => { if (registration.waiting) onState(updateAvailable(state)); };
  registration.addEventListener('updatefound', () => {
    // A subsequent update can replace registration.installing; observe the worker
    // that triggered this event instead of looking it up again later.
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') notifyIfWaiting();
    });
  });
  notifyIfWaiting();
  return registration;
}

/** Invoke only from the visible, user-confirmed “reload to update” control. */
export function activateWaitingUpdate(registration: ServiceWorkerRegistrationLike): void {
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
