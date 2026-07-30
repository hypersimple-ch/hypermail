export type NotificationRouteRequest = Readonly<{
  method: string;
  origin: string | null;
  correlationId: string;
  body: Readonly<Record<string, unknown>>;
}>;
export type NotificationRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, string>> }>;
export type PushSubscriptionInput = Readonly<{ endpoint: string; p256dh: string; auth: string }>;

export interface NotificationAuth {
  authenticatedUserId(request: NotificationRouteRequest): Promise<string | null>;
}
export interface NotificationSubscriptionService {
  subscribe(userId: string, subscription: PushSubscriptionInput, correlationId: string): Promise<void>;
  unsubscribe(userId: string, endpoint: string, correlationId: string): Promise<void>;
}

function subscription(body: Readonly<Record<string, unknown>>): PushSubscriptionInput | null {
  const endpoint = body['endpoint']; const p256dh = body['p256dh']; const auth = body['auth'];
  return typeof endpoint === 'string' && endpoint.length > 0 && typeof p256dh === 'string' && p256dh.length > 0 && typeof auth === 'string' && auth.length > 0
    ? { endpoint, p256dh, auth } : null;
}

/** Framework-neutral, authenticated same-origin mutation contracts. */
export function createNotificationRoutes(auth: NotificationAuth, service: NotificationSubscriptionService, appOrigin: string) {
  const permitted = (request: NotificationRouteRequest) => request.method === 'POST' && request.origin === appOrigin;
  const user = (request: NotificationRouteRequest) => auth.authenticatedUserId(request);
  return {
    async subscribe(request: NotificationRouteRequest): Promise<NotificationRouteResponse> {
      if (!permitted(request)) return { status: 403, body: { error: 'forbidden' } };
      const userId = await user(request); if (!userId) return { status: 401, body: { error: 'unauthenticated' } };
      const value = subscription(request.body); if (!value) return { status: 400, body: { error: 'invalid_subscription' } };
      await service.subscribe(userId, value, request.correlationId);
      return { status: 201, body: { status: 'subscribed' } };
    },
    async unsubscribe(request: NotificationRouteRequest): Promise<NotificationRouteResponse> {
      if (!permitted(request)) return { status: 403, body: { error: 'forbidden' } };
      const userId = await user(request); if (!userId) return { status: 401, body: { error: 'unauthenticated' } };
      const endpoint = request.body['endpoint']; if (typeof endpoint !== 'string' || endpoint.length === 0) return { status: 400, body: { error: 'invalid_subscription' } };
      await service.unsubscribe(userId, endpoint, request.correlationId);
      return { status: 204, body: {} };
    },
  };
}
