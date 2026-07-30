/** Framework-neutral activity contracts. State names mirror @hypermail/contracts. */
export type DomainActivityState = 'new' | 'waiting_question' | 'failed' | 'handled' | 'acknowledged';
export type ActivityFilter = 'new' | 'questions' | 'failed' | 'history';
export type ActivityJobState = 'pending' | 'running' | 'suspended' | 'succeeded' | 'failed' | 'cancelled';

export type AuthenticatedActivityScope = Readonly<{
  subjectId: string;
  accountIds: readonly string[];
}>;

export type ActivityQuestion = Readonly<{ prompt: string; state: 'open' | 'answered' | 'cancelled' }>;
export type ActivityFailure = Readonly<{ code: string; message: string; retrying: boolean }>;
export type ActivityTimelineEvent = Readonly<{ id: string; at: string; label: string; detail?: string }>;

export type ActivityRecord = Readonly<{
  id: string;
  accountId: string;
  messageId: string;
  state: DomainActivityState;
  version: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  accountLabel: string;
  messageLabel: string;
  question?: ActivityQuestion;
  failure?: ActivityFailure;
  jobState?: ActivityJobState;
  timeline: readonly ActivityTimelineEvent[];
}>;

export type ActivityListInput = Readonly<{
  filter: ActivityFilter;
  accountId?: string;
  search?: string;
  cursor?: string;
  limit: number;
}>;
export type ActivityPage = Readonly<{ items: readonly ActivityRecord[]; nextCursor: string | null; counts: Readonly<Record<ActivityFilter, number>> }>;

/** Repositories must scope every read and mutation to the authenticated account set. */
export interface ActivityRepository {
  list(scope: AuthenticatedActivityScope, input: ActivityListInput): Promise<ActivityPage>;
  get(scope: AuthenticatedActivityScope, activityId: string): Promise<ActivityRecord | null>;
  requestRetry(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult>;
  acknowledge(scope: AuthenticatedActivityScope, activityId: string, expectedVersion: number): Promise<ActivityMutationResult>;
}
export type ActivityMutationResult =
  | Readonly<{ kind: 'updated'; activity: ActivityRecord }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; currentVersion: number }>
  | Readonly<{ kind: 'blocked'; reason: string }>;

export class ActivityInputError extends Error { constructor(message: string) { super(message); this.name = 'ActivityInputError'; } }
export class ActivityConflictError extends Error { constructor() { super('Activity changed; refresh and try again.'); this.name = 'ActivityConflictError'; } }
export class ActivityBlockedError extends Error { constructor(message: string) { super(message); this.name = 'ActivityBlockedError'; } }
export class ActivityNotFoundError extends Error { constructor() { super('Activity not found.'); this.name = 'ActivityNotFoundError'; } }

export const activityFilters: readonly ActivityFilter[] = ['new', 'questions', 'failed', 'history'];

/** Handled work deliberately stays in New until a person acknowledges it. */
export function matchesActivityFilter(activity: ActivityRecord, filter: ActivityFilter): boolean {
  if (filter === 'new') return activity.state === 'new' || activity.state === 'handled';
  if (filter === 'questions') return activity.state === 'waiting_question';
  if (filter === 'failed') return activity.state === 'failed';
  return activity.state === 'acknowledged';
}

export function acknowledgementBlockReason(activity: ActivityRecord): string | null {
  if (activity.state === 'waiting_question' || activity.question?.state === 'open') return 'Answer the open question before acknowledging.';
  if (activity.state === 'failed' || activity.failure?.retrying || activity.jobState === 'pending' || activity.jobState === 'running') return 'Wait for the failed or retrying work to finish before acknowledging.';
  if (activity.state !== 'handled') return 'Only handled work can be acknowledged.';
  return null;
}
