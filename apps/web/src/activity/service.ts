import {
  acknowledgementBlockReason, activityFilters, type ActivityListInput, type ActivityPage,
  type ActivityRecord, type ActivityRepository, ActivityBlockedError, ActivityConflictError, ActivityInputError, ActivityNotFoundError,
  type AuthenticatedActivityScope,
} from './contracts.js';

const maxSearchLength = 120;
const maxPageSize = 50;

export class ActivityService {
  constructor(private readonly repository: ActivityRepository) {}

  async list(scope: AuthenticatedActivityScope, input: Partial<ActivityListInput> = {}): Promise<ActivityPage> {
    this.assertScope(scope);
    const filter = input.filter ?? 'new';
    if (!activityFilters.includes(filter)) throw new ActivityInputError('Unknown activity filter.');
    if (input.accountId !== undefined && !scope.accountIds.includes(input.accountId)) throw new ActivityNotFoundError();
    const search = input.search?.trim();
    if (search !== undefined && search.length > maxSearchLength) throw new ActivityInputError(`Search is limited to ${String(maxSearchLength)} characters.`);
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxPageSize) throw new ActivityInputError(`Page size must be between 1 and ${String(maxPageSize)}.`);
    return this.repository.list(scope, {
      filter, limit,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(search ? { search } : {}),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  }

  async detail(scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityRecord> {
    this.assertScope(scope);
    const activity = await this.repository.get(scope, activityId);
    if (!activity) throw new ActivityNotFoundError();
    return activity;
  }

  async retry(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityRecord> {
    this.assertScope(scope); this.assertVersion(expectedVersion);
    const result = await this.repository.requestRetry(scope, activityId, expectedVersion);
    return this.unwrapMutation(result);
  }

  async acknowledge(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityRecord> {
    this.assertScope(scope); this.assertVersion(expectedVersion);
    const current = await this.detail(scope, activityId);
    const blocked = acknowledgementBlockReason(current);
    if (blocked) throw new ActivityBlockedError(blocked);
    const result = await this.repository.acknowledge(scope, activityId, expectedVersion);
    return this.unwrapMutation(result);
  }

  private assertScope(scope: AuthenticatedActivityScope): void {
    if (!scope.subjectId || scope.accountIds.length === 0) throw new ActivityInputError('An authenticated account scope is required.');
  }
  private assertVersion(version: number): void { if (!Number.isInteger(version) || version < 1) throw new ActivityInputError('A positive expected version is required.'); }
  private unwrapMutation(result: Awaited<ReturnType<ActivityRepository['acknowledge']>>): ActivityRecord {
    if (result.kind === 'updated') return result.activity;
    if (result.kind === 'conflict') throw new ActivityConflictError();
    if (result.kind === 'blocked') throw new ActivityBlockedError(result.reason);
    throw new ActivityNotFoundError();
  }
}

/** Browser-ready behavioral contract inventory; no browser host is assumed by this package. */
export const activityBrowserScenarios = [
  'An authenticated user can switch New, Questions, Failed, and History without horizontal overflow at 360px.',
  'An open question and a failed or retrying item expose a written blocking reason and cannot acknowledge.',
  'A handled item remains in New until acknowledgement, then appears in searchable History.',
  'Retry and acknowledgement send the displayed optimistic version and announce the result.',
] as const;
