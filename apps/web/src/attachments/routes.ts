import { AttachmentAuthorizationError, AttachmentInputError } from './contracts.js';
import type { AttachmentScope } from './contracts.js';
import type { Readable } from 'node:stream';
import type { AttachmentDeliveryService } from './service.js';

export type AttachmentRouteRequest = Readonly<{ method: string; auth: AttachmentScope | null; origin: string | null; apiVersion: string | null; signal?: AbortSignal }>;
/** A framework adapter must invoke `cleanup` when its response finishes, closes, or cannot consume `stream`. */
export type AttachmentRouteResponse = Readonly<{ status: number; headers: Readonly<Record<string, string>>; stream?: Readable; cleanup?: () => Promise<void> }>; 
export type AttachmentRouteOptions = Readonly<{ expectedOrigin: string; apiVersion: string }>;
const empty = (status: number): AttachmentRouteResponse => ({ status, headers: { 'cache-control': 'no-store' } });

/** Framework adapter for GET /api/{version}/accounts/:accountId/messages/:messageId/attachments/:attachmentId. */
export function createAttachmentRoutes(service: AttachmentDeliveryService, options: AttachmentRouteOptions) {
  return {
    async download(request: AttachmentRouteRequest, accountId: string, messageId: string, attachmentId: string): Promise<AttachmentRouteResponse> {
      if (request.method !== 'GET') return empty(405);
      if (request.origin !== null && request.origin !== options.expectedOrigin) return empty(403);
      if (request.apiVersion !== options.apiVersion) return empty(426);
      if (!request.auth) return empty(401);
      try {
        const delivery = await service.open(request.auth, { accountId, messageId, attachmentId }, request.signal);
        return { status: 200, headers: delivery.headers, stream: delivery.stream, cleanup: delivery.cleanup };
      } catch (error) {
        // Do not reveal provider failures, filesystem paths, or attachment metadata to clients.
        if (error instanceof AttachmentAuthorizationError) return empty(404);
        if (error instanceof AttachmentInputError) return empty(400);
        return empty(502);
      }
    },
  };
}
