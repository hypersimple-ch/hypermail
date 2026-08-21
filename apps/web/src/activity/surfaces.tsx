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
  onAnswerQuestion?: (question: NonNullable<ActivityRecord['question']>, answer: string) => Promise<void> | void;
}>;

export function ActivityDetail({ activity, onRetry, onAcknowledge, onOpenMessage, onAnswerQuestion }: ActivityDetailProps): React.JSX.Element {
  const acknowledgementReason = acknowledgementBlockReason(activity);
  return <article aria-label={`Activity detail: ${activity.title}`} className="mx-auto grid min-w-0 max-w-4xl gap-4 p-4">
    <Card>
      <CardHeader><Badge variant={statusVariant(activity)}>{status(activity)}</Badge><CardTitle>{activity.title}</CardTitle><CardDescription>{activity.messageLabel} · {activity.accountLabel}</CardDescription></CardHeader>
    </Card>
    {activity.question?.state === 'open' ? <QuestionCard question={activity.question} onAnswer={onAnswerQuestion} /> : null}
    {activity.failure ? <Card aria-label="Failure and retry"><CardHeader><CardTitle>{activity.failure.retrying ? 'Retrying' : 'Failed'}</CardTitle><CardDescription>{activity.failure.code}: {activity.failure.message}</CardDescription></CardHeader><CardFooter><Button type="button" disabled={activity.failure.retrying} onClick={() => onRetry?.(activity)}>{activity.failure.retrying ? 'Retrying' : 'Retry'}</Button></CardFooter></Card> : null}
    <AgentCardPlaceholder />
    {activity.runs ? <Card aria-label="Agent work history"><CardHeader><CardTitle>Agent work history</CardTitle><CardDescription>Immutable Runs and authorized mailbox Actions.</CardDescription></CardHeader><CardContent className="grid gap-3"><ol className="grid gap-2">{activity.runs.map((run)=><li key={run.id}><strong>Run {run.sequence}</strong> · {run.state}{run.outcome?` · ${run.outcome}`:''}<br/><span className="text-sm text-muted-foreground">{run.managerKind} · {run.mode} · assignment r{run.assignmentRevision} · grant r{run.grantRevision} · safety r{run.safetyRevision}</span><ul>{activity.actions?.filter((item)=>item.runId===run.id).map((item)=><li key={item.id}>{item.kind}: {item.state} · authorization r{item.authorizationRevision}{item.verification?` · verified by ${item.verification.verifier}`:''}</li>)}</ul></li>)}</ol></CardContent></Card> : null}
    <Card><CardHeader><CardTitle>Timeline</CardTitle></CardHeader><CardContent><ol className="grid gap-3"><>{activity.timeline.map((event) => <li key={event.id}><time dateTime={event.at}>{event.at}</time> {event.label}{event.detail ? `: ${event.detail}` : ''}</li>)}</></ol></CardContent></Card>
    <Card><CardFooter className="flex flex-wrap gap-2">{activity.messageId ? <Button type="button" variant="outline" onClick={() => onOpenMessage?.(activity.messageId as string)}>Open original message</Button> : null}<Button type="button" disabled={acknowledgementReason !== null} aria-describedby={acknowledgementReason ? 'activity-acknowledgement-reason' : undefined} onClick={() => onAcknowledge?.(activity)}>Acknowledge</Button>{acknowledgementReason ? <p id="activity-acknowledgement-reason" role="status" className="w-full text-sm text-muted-foreground">{acknowledgementReason}</p> : null}</CardFooter></Card>
  </article>;
}

function QuestionCard({ question, onAnswer }: { question: NonNullable<ActivityRecord['question']>; onAnswer?: ActivityDetailProps['onAnswerQuestion'] }): React.JSX.Element {
  const [pending,setPending]=React.useState(false); const [notice,setNotice]=React.useState('');
  const submit=(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();const answer=new FormData(event.currentTarget).get('answer');if(typeof answer!=='string'||!answer.trim()||!onAnswer)return;setPending(true);setNotice('');void Promise.resolve(onAnswer(question,answer.trim())).then(()=>{setNotice('Answer recorded. A continuation Run will appear in Agent work history.');}).catch(()=>{setNotice('Could not record the answer. Your text is still here; reconnect and try again.');}).finally(()=>{setPending(false);});};
  return <Card aria-label="Open question"><CardHeader><CardTitle>Question needs your input</CardTitle><CardDescription>{question.prompt}</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="grid gap-2"><label htmlFor={`activity-answer-${question.id??'open'}`} className="text-sm font-medium">Your answer</label><textarea id={`activity-answer-${question.id??'open'}`} name="answer" required disabled={pending} className="min-h-24 rounded-md border p-2"/><Button type="submit" variant="outline" disabled={pending||!onAnswer}>{pending?'Recording…':'Answer and continue'}</Button><p role="status" aria-live="polite" className="text-sm">{notice}</p></form></CardContent></Card>;
}

/** Deliberately inert placeholder; it conveys available context without introducing agent behavior. */
export function AgentCardPlaceholder(): React.JSX.Element {
  return <Card aria-label="Agent context placeholder"><CardHeader><CardTitle>Agent context</CardTitle><CardDescription>Details will appear here when available.</CardDescription></CardHeader></Card>;
}

export { matchesActivityFilter };
