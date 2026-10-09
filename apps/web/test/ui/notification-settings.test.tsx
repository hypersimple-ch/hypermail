// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationSettings } from '../../src/notifications/settings.js';

const existingNotice = 'Browser subscription exists. Enable to confirm delivery, or disable notifications.';
const enabledNotice = 'Notifications enabled.';
const disabledNotice = 'Notifications disabled.';
const endpoint = 'https://push.example.test/subscription';
const serialized = { endpoint, keys: { p256dh: 'browser-public-key', auth: 'browser-auth-key' } };
const publicKey = btoa(String.fromCharCode(4, ...Array<number>(64).fill(1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function browserPorts(options: { permission?: NotificationPermission; existing?: boolean } = {}) {
  let permission = options.permission ?? 'granted';
  let current: PushSubscription | null = null;
  const unsubscribe = vi.fn(() => { current = null; return Promise.resolve(true); });
  const toJSON = vi.fn(() => serialized);
  const subscription = { endpoint, toJSON, unsubscribe } as unknown as PushSubscription;
  if (options.existing) current = subscription;
  const requestPermission = vi.fn((): Promise<NotificationPermission> => { permission = 'granted'; return Promise.resolve(permission); });
  const controlledNotification = {
    get permission() { return permission; },
    requestPermission,
  };
  const getSubscription = vi.fn(() => Promise.resolve(current));
  const subscribe = vi.fn(() => { current = subscription; return Promise.resolve(subscription); });
  const registration: { active: { state: string } | null; pushManager: { getSubscription: typeof getSubscription; subscribe: typeof subscribe } } = { active: { state: 'activated' }, pushManager: { getSubscription, subscribe } };
  const getRegistration = vi.fn((): Promise<typeof registration | undefined> => Promise.resolve(registration));
  const ready = vi.fn(() => { throw new Error('Do not wait indefinitely for a worker.'); });
  const serviceWorker = { getRegistration, get ready() { return ready(); } };
  vi.stubGlobal('Notification', controlledNotification);
  vi.stubGlobal('PushManager', {});
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { serviceWorker });
  return { subscription, unsubscribe, toJSON, requestPermission, getSubscription, subscribe, registration, getRegistration, ready,
    current: () => current, setPermission: (value: NotificationPermission) => { permission = value; } };
}

function serverPorts() {
  let registered = false;
  const persistence = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'subscribed' }), { status: 201 })));
  const removal = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === '/api/v1/notifications/vapid-public-key') return new Response(JSON.stringify({ publicKey }), { status: 200 });
    if (url === '/api/v1/notifications/subscribe') {
      if (typeof init?.body !== 'string') return new Response(null, { status: 400 });
      const body: unknown = JSON.parse(init.body);
      if (!body || typeof body !== 'object' || !('endpoint' in body) || !('p256dh' in body) || !('auth' in body) || body.endpoint !== endpoint || body.p256dh !== serialized.keys.p256dh || body.auth !== serialized.keys.auth) {
        return new Response(null, { status: 400 });
      }
      const response = await persistence();
      if (response.ok) registered = true;
      return response;
    }
    if (url === '/api/v1/notifications/unsubscribe') {
      if (typeof init?.body !== 'string') return new Response(null, { status: 400 });
      const body: unknown = JSON.parse(init.body);
      if (!body || typeof body !== 'object' || !('endpoint' in body) || body.endpoint !== endpoint) return new Response(null, { status: 400 });
      const response = await removal();
      if (response.ok) registered = false;
      return response;
    }
    if (url === '/api/v1/session') return new Response(null, { status: 401 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, persistence, removal, calls, registered: () => registered };
}

async function enable() {
  fireEvent.click(await screen.findByRole('button', { name: 'Enable notifications' }));
}
async function disable() {
  fireEvent.click(await screen.findByRole('button', { name: 'Disable notifications' }));
}
async function enableSuccessfully() {
  await enable();
  await screen.findByText(enabledNotice);
}
function expectNoSuccess() { expect(screen.queryByText(enabledNotice)).toBeNull(); }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Notification Settings lifecycle', () => {
  it('does not prompt at mount and only requests default permission after the enable gesture', async () => {
    const browser = browserPorts({ permission: 'default' });
    const server = serverPorts();
    render(<NotificationSettings />);
    await screen.findByRole('button', { name: 'Enable notifications' });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    await enableSuccessfully();
    expect(browser.requestPermission).toHaveBeenCalledOnce();
    expect(server.registered()).toBe(true);
  });

  it('does not repeat a denied permission prompt after the user tries enabling', async () => {
    const browser = browserPorts({ permission: 'default' });
    const server = serverPorts();
    browser.requestPermission.mockImplementationOnce(() => { browser.setPermission('denied'); return Promise.resolve('denied'); });
    render(<NotificationSettings />);
    await enable();
    await screen.findByText(/browser settings/i);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(browser.requestPermission).toHaveBeenCalledOnce();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    expectNoSuccess();
  });

  it('explains denied permission without prompting or subscribing on mount or remount', async () => {
    const browser = browserPorts({ permission: 'denied' });
    const server = serverPorts();
    const mounted = render(<NotificationSettings />);
    await screen.findByText(/browser settings/i);
    mounted.unmount();
    render(<NotificationSettings />);
    await screen.findByText(/browser settings/i);
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    expectNoSuccess();
  });

  it.each(['insecure context', 'Notification', 'PushManager', 'serviceWorker'] as const)('honestly reports unavailable with %s and does not loop permission', async missing => {
    const browser = browserPorts({ permission: 'default' });
    const server = serverPorts();
    if (missing === 'insecure context') vi.stubGlobal('isSecureContext', false);
    else if (missing === 'serviceWorker') vi.stubGlobal('navigator', {});
    else vi.stubGlobal(missing, undefined);
    render(<NotificationSettings />);
    await screen.findByText(/notifications.*unavailable/i);
    const retry = screen.queryByRole('button', { name: 'Try again' });
    if (retry) fireEvent.click(retry);
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    expectNoSuccess();
  });

  it.each(['missing', 'inactive'] as const)('allows explicit retry when the worker is %s without waiting on ready', async worker => {
    const browser = browserPorts({ permission: 'default' });
    const server = serverPorts();
    if (worker === 'missing') browser.getRegistration.mockResolvedValueOnce(undefined);
    else browser.registration.active = null;
    render(<NotificationSettings />);
    await screen.findByText(/notifications.*unavailable/i);
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.ready).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    browser.registration.active = { state: 'activated' };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Enable notifications' });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    await enableSuccessfully();
  });

  it('does not claim enabled while server persistence is pending', async () => {
    const browser = browserPorts();
    const server = serverPorts();
    const pending = deferred<Response>();
    server.persistence.mockImplementationOnce(() => pending.promise);
    render(<NotificationSettings />);
    await enable();
    await waitFor(() => { expect(server.persistence).toHaveBeenCalledOnce(); });
    expect(browser.current()).toBe(browser.subscription);
    expect(server.registered()).toBe(false);
    expectNoSuccess();
    expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(() => { pending.resolve(new Response(null, { status: 201 })); return pending.promise; });
    await screen.findByText(enabledNotice);
    expect(server.registered()).toBe(true);
  });

  it('retains a subscription after persistence failure and retries without creating another', async () => {
    const browser = browserPorts();
    const server = serverPorts();
    server.persistence.mockResolvedValueOnce(new Response(null, { status: 503 }));
    render(<NotificationSettings />);
    await enable();
    await waitFor(() => { expect(server.persistence).toHaveBeenCalledOnce(); });
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable notifications' }).disabled).toBe(false); });
    expectNoSuccess();
    expect(screen.getByText(/could not.*(enable|save|confirm)|could not.*notification/i)).toBeTruthy();
    expect(browser.current()).toBe(browser.subscription);
    await enableSuccessfully();
    expect(browser.subscribe).toHaveBeenCalledOnce();
    expect(server.registered()).toBe(true);
  });

  it('requires explicit confirmation for an existing browser subscription and offers both actions', async () => {
    const browser = browserPorts({ existing: true });
    const server = serverPorts();
    render(<NotificationSettings />);
    await screen.findByText(existingNotice);
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disable notifications' })).toBeTruthy();
    expect(server.calls).toEqual([]);
    expectNoSuccess();
    await enableSuccessfully();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.registered()).toBe(true);
  });

  it('keeps notifications disabled after a full disable and reopening Settings', async () => {
    const browser = browserPorts();
    const server = serverPorts();
    const mounted = render(<NotificationSettings />);
    await enableSuccessfully();
    await disable();
    await screen.findByText(disabledNotice);
    expect(server.registered()).toBe(false);
    expect(browser.current()).toBeNull();
    expect(server.persistence).toHaveBeenCalledOnce();
    mounted.unmount();
    render(<NotificationSettings />);
    await screen.findByRole('button', { name: 'Enable notifications' });
    expectNoSuccess();
    expect(server.persistence).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledOnce();
  });

  it('does not mutate the server when disabling with no browser subscription', async () => {
    browserPorts();
    const server = serverPorts();
    render(<NotificationSettings />);
    await screen.findByRole('button', { name: 'Enable notifications' });
    expect(screen.getByText(disabledNotice)).toBeTruthy();
    const button = screen.queryByRole('button', { name: 'Disable notifications' });
    if (button) fireEvent.click(button);
    expect(server.calls).toEqual([]);
    expectNoSuccess();
  });

  it('retains enabled state and browser subscription when server removal fails, then permits retry', async () => {
    const browser = browserPorts();
    const server = serverPorts();
    render(<NotificationSettings />);
    await enableSuccessfully();
    server.removal.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await disable();
    await screen.findByText(/could not.*disable|could not.*remove/i);
    expect(screen.getByText(enabledNotice)).toBeTruthy();
    expect(browser.unsubscribe).not.toHaveBeenCalled();
    expect(browser.current()).toBe(browser.subscription);
    expect(server.registered()).toBe(true);
    await disable();
    await screen.findByText(disabledNotice);
    expect(server.registered()).toBe(false);
    expect(browser.current()).toBeNull();
  });

  it.each(['false', 'rejection'] as const)('exposes a partial-disable error when browser unsubscribe returns %s and blocks enable until retry completes', async failure => {
    const browser = browserPorts();
    const server = serverPorts();
    render(<NotificationSettings />);
    await enableSuccessfully();
    if (failure === 'false') browser.unsubscribe.mockResolvedValueOnce(false);
    else browser.unsubscribe.mockRejectedValueOnce(new Error('browser unsubscribe failed'));
    await disable();
    await screen.findByRole('button', { name: 'Retry disable' });
    expect(screen.getByText(/browser.*(could not|failed|still|subscription)|could not.*browser/i)).toBeTruthy();
    expect(screen.queryByText(disabledNotice)).toBeNull();
    expectNoSuccess();
    expect(server.registered()).toBe(false);
    expect(browser.current()).toBe(browser.subscription);
    const enableButton = screen.queryByRole('button', { name: 'Enable notifications' });
    if (enableButton) expect((enableButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry disable' }));
    await screen.findByText(disabledNotice);
    expect(browser.current()).toBeNull();
    expect(server.persistence).toHaveBeenCalledOnce();
  });

  it('retains partial-disable recovery across reopening Settings instead of silently registering again', async () => {
    const browser = browserPorts({ existing: true });
    const server = serverPorts();
    const mounted = render(<NotificationSettings />);
    await screen.findByText(existingNotice);
    browser.unsubscribe.mockResolvedValueOnce(false);
    await disable();
    await screen.findByRole('button', { name: 'Retry disable' });
    mounted.unmount();
    render(<NotificationSettings />);
    await screen.findByRole('button', { name: 'Retry disable' });
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
    expect(server.persistence).not.toHaveBeenCalled();
    expectNoSuccess();
    fireEvent.click(screen.getByRole('button', { name: 'Retry disable' }));
    await screen.findByText(disabledNotice);
    expect(browser.current()).toBeNull();
    expect(server.persistence).not.toHaveBeenCalled();
  });

  it('reconciles an in-flight disable when Settings is reopened before server removal finishes', async () => {
    const browser = browserPorts({ existing: true });
    const server = serverPorts();
    const removal = deferred<Response>();
    server.removal.mockReturnValueOnce(removal.promise);
    const mounted = render(<NotificationSettings />);
    await screen.findByText(existingNotice);
    await disable();
    await waitFor(() => { expect(server.removal).toHaveBeenCalledOnce(); });
    mounted.unmount();
    render(<NotificationSettings />);
    await act(() => { removal.resolve(new Response(null, { status: 204 })); return removal.promise; });
    await screen.findByText(disabledNotice);
    expect(browser.current()).toBeNull();
    await enableSuccessfully();
    expect(browser.subscribe).toHaveBeenCalledOnce();
    expect(browser.current()).not.toBeNull();
    expect(server.removal).toHaveBeenCalledOnce();
  });

  it.each(['', 'not-base64!'] as const)('rejects unusable VAPID key %j before creating a subscription', async key => {
    const browser = browserPorts();
    const server = serverPorts();
    server.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: key }), { status: 200 }));
    render(<NotificationSettings />);
    await enable();
    await screen.findByText('The notification public key is invalid.');
    expectNoSuccess();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.persistence).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable notifications' }).disabled).toBe(false);
  });

  it.each(['endpoint', 'p256dh', 'auth'] as const)('rejects a subscription missing %s locally without claiming delivery', async missing => {
    const browser = browserPorts();
    const server = serverPorts();
    const invalid = { endpoint, keys: { ...serialized.keys } };
    if (missing === 'endpoint') invalid.endpoint = '';
    else invalid.keys[missing] = '';
    browser.toJSON.mockReturnValue(invalid);
    render(<NotificationSettings />);
    await enable();
    await screen.findByText('The browser notification subscription is incomplete.');
    expectNoSuccess();
    expect(server.persistence).not.toHaveBeenCalled();
    expect(server.registered()).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable notifications' }).disabled).toBe(false);
  });

  it.each(['enable', 'disable'] as const)('leaves session expiry during %s to the banner owner and releases pending without false success', async operation => {
    const browser = browserPorts();
    const server = serverPorts();
    if (operation === 'enable') server.persistence.mockResolvedValueOnce(new Response(null, { status: 401 }));
    else server.removal.mockResolvedValueOnce(new Response(null, { status: 401 }));
    function BannerOwner() {
      const [expired, setExpired] = React.useState(false);
      React.useEffect(() => {
        const onExpired = () => { setExpired(true); };
        window.addEventListener('hypermail:session-expired', onExpired);
        return () => { window.removeEventListener('hypermail:session-expired', onExpired); };
      }, []);
      return <>{expired && <div role="alert">Your session expired. Sign in to continue.</div>}<NotificationSettings /></>;
    }
    render(<BannerOwner />);
    if (operation === 'enable') await enable();
    else { await enableSuccessfully(); await disable(); }
    await screen.findByRole('alert');
    expect(screen.getByText('Your session expired. Sign in to continue.')).toBeTruthy();
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: operation === 'enable' ? 'Enable notifications' : 'Disable notifications' }).disabled).toBe(false); });
    if (operation === 'enable') expectNoSuccess();
    else {
      expect(screen.getByText(enabledNotice)).toBeTruthy();
      expect(screen.queryByText(disabledNotice)).toBeNull();
      expect(browser.unsubscribe).not.toHaveBeenCalled();
    }
    expect(screen.queryByText(/could not.*notification|could not.*enable|could not.*disable/i)).toBeNull();
    expect(browser.current()).toBe(browser.subscription);
    expect(server.registered()).toBe(operation === 'disable');
    expect(server.persistence).toHaveBeenCalledOnce();
  });
});
