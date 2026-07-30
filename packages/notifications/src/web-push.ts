import webpush from 'web-push';
import type { PushPayload, PushSubscription } from './domain.js';
import type { PushProviderFailure, PushSendResult, VapidConfiguration, VapidPushTransport } from './ports.js';

export interface WebPushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: Readonly<{ endpoint: string; keys: Readonly<{ p256dh: string; auth: string }> }>, payload: string): Promise<Readonly<{ statusCode?: number }>>;
}

type ProviderError = Readonly<{ statusCode?: unknown; code?: unknown }>;

/** Production web-push transport. The provider sees only the explicit PushPayload projection. */
export class WebPushVapidTransport implements VapidPushTransport {
  constructor(configuration: VapidConfiguration, private readonly client: WebPushClient = webpush) {
    if (!configuration.subject || !configuration.publicKey || !configuration.privateKey) throw new Error('VAPID subject, public key, and private key are required');
    this.client.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<PushSendResult> {
    const redactedPayload = JSON.stringify({
      notificationId: payload.notificationId,
      activityId: payload.activityId,
      senderLabel: payload.senderLabel,
      subject: payload.subject,
      statusLabel: payload.statusLabel,
    });
    try {
      const result = await this.client.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, redactedPayload);
      return { ok: true, ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }) };
    } catch (error: unknown) {
      const providerError = error as ProviderError;
      const failure: PushProviderFailure = {
        ...(typeof providerError.statusCode === 'number' ? { statusCode: providerError.statusCode } : {}),
        ...(typeof providerError.code === 'string' ? { code: providerError.code } : {}),
      };
      return { ok: false, failure };
    }
  }
}
