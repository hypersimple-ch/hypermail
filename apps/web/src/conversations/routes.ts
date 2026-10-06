import { ConversationCursorError } from '@hypermail/contracts';
import { ConversationHttpError, type ConversationAuth } from './contracts.js';
import type { ConversationService } from './service.js';
export type ConversationRouteRequest = Readonly<{ method: string; auth: ConversationAuth | null; origin: string | null; query: Readonly<Record<string, string | undefined>>; body: Readonly<Record<string, unknown>> }>;
export type ConversationRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;
export function createConversationRoutes(service: ConversationService, options: { expectedOrigin: string }) {
  const handle = async (request: ConversationRouteRequest, method: 'GET' | 'POST', status: number, action: (auth: ConversationAuth) => Promise<object>): Promise<ConversationRouteResponse> => {
    if (request.method !== method) return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
    if (!request.auth?.subjectId) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
    if (method === 'POST' && request.origin !== options.expectedOrigin) return { status: 403, body: { error: { code: 'CROSS_ORIGIN' } } };
    try { return { status, body: { ...await action(request.auth) } }; }
    catch (error) {
      if (error instanceof ConversationCursorError) return { status: 400, body: { error: { code: 'BAD_CURSOR' } } };
      if (error instanceof ConversationHttpError) return { status: error.status, body: { error: { code: error.code, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }), ...(error.currentAttempt === undefined ? {} : { currentAttempt: error.currentAttempt }) } } };
      throw error;
    }
  };
  return {
    create: (request: ConversationRouteRequest) => handle(request, 'POST', 201, (auth) => service.create(auth, request.body)),
    list: (request: ConversationRouteRequest) => handle(request, 'GET', 200, (auth) => service.list(auth, request.query)),
    messages: (request: ConversationRouteRequest, id: string) => handle(request, 'GET', 200, (auth) => service.messages(auth, id, request.query)),
    post: (request: ConversationRouteRequest, id: string) => handle(request, 'POST', 202, (auth) => service.post(auth, id, request.body)),
    retry: (request: ConversationRouteRequest, id: string, turnId: string) => handle(request, 'POST', 202, (auth) => service.retry(auth, id, turnId, request.body)),
  };
}
