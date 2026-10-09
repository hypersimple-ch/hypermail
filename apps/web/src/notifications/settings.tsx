import * as React from 'react';
import { Button } from '../components/heroui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/heroui/card.js';
import { StatePanel } from '../components/app/patterns.js';
import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';
import { initialPermissionState, requestNotificationPermission, type PermissionClient } from './onboarding.js';

type Status = 'loading' | 'unavailable' | 'denied' | 'disabled' | 'existing' | 'enabled' | 'disable-error';

// Retain incomplete browser removals across Settings remounts, without persisting credentials.
const incompleteRemovals = new Set<string>();
const removalsInFlight = new Map<string, Promise<void>>();
const permissionClient: PermissionClient = {
  isSupported: () => typeof window !== 'undefined' && window.isSecureContext
    && typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'
    && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof navigator.serviceWorker.getRegistration === 'function' && typeof PushManager !== 'undefined',
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
};

function publicKeyBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('The notification public key is invalid.');
  }
  const unpadded = value.replace(/=+$/, '');
  let decoded: string;
  try {
    decoded = atob(unpadded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - unpadded.length % 4) % 4));
  } catch {
    throw new Error('The notification public key is invalid.');
  }
  // VAPID uses an uncompressed P-256 public key.
  if (decoded.length !== 65 || decoded.charCodeAt(0) !== 4
    || btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== unpadded) {
    throw new Error('The notification public key is invalid.');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.active && typeof registration.pushManager !== 'undefined'
    && typeof registration.pushManager.getSubscription === 'function'
    && typeof registration.pushManager.subscribe === 'function' ? registration : undefined;
}

export function NotificationSettings(): React.JSX.Element {
  const [status, setStatus] = React.useState<Status>('loading');
  const [error, setError] = React.useState<string | undefined>();
  const [pending, setPending] = React.useState<'enable' | 'disable' | undefined>();
  const subscription = React.useRef<PushSubscription | null>(null);
  const generation = React.useRef(0);
  const busy = React.useRef(false);

  const inspect = React.useCallback(async (): Promise<void> => {
    if (busy.current) return;
    const epoch = ++generation.current;
    setError(undefined);
    setStatus('loading');
    try {
      const permission = initialPermissionState(permissionClient);
      if (permission === 'unavailable') { setStatus('unavailable'); return; }
      const registration = await activeRegistration();
      if (epoch !== generation.current) return;
      if (!registration) { setStatus('unavailable'); return; }
      let current = await registration.pushManager.getSubscription();
      if (current && removalsInFlight.has(current.endpoint)) {
        await removalsInFlight.get(current.endpoint);
        current = await registration.pushManager.getSubscription();
      }
      if (epoch !== generation.current) return;
      subscription.current = current;
      setStatus(current && incompleteRemovals.has(current.endpoint) ? 'disable-error'
        : current ? 'existing' : permission === 'denied' ? 'denied' : 'disabled');
    } catch {
      if (epoch === generation.current) setStatus('unavailable');
    }
  }, []);

  React.useEffect(() => {
    void inspect();
    return () => { generation.current += 1; busy.current = false; };
  }, [inspect]);

  const enable = async (): Promise<void> => {
    if (busy.current || status === 'disable-error') return;
    busy.current = true;
    const epoch = ++generation.current;
    const current = () => epoch === generation.current;
    setPending('enable');
    setError(undefined);
    try {
      let permission = initialPermissionState(permissionClient);
      if (permission === 'supported') permission = await requestNotificationPermission(permissionClient);
      if (!current()) return;
      if (permission !== 'granted') {
        setStatus(permission === 'unavailable' ? 'unavailable' : 'denied');
        return;
      }
      const registration = await activeRegistration();
      if (!current()) return;
      if (!registration) { setStatus('unavailable'); return; }
      const keyResponse = await authenticatedFetch('/api/v1/notifications/vapid-public-key');
      if (!current()) return;
      if (!keyResponse.ok) throw new Error('Could not enable notifications. Try again.');
      const keyData: unknown = await keyResponse.json();
      if (!current()) return;
      const key = publicKeyBytes(typeof keyData === 'object' && keyData !== null
        ? (keyData as Record<string, unknown>)['publicKey'] : undefined);
      let browserSubscription = await registration.pushManager.getSubscription();
      if (browserSubscription && removalsInFlight.has(browserSubscription.endpoint)) {
        await removalsInFlight.get(browserSubscription.endpoint);
        browserSubscription = await registration.pushManager.getSubscription();
      }
      if (!current()) return;
      if (browserSubscription && incompleteRemovals.has(browserSubscription.endpoint)) {
        subscription.current = browserSubscription;
        setStatus('disable-error');
        return;
      }
      browserSubscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (!current()) return;
      subscription.current = browserSubscription;
      setStatus('existing');
      const data = browserSubscription.toJSON();
      const endpoint = data.endpoint;
      const p256dh = data.keys?.['p256dh'];
      const auth = data.keys?.['auth'];
      if (typeof endpoint !== 'string' || endpoint.length === 0
        || typeof p256dh !== 'string' || p256dh.length === 0 || typeof auth !== 'string' || auth.length === 0) {
        throw new Error('The browser notification subscription is incomplete.');
      }
      const response = await authenticatedFetch('/api/v1/notifications/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, p256dh, auth }),
      });
      if (!current()) return;
      if (!response.ok) throw new Error('Could not enable notifications. Try again.');
      setStatus('enabled');
    } catch (cause) {
      if (current() && !(cause instanceof SessionExpiredError)) {
        setError(cause instanceof Error && (cause.message === 'The notification public key is invalid.'
          || cause.message === 'The browser notification subscription is incomplete.')
          ? cause.message : 'Could not enable notifications. Try again.');
      }
    } finally {
      if (current()) { busy.current = false; setPending(undefined); }
    }
  };

  const disable = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const epoch = ++generation.current;
    const current = () => epoch === generation.current;
    setPending('disable');
    setError(undefined);
    let serverRemoved = false;
    let trackedRemoval: Promise<void> | undefined;
    const browserSubscription = subscription.current;
    try {
      if (browserSubscription && removalsInFlight.has(browserSubscription.endpoint)) {
        await removalsInFlight.get(browserSubscription.endpoint);
        if (current()) { busy.current = false; setPending(undefined); await inspect(); }
        return;
      }
      if (!browserSubscription) { setStatus('disabled'); return; }
      if (typeof browserSubscription.endpoint !== 'string' || browserSubscription.endpoint.length === 0) {
        throw new Error('The browser notification subscription is incomplete.');
      }
      serverRemoved = incompleteRemovals.has(browserSubscription.endpoint);
      const removal = (async (): Promise<void> => {
        if (!serverRemoved) {
          const response = await authenticatedFetch('/api/v1/notifications/unsubscribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: browserSubscription.endpoint }),
          });
          if (!response.ok) throw new Error('server removal failed');
          serverRemoved = true;
          incompleteRemovals.add(browserSubscription.endpoint);
        }
        // Finish a successful server removal even if Settings was closed meanwhile.
        if (!await browserSubscription.unsubscribe()) throw new Error('browser removal failed');
        incompleteRemovals.delete(browserSubscription.endpoint);
      })();
      trackedRemoval = removal.catch(() => {});
      removalsInFlight.set(browserSubscription.endpoint, trackedRemoval);
      await removal;
      if (current()) { subscription.current = null; setStatus('disabled'); }
    } catch (cause) {
      if (current()) {
        if (serverRemoved) setStatus('disable-error');
        else if (!(cause instanceof SessionExpiredError)) setError(cause instanceof Error
          && cause.message === 'The browser notification subscription is incomplete.'
          ? cause.message : 'Could not disable notifications on the server. Try again.');
      }
    } finally {
      if (browserSubscription && removalsInFlight.get(browserSubscription.endpoint) === trackedRemoval) {
        removalsInFlight.delete(browserSubscription.endpoint);
      }
      if (current()) { busy.current = false; setPending(undefined); }
    }
  };

  const disabled = pending !== undefined;
  return <Card>
    <CardHeader><CardTitle>Notifications</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {status === 'loading' ? <StatePanel title="Checking notification availability…" loading />
        : status === 'unavailable' ? <StatePanel title="Notifications are unavailable."
          description="Notifications require a supported browser, a secure connection, and an active service worker."
          action={<Button type="button" disabled={disabled} onClick={() => { void inspect(); }}>Try again</Button>} />
        : status === 'denied' ? <StatePanel title="Notifications are blocked."
          description="Allow notifications in your browser settings, then try again."
          action={<Button type="button" disabled={disabled} onClick={() => { void inspect(); }}>Try again</Button>} />
        : <>
          <p role="status">{status === 'enabled' ? 'Notifications enabled.'
            : status === 'existing' ? 'Browser subscription exists. Enable to confirm delivery, or disable notifications.'
            : status === 'disable-error' ? 'Server delivery is disabled, but the browser subscription could not be removed. Retry disable to finish.'
            : 'Notifications disabled.'}</p>
          <div className="flex flex-wrap gap-2">
            {status !== 'enabled' && status !== 'disable-error'
              ? <Button type="button" disabled={disabled} onClick={() => { void enable(); }}>{pending === 'enable' ? 'Enabling…' : 'Enable notifications'}</Button> : null}
            {status === 'existing' || status === 'enabled' || status === 'disable-error'
              ? <Button type="button" variant="outline" disabled={disabled} onClick={() => { void disable(); }}>{pending === 'disable' ? 'Disabling…' : status === 'disable-error' ? 'Retry disable' : 'Disable notifications'}</Button> : null}
          </div>
        </>}
      {error ? <p role="alert">{error}</p> : null}
    </CardContent>
  </Card>;
}
