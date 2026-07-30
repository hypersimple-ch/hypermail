/* eslint-disable @typescript-eslint/require-await -- concise deterministic browser and route doubles */
import { describe, expect, it } from 'vitest';
import { clearBadgeFallback, emptyBadgeFallback, enqueueBadgeFallback, initialPermissionState, requestNotificationPermission } from '../../src/notifications/onboarding.js';
import { createNotificationRoutes } from '../../src/notifications/routes.js';
import { displayPushNotification, handleNotificationClick } from '../../src/notifications/service-worker.js';

describe('notification web contracts', () => {
  it('uses persistent fallback for denied and unavailable permission', async () => {
    const denied = { isSupported: () => true, permission: () => 'denied' as const, requestPermission: async () => 'denied' as const };
    const unavailable = { isSupported: () => false, permission: () => 'default' as const, requestPermission: async () => 'default' as const };
    expect(initialPermissionState(denied)).toBe('denied'); expect(await requestNotificationPermission(unavailable)).toBe('unavailable');
    const pending = enqueueBadgeFallback(enqueueBadgeFallback(emptyBadgeFallback, 'a1'), 'a1');
    expect(pending).toEqual({ badge: 'pending', pendingActivityIds: ['a1'] }); expect(clearBadgeFallback(pending, 'a1')).toEqual(emptyBadgeFallback);
  });

  it('requires authentication for subscription mutations', async () => {
    const calls: string[] = [];
    const routes = createNotificationRoutes({ async authenticatedUserId() { return null; } }, { async subscribe() { calls.push('subscribe'); }, async unsubscribe() { calls.push('unsubscribe'); } }, 'https://app.test');
    expect(await routes.subscribe({ method: 'POST', origin: 'https://app.test', correlationId: 'c', body: { endpoint: 'e', p256dh: 'p', auth: 'a' } })).toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
  });

  it('displays a redacted push and opens its activity deep link on click', async () => {
    const shown: unknown[] = [];
    const displayed = await displayPushNotification({ notificationId: 'n1', activityId: 'a / 1', senderLabel: 'Alice', subject: 'Subject', statusLabel: 'waiting', body: 'do not show' }, { async show(title, options) { shown.push({ title, options }); } });
    const opened: string[] = [];
    const url = await handleNotificationClick('a / 1', { async focusExisting() { return false; }, async open(value) { opened.push(value); } }, 'https://app.test');
    expect(displayed).toBe(true); expect(shown).toEqual([{ title: 'Subject', options: { body: 'Alice — waiting', tag: 'n1', data: { activityId: 'a / 1' } } }]);
    expect(url).toBe('https://app.test/activities/a%20%2F%201'); expect(opened).toEqual([url]);
  });
});
