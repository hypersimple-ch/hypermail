import type { DeliveryAttempt, DeliveryState, LogicalNotification, NotificationInput, NotificationState, PushPayload, PushSubscription } from './domain.js';

/** Persistence operations must be atomic at their database boundary. */
export interface NotificationPersistence {
  /** Upserts by activity ID, so an activity has exactly one logical notification. */
  ensureLogicalNotification(input: NotificationInput): Promise<LogicalNotification>;
  listEnabledSubscriptions(userId: string): Promise<readonly PushSubscription[]>;
  /** Atomically reserves the next attempt, returning null when already terminal or in progress. */
  claimDelivery(notificationId: string, subscriptionId: string, maxAttempts: number): Promise<DeliveryAttempt | null>;
  finishDelivery(attempt: DeliveryAttempt, state: DeliveryState, detail?: Readonly<{ responseCode?: number; errorCode?: string }>): Promise<void>;
  /** Persists last-success metadata after a provider acknowledgement. */
  markSubscriptionSucceeded(subscriptionId: string): Promise<void>;
  /** Stale 404/410 endpoints are durably disabled and excluded from future fan-out. */
  disableSubscription(subscriptionId: string): Promise<void>;
  updateNotificationState(notificationId: string, state: NotificationState): Promise<void>;
}

export type PushProviderFailure = Readonly<{ statusCode?: number; code?: string; message?: string }>;
export type PushSendResult = Readonly<{ ok: true; statusCode?: number }> | Readonly<{ ok: false; failure: PushProviderFailure }>;

/** Adapter boundary for web-push/VAPID providers. No provider SDK is required by the domain. */
export type PushSubscriptionInput = Readonly<{
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiresAt?: Date | null;
}>;

/** Idempotent subscription registration and endpoint-based unsubscribe boundary. */
export interface PushSubscriptionLifecycle {
  upsertSubscription(input: PushSubscriptionInput): Promise<string>;
  unsubscribe(endpoint: string): Promise<void>;
}

export interface VapidPushTransport {
  send(subscription: PushSubscription, payload: PushPayload): Promise<PushSendResult>;
}

export interface VapidConfiguration {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export function isStaleSubscription(failure: PushProviderFailure): boolean {
  return failure.statusCode === 404 || failure.statusCode === 410;
}

export function isRetryableFailure(failure: PushProviderFailure): boolean {
  const code = failure.statusCode;
  return code === undefined || code === 408 || code === 429 || code >= 500;
}
