import { z } from 'zod';
import { approvalSchema, createDraftSchema, editDraftSchema, replyDraftSchema, DraftBlockedError, DraftConflictError, DraftInputError, DraftNotFoundError, FreshAuthRequiredError, SendRejectedError, type DraftScope } from './contracts.js';
import type { DraftService } from './service.js';

export type DraftRouteRequest = Readonly<{ method: string; auth: DraftScope | null; origin: string | null; body: unknown }>;
export type DraftRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;
export type DraftRouteOptions = Readonly<{ expectedOrigin: string }>;
const idSchema = z.uuid();
const error = (value: unknown): DraftRouteResponse => {
  if (value instanceof DraftInputError || value instanceof z.ZodError) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: value instanceof Error ? value.message : 'Invalid request.' } } };
  if (value instanceof FreshAuthRequiredError) return { status: 401, body: { error: { code: 'FRESH_AUTH_REQUIRED', message: value.message } } };
  if (value instanceof DraftConflictError) return { status: 409, body: { error: { code: 'CONFLICT', message: value.message } } };
  if (value instanceof DraftBlockedError || value instanceof SendRejectedError) return { status: 409, body: { error: { code: 'REJECTED', message: value.message } } };
  if (value instanceof DraftNotFoundError) return { status: 404, body: { error: { code: 'NOT_FOUND', message: value.message } } };
  throw value;
};
/** Framework-neutral CSRF-safe mutation contract. Browser adapters must supply verified auth/fresh-auth timestamps. */
export function createDraftRoutes(service: DraftService, options: DraftRouteOptions) {
  const gate = (request: DraftRouteRequest): DraftRouteResponse | null => request.origin !== options.expectedOrigin ? { status: 403, body: { error: { code: 'CROSS_ORIGIN' } } } : !request.auth ? { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } } : null;
  const mutation = async <T>(request: DraftRouteRequest, parse: (body: unknown) => T, work: (scope: DraftScope, input: T) => Promise<Readonly<Record<string, unknown>>>): Promise<DraftRouteResponse> => { if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } }; const denied = gate(request); if (denied) return denied; try { return { status: 200, body: await work(request.auth as DraftScope, parse(request.body)) }; } catch (value) { return error(value); } };
  return {
    create: (request: DraftRouteRequest) => mutation(request, (body) => createDraftSchema.parse(body), async (scope, input) => ({ draft: await service.createUser(scope, input) })),
    reply: (request: DraftRouteRequest) => mutation(request, (body) => replyDraftSchema.parse(body), async (scope, input) => ({ draft: await service.replyUser(scope, input) })),
    save: (request: DraftRouteRequest, draftId: string) => mutation(request, (body) => editDraftSchema.parse(body), async (scope, input) => ({ draft: await service.editUser(scope, idSchema.parse(draftId), input.expectedVersion, input) })),
    beginApproval: (request: DraftRouteRequest, draftId: string) => mutation(request, (body) => approvalSchema.parse(body), async (scope, input) => ({ approval: await service.beginApproval(scope, idSchema.parse(draftId), input.expectedVersion, input.confirmation) })),
    confirmSend: (request: DraftRouteRequest, approvalId: string) => mutation(request, (body) => z.strictObject({ confirmation: z.string().min(16).max(500) }).parse(body), async (scope, input) => ({ draft: await service.confirmSend(scope, idSchema.parse(approvalId), input.confirmation) })),
    async history(request: DraftRouteRequest, draftId: string): Promise<DraftRouteResponse> { if (request.method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } }; if (!request.auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }; try { return { status: 200, body: { revisions: await service.history(request.auth, idSchema.parse(draftId)) } }; } catch (value) { return error(value); } },
  };
}
