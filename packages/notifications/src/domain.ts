export type NotificationState = 'pending' | 'delivering' | 'delivered' | 'failed' | 'suppressed';
export type DeliveryState = 'pending' | 'succeeded' | 'retryable' | 'permanent_failure';

/** The only data allowed to cross the push-provider boundary. */
export type PushPayload = Readonly<{
  notificationId: string;
  activityId: string;
  senderLabel: string;
  subject: string;
  statusLabel: string;
}>;

export type NotificationInput = PushPayload & Readonly<{ userId: string }>;
export type LogicalNotification = PushPayload & Readonly<{ userId: string; state: NotificationState }>;
export type PushSubscription = Readonly<{ id: string; endpoint: string; p256dh: string; auth: string }>;
export type DeliveryAttempt = Readonly<{ notificationId: string; subscriptionId: string; attempt: number }>;

/** Deliberately projects fields rather than serialising an activity or mail object. */
export function createPushPayload(input: NotificationInput): PushPayload {
  return {
    notificationId: input.notificationId,
    activityId: input.activityId,
    senderLabel: input.senderLabel,
    subject: input.subject,
    statusLabel: input.statusLabel,
  };
}

export function activityDeepLink(activityId: string): string {
  return `/activities/${encodeURIComponent(activityId)}`;
}
