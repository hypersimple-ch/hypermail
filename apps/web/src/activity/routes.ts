import { ActivityBlockedError, ActivityConflictError, ActivityInputError, ActivityNotFoundError } from './contracts.js';
import type { AuthenticatedActivityScope } from './contracts.js';
import type { ActivityService } from './service.js';

export type ActivityRouteRequest = Readonly<{
  method: string;
  auth: AuthenticatedActivityScope | null;
  query: Readonly<Record<string, string | undefined>>;
  body: Readonly<Record<string, unknown>>;
}>;
export type ActivityRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number => typeof value === 'number' ? value : Number(value);
const errorResponse = (error: unknown): ActivityRouteResponse => {
  if (error instanceof ActivityInputError) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: error.message } } };
  if (error instanceof ActivityConflictError) return { status: 409, body: { error: { code: 'CONFLICT', message: error.message } } };
  if (error instanceof ActivityBlockedError) return { status: 409, body: { error: { code: 'BLOCKED', message: error.message } } };
  if (error instanceof ActivityNotFoundError) return { status: 404, body: { error: { code: 'NOT_FOUND', message: error.message } } };
  throw error;
};

/** Fetch/Next/etc. adapters authenticate first, then translate inputs into this small route contract. */
export function createActivityRoutes(service: ActivityService) {
  const scope = (request: ActivityRouteRequest): AuthenticatedActivityScope | null => request.auth;
  return {
    async list(request: ActivityRouteRequest): Promise<ActivityRouteResponse> {
      if (request.method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const authenticated = scope(request); if (!authenticated) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try {
        const query = request.query;
        const filter = string(query['filter']) as 'new' | 'questions' | 'failed' | 'history' | undefined;
        const accountId = string(query['accountId']); const search = string(query['search']); const cursor = string(query['cursor']);
        const limit = query['limit'] === undefined ? undefined : number(query['limit']);
        return { status: 200, body: await service.list(authenticated, {
          ...(filter === undefined ? {} : { filter }), ...(accountId === undefined ? {} : { accountId }),
          ...(search === undefined ? {} : { search }), ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }) };
      } catch (error) { return errorResponse(error); }
    },
    async detail(request: ActivityRouteRequest, activityId: string): Promise<ActivityRouteResponse> {
      if (request.method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const authenticated = scope(request); if (!authenticated) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: { activity: await service.detail(authenticated, activityId) } }; } catch (error) { return errorResponse(error); }
    },
    async retry(request: ActivityRouteRequest, activityId: string): Promise<ActivityRouteResponse> {
      if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const authenticated = scope(request); if (!authenticated) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: { activity: await service.retry(authenticated, activityId, number(request.body['expectedVersion'])) } }; } catch (error) { return errorResponse(error); }
    },
    async acknowledge(request: ActivityRouteRequest, activityId: string): Promise<ActivityRouteResponse> {
      if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
      const authenticated = scope(request); if (!authenticated) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      try { return { status: 200, body: { activity: await service.acknowledge(authenticated, activityId, number(request.body['expectedVersion'])) } }; } catch (error) { return errorResponse(error); }
    },
  };
}
