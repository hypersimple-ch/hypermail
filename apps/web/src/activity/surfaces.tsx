import * as React from 'react';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { FilterGroup, PageHeader, StatePanel, type FilterOption } from '@/components/app/patterns.js';
import { acknowledgementBlockReason, activityFilters, matchesActivityFilter, type ActivityFilter, type ActivityPage, type ActivityRecord } from './contracts.js';

const labels: Record<ActivityFilter, string> = { new: 'New', questions: 'Questions', failed: 'Failed', history: 'History' };
const status = (activity: ActivityRecord): string => {
  if (activity.failure?.retrying) return 'Retrying';
  if (activity.state === 'waiting_question') return 'Needs input';
  if (activity.state === 'failed') return 'Failed';
  if (activity.state === 'acknowledged') return 'Acknowledged';
  return activity.state === 'handled' ? 'Handled — acknowledge' : 'New';
};
const statusVariant = (activity: ActivityRecord): 'default' | 'secondary' | 'destructive' | 'outline' => activity.state === 'failed' ? 'destructive' : activity.state === 'waiting_question' ? 'outline' : activity.state === 'acknowledged' ? 'secondary' : 'default';
const action = (activity: ActivityRecord): string => activity.state === 'failed' ? (activity.failure?.retrying ? 'Retrying' : 'Retry') : activity.state === 'waiting_question' ? 'Answer question' : activity.state === 'handled' ? 'Acknowledge' : 'Open';

export type ActivityScreenProps = Readonly<{
  page: ActivityPage;
  filter?: ActivityFilter;
  onFilterChange?: (filter: ActivityFilter) => void;
  onOpen?: (activity: ActivityRecord) => void;
}>;

/** SSR-safe list surface: all mutations are supplied by the host, never initiated during render. */
export function ActivityScreen({ page, filter = 'new', onFilterChange, onOpen }: ActivityScreenProps): React.JSX.Element {
  const filters: FilterOption<ActivityFilter>[] = activityFilters.map((value) => ({ value, label: labels[value], count: page.counts[value] }));
  return <section aria-label="Activity" className="mx-auto grid min-w-0 max-w-4xl gap-4 p-4">
    <PageHeader title="Activity" description="Agent work and exceptions" />
    <FilterGroup label="Activity filters" value={filter} options={filters} onChange={(value) => onFilterChange?.(value)} />
    <p className="sr-only" aria-live="polite">{labels[filter]} filter, {page.items.length} items shown.</p>
    {page.items.length === 0 ? <StatePanel title={`No ${labels[filter].toLocaleLowerCase()} activity.`} /> : <ol className="grid list-none gap-3 p-0 m-0">
      {page.items.map((activity) => <li key={activity.id}>
        <Card className="gap-4 py-4">
          <CardContent className="grid min-w-0 gap-3 px-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="grid min-w-0 gap-2"><Badge variant={statusVariant(activity)}>{status(activity)}</Badge><div className="min-w-0"><strong>{activity.title}</strong><p className="truncate text-sm text-muted-foreground">{activity.messageLabel} · {activity.accountLabel}</p><time className="block truncate text-sm text-muted-foreground" dateTime={activity.updatedAt}>{activity.updatedAt}</time></div></div>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen?.(activity)} aria-label={`${action(activity)}: ${activity.title}`}>{action(activity)}</Button>
          </CardContent>
        </Card>
      </li>)}
    </ol>}
  </section>;
}

export type ActivityDetailProps = Readonly<{
  activity: ActivityRecord;
  onRetry?: (activity: ActivityRecord) => void;
  onAcknowledge?: (activity: ActivityRecord) => void;
  onOpenMessage?: (messageId: string) => void;
}>;

export function ActivityDetail({ activity, onRetry, onAcknowledge, onOpenMessage }: ActivityDetailProps): React.JSX.Element {
  const acknowledgementReason = acknowledgementBlockReason(activity);
  return <article aria-label={`Activity detail: ${activity.title}`} className="mx-auto grid min-w-0 max-w-4xl gap-4 p-4">
    <Card>
      <CardHeader><Badge variant={statusVariant(activity)}>{status(activity)}</Badge><CardTitle>{activity.title}</CardTitle><CardDescription>{activity.messageLabel} · {activity.accountLabel}</CardDescription></CardHeader>
    </Card>
    {activity.question?.state === 'open' ? <Card aria-label="Open question"><CardHeader><CardTitle>Question needs your input</CardTitle><CardDescription>{activity.question.prompt}</CardDescription></CardHeader><CardFooter><Button type="button" variant="outline">Answer question</Button></CardFooter></Card> : null}
    {activity.failure ? <Card aria-label="Failure and retry"><CardHeader><CardTitle>{activity.failure.retrying ? 'Retrying' : 'Failed'}</CardTitle><CardDescription>{activity.failure.code}: {activity.failure.message}</CardDescription></CardHeader><CardFooter><Button type="button" disabled={activity.failure.retrying} onClick={() => onRetry?.(activity)}>{activity.failure.retrying ? 'Retrying' : 'Retry'}</Button></CardFooter></Card> : null}
    <AgentCardPlaceholder />
    <Card><CardHeader><CardTitle>Timeline</CardTitle></CardHeader><CardContent><ol className="grid gap-3"><>{activity.timeline.map((event) => <li key={event.id}><time dateTime={event.at}>{event.at}</time> {event.label}{event.detail ? `: ${event.detail}` : ''}</li>)}</></ol></CardContent></Card>
    <Card><CardFooter className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => onOpenMessage?.(activity.messageId)}>Open original message</Button><Button type="button" disabled={acknowledgementReason !== null} aria-describedby={acknowledgementReason ? 'activity-acknowledgement-reason' : undefined} onClick={() => onAcknowledge?.(activity)}>Acknowledge</Button>{acknowledgementReason ? <p id="activity-acknowledgement-reason" role="status" className="w-full text-sm text-muted-foreground">{acknowledgementReason}</p> : null}</CardFooter></Card>
  </article>;
}

/** Deliberately inert placeholder; it conveys available context without introducing agent behavior. */
export function AgentCardPlaceholder(): React.JSX.Element {
  return <Card aria-label="Agent context placeholder"><CardHeader><CardTitle>Agent context</CardTitle><CardDescription>Details will appear here when available.</CardDescription></CardHeader></Card>;
}

export { matchesActivityFilter };
