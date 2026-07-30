export type ServiceWorkerPushPayload = Readonly<{
  notificationId: string;
  activityId: string;
  senderLabel: string;
  subject: string;
  statusLabel: string;
}>;

export interface NotificationDisplay {
  show(title: string, options: Readonly<{ body: string; tag: string; data: Readonly<{ activityId: string }> }>): Promise<void>;
}
export interface NotificationClients {
  focusExisting(url: string): Promise<boolean>;
  open(url: string): Promise<void>;
}

function isPayload(value: unknown): value is ServiceWorkerPushPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return ['notificationId', 'activityId', 'senderLabel', 'subject', 'statusLabel'].every((key) => typeof p[key] === 'string');
}

/** Event adapters call these functions from push and notificationclick listeners. */
export async function displayPushNotification(rawPayload: unknown, display: NotificationDisplay): Promise<boolean> {
  if (!isPayload(rawPayload)) return false;
  await display.show(rawPayload.subject, {
    body: `${rawPayload.senderLabel} — ${rawPayload.statusLabel}`,
    tag: rawPayload.notificationId,
    data: { activityId: rawPayload.activityId },
  });
  return true;
}

export async function handleNotificationClick(activityId: string, clients: NotificationClients, origin: string): Promise<string> {
  const url = new URL(`/activities/${encodeURIComponent(activityId)}`, origin).toString();
  if (!(await clients.focusExisting(url))) await clients.open(url);
  return url;
}
