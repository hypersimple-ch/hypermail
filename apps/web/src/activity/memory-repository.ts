import {
  acknowledgementBlockReason, matchesActivityFilter, type ActivityListInput, type ActivityMutationResult,
  type ActivityPage, type ActivityRecord, type ActivityRepository, type AuthenticatedActivityScope,
} from './contracts.js';

type Cursor = Readonly<{ createdAt: string; id: string }>;
const encodeCursor = (activity: ActivityRecord): string => encodeURIComponent(`${activity.createdAt}|${activity.id}`);
const decodeCursor = (cursor: string): Cursor | null => {
  const [createdAt, id, extra] = decodeURIComponent(cursor).split('|');
  return createdAt && id && extra === undefined ? { createdAt, id } : null;
};
const newestFirst = (left: ActivityRecord, right: ActivityRecord) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
const afterCursor = (activity: ActivityRecord, cursor: Cursor) => newestFirst(activity, { ...activity, createdAt: cursor.createdAt, id: cursor.id }) > 0;

/** Reference repository for adapters/tests. Production persistence implements the same account-scoped contract. */
export class InMemoryActivityRepository implements ActivityRepository {
  private activities: ActivityRecord[];
  constructor(seed: readonly ActivityRecord[]) { this.activities = [...seed]; }

  list(scope: AuthenticatedActivityScope, input: ActivityListInput): Promise<ActivityPage> {
    const visible = this.activities.filter((activity) => scope.accountIds.includes(activity.accountId));
    const counts = {
      new: visible.filter((activity) => matchesActivityFilter(activity, 'new')).length,
      questions: visible.filter((activity) => matchesActivityFilter(activity, 'questions')).length,
      failed: visible.filter((activity) => matchesActivityFilter(activity, 'failed')).length,
      history: visible.filter((activity) => matchesActivityFilter(activity, 'history')).length,
    };
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const search = input.search?.toLocaleLowerCase();
    const filtered = visible.filter((activity) =>
      matchesActivityFilter(activity, input.filter) &&
      (input.accountId === undefined || activity.accountId === input.accountId) &&
      (search === undefined || `${activity.title} ${activity.accountLabel} ${activity.messageLabel}`.toLocaleLowerCase().includes(search)) &&
      (cursor === null || afterCursor(activity, cursor)),
    ).sort(newestFirst);
    const items = filtered.slice(0, input.limit);
    const finalItem = items.at(-1);
    return Promise.resolve({ items, nextCursor: filtered.length > items.length && finalItem ? encodeCursor(finalItem) : null, counts });
  }

  get(scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityRecord | null> {
    return Promise.resolve(this.activities.find((activity) => activity.id === activityId && scope.accountIds.includes(activity.accountId)) ?? null);
  }

  async requestRetry(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult> {
    const activity = await this.get(scope, activityId);
    if (!activity) return { kind: 'not_found' };
    if (activity.version !== expectedVersion) return { kind: 'conflict', currentVersion: activity.version };
    if (activity.state !== 'failed' || !activity.failure || activity.failure.retrying) return { kind: 'blocked', reason: 'Only a failed item that is not already retrying can be retried.' };
    return this.replace(activity, { state: 'new', failure: { ...activity.failure, retrying: true }, jobState: 'pending' });
  }

  async acknowledge(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult> {
    const activity = await this.get(scope, activityId);
    if (!activity) return { kind: 'not_found' };
    if (activity.version !== expectedVersion) return { kind: 'conflict', currentVersion: activity.version };
    const reason = acknowledgementBlockReason(activity);
    if (reason) return { kind: 'blocked', reason };
    return this.replace(activity, { state: 'acknowledged' });
  }

  private replace(activity: ActivityRecord, update: Partial<ActivityRecord>): ActivityMutationResult {
    const next = { ...activity, ...update, version: activity.version + 1, updatedAt: new Date().toISOString() };
    this.activities = this.activities.map((candidate) => candidate.id === activity.id ? next : candidate);
    return { kind: 'updated', activity: next };
  }
}
