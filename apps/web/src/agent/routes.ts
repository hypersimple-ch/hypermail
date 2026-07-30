import {
  AgentAuthorizationError, AgentBlockedError, AgentConflictError, AgentInputError, AgentNotFoundError,
  type AgentScope, type AutonomyScope,
} from './contracts.js';
import type { AgentService } from './service.js';

export type AgentRouteRequest = Readonly<{
  method: string;
  auth: AgentScope | null;
  origin: string | null;
  apiVersion: string | null;
  body: Readonly<Record<string, unknown>>;
}>;
export type AgentRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;
export type AgentRouteOptions = Readonly<{ expectedOrigin: string; apiVersion: string }>;

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asNumber = (value: unknown): number => typeof value === 'number' ? value : Number(value);
const errorResponse = (error: unknown): AgentRouteResponse => {
  if (error instanceof AgentAuthorizationError) return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: error.message } } };
  if (error instanceof AgentInputError) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: error.message } } };
  if (error instanceof AgentConflictError) return { status: 409, body: { error: { code: 'CONFLICT', message: error.message } } };
  if (error instanceof AgentBlockedError) return { status: 409, body: { error: { code: 'BLOCKED', message: error.message } } };
  if (error instanceof AgentNotFoundError) return { status: 404, body: { error: { code: 'NOT_FOUND', message: error.message } } };
  throw error;
};

/** A framework adapter supplies verified auth and raw Origin/version headers to this same-origin boundary. */
export function createAgentRoutes(service: AgentService, options: AgentRouteOptions) {
  const gate = (request: AgentRouteRequest): AgentRouteResponse | null => {
    if (request.origin !== options.expectedOrigin) return { status: 403, body: { error: { code: 'CROSS_ORIGIN' } } };
    if (request.apiVersion !== options.apiVersion) return { status: 426, body: { error: { code: 'UNSUPPORTED_VERSION' } } };
    if (!request.auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
    return null;
  };
  const target = (body: Readonly<Record<string, unknown>>): AutonomyScope | null => {
    const kind = asString(body['scope']);
    if (kind === 'global') return { kind };
    const accountId = asString(body['accountId']);
    return kind === 'account' && accountId ? { kind, accountId } : null;
  };
  return {
    async dashboard(request: AgentRouteRequest): Promise<AgentRouteResponse> {
      if (request.method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const denied = gate(request); if (denied) return denied;
      const auth = request.auth; if (!auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: { dashboard: await service.dashboard(auth) } }; } catch (error) { return errorResponse(error); }
    },
    async answer(request: AgentRouteRequest, questionId: string): Promise<AgentRouteResponse> {
      if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const denied = gate(request); if (denied) return denied;
      const auth = request.auth; if (!auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: await service.answer(auth, questionId, asString(request.body['answer']) ?? '', asNumber(request.body['expectedVersion']), asString(request.body['idempotencyKey']) ?? '') }; } catch (error) { return errorResponse(error); }
    },
    async retry(request: AgentRouteRequest, actionId: string): Promise<AgentRouteResponse> {
      if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const denied = gate(request); if (denied) return denied;
      const auth = request.auth; if (!auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: { action: await service.retry(auth, actionId, asNumber(request.body['expectedVersion'])) } }; } catch (error) { return errorResponse(error); }
    },
    async autonomy(request: AgentRouteRequest): Promise<AgentRouteResponse> {
      if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const denied = gate(request); if (denied) return denied;
      const auth = request.auth; if (!auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      const scope = target(request.body); const state = asString(request.body['state']);
      if (!scope || (state !== 'paused' && state !== 'running')) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'A valid autonomy scope and state are required.' } } };
      try { return { status: 200, body: { state: await service.setAutonomy(auth, scope, state, asNumber(request.body['expectedVersion'])) } }; } catch (error) { return errorResponse(error); }
    },
  };
}
