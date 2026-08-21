import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/heroui/alert.js';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldError, FieldLabel } from '@/components/heroui/field.js';
import { Textarea } from '@/components/heroui/textarea.js';
import { AppPage, FilterGroup, PageContainer, PageHeader, StatePanel, type FilterOption } from '@/components/app/patterns.js';
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

export type ActivityScreenProps = Readonly<{
  page: ActivityPage;
  filter?: ActivityFilter;
  onFilterChange?: (filter: ActivityFilter) => void;
  onOpen?: (activity: ActivityRecord) => void;
}>;

/** SSR-safe list surface: all mutations are supplied by the host, never initiated during render. */
export function ActivityScreen({ page, filter = 'new', onFilterChange, onOpen }: ActivityScreenProps): React.JSX.Element {
  const filters: FilterOption<ActivityFilter>[] = activityFilters.map((value) => ({ value, label: labels[value], count: page.counts[value] }));
  return <AppPage aria-label="Activity"><PageContainer measure="reading" className="grid gap-4">
    <PageHeader title="Activity" description="Agent work and exceptions" />
    <FilterGroup label="Activity filters" value={filter} options={filters} onChange={(value) => onFilterChange?.(value)} />
    <p className="sr-only" aria-live="polite">{labels[filter]} filter, {page.items.length} items shown.</p>
    {page.items.length === 0 ? <StatePanel title={`No ${labels[filter].toLocaleLowerCase()} activity.`} /> : <ol className="grid list-none gap-3 p-0 m-0">
      {page.items.map((activity) => <li key={activity.id}>
        <Card className="gap-4 py-4">
          <CardContent className="grid min-w-0 gap-3 px-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
            <Badge className="w-fit" variant={statusVariant(activity)}>{status(activity)}</Badge>
            <div className="min-w-0 break-words"><strong>{activity.title}</strong><p className="text-sm text-muted-foreground">{activity.messageLabel} · {activity.accountLabel}</p><time className="block text-sm text-muted-foreground" dateTime={activity.updatedAt}>{activity.updatedAt}</time></div>
            <Button className="justify-self-start" type="button" variant="outline" size="sm" onClick={() => onOpen?.(activity)} aria-label={`Open: ${activity.title}`}>Open</Button>
          </CardContent>
        </Card>
      </li>)}
    </ol>}
  </PageContainer></AppPage>;
}

export type ActivityDetailProps = Readonly<{
  activity: ActivityRecord;
  onRetry?: (activity: ActivityRecord) => void;
  onAcknowledge?: (activity: ActivityRecord) => void;
  onOpenMessage?: (messageId: string) => void;
  onAnswerQuestion?: (question: NonNullable<ActivityRecord['question']>, answer: string) => Promise<void> | void;
  onBack?: () => void;
  error?: string;
  pendingAction?: 'retry' | 'acknowledge';
}>;

export function ActivityDetail({ activity, onRetry, onAcknowledge, onOpenMessage, onAnswerQuestion, onBack, error, pendingAction }: ActivityDetailProps): React.JSX.Element {
  const acknowledgementReason = acknowledgementBlockReason(activity);
  return <AppPage><PageContainer measure="reading" className="grid gap-4">{onBack ? <Button type="button" variant="ghost" className="w-fit" onClick={onBack}><ArrowLeft aria-hidden="true" />Activity</Button> : null}{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}<article aria-label={`Activity detail: ${activity.title}`} className="grid min-w-0 gap-4">
    <Card>
      <CardHeader className="min-w-0"><Badge className="w-fit" variant={statusVariant(activity)}>{status(activity)}</Badge><CardTitle className="break-words">{activity.title}</CardTitle><CardDescription className="break-words">{activity.messageLabel} · {activity.accountLabel}</CardDescription></CardHeader>
    </Card>
    {activity.question?.state === 'open' ? <QuestionCard question={activity.question} onAnswer={onAnswerQuestion} /> : null}
    {activity.failure ? <Card aria-label="Failure and retry"><CardHeader><CardTitle>{activity.failure.retrying ? 'Retrying' : 'Failed'}</CardTitle><CardDescription>{activity.failure.code}: {activity.failure.message}</CardDescription></CardHeader><CardFooter><Button type="button" disabled={activity.failure.retrying || pendingAction === 'retry'} onClick={() => onRetry?.(activity)}>{activity.failure.retrying || pendingAction === 'retry' ? 'Retrying…' : 'Retry'}</Button></CardFooter></Card> : null}
    <AgentCardPlaceholder />
    {activity.runs ? <Card aria-label="Agent work history"><CardHeader><CardTitle>Agent work history</CardTitle><CardDescription>Immutable Runs and authorized mailbox Actions.</CardDescription></CardHeader><CardContent className="min-w-0"><ol className="grid min-w-0 gap-3">{activity.runs.map((run)=><li className="min-w-0 break-words" key={run.id}><strong>Run {run.sequence}</strong> · {run.state}{run.outcome?` · ${run.outcome}`:''}<br/><span className="text-sm text-muted-foreground">{run.managerKind} · {run.mode} · assignment r{run.assignmentRevision} · grant r{run.grantRevision} · safety r{run.safetyRevision}</span><ul className="mt-1 grid gap-1 pl-5">{activity.actions?.filter((item)=>item.runId===run.id).map((item)=><li className="break-words" key={item.id}>{item.kind}: {item.state} · authorization r{item.authorizationRevision}{item.verification?` · verified by ${item.verification.verifier}`:''}</li>)}</ul></li>)}</ol></CardContent></Card> : null}
    <Card><CardHeader><CardTitle>Timeline</CardTitle></CardHeader><CardContent className="min-w-0"><ol className="grid gap-3">{activity.timeline.map((event) => <li className="min-w-0 break-words" key={event.id}><time className="block text-sm text-muted-foreground" dateTime={event.at}>{event.at}</time>{event.label}{event.detail ? `: ${event.detail}` : ''}</li>)}</ol></CardContent></Card>
    <Card><CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">{activity.messageId ? <Button type="button" variant="outline" onClick={() => onOpenMessage?.(activity.messageId as string)}>Open original message</Button> : null}<Button type="button" disabled={acknowledgementReason !== null || pendingAction === 'acknowledge'} aria-describedby={acknowledgementReason ? 'activity-acknowledgement-reason' : undefined} onClick={() => onAcknowledge?.(activity)}>{pendingAction === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}</Button>{acknowledgementReason ? <p id="activity-acknowledgement-reason" role="status" className="w-full text-sm text-muted-foreground">{acknowledgementReason}</p> : null}</CardFooter></Card>
  </article></PageContainer></AppPage>;
}

function QuestionCard({ question, onAnswer }: { question: NonNullable<ActivityRecord['question']>; onAnswer?: ActivityDetailProps['onAnswerQuestion'] }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [error, setError] = React.useState('');
  const answerId = `activity-answer-${question.id ?? 'open'}`;
  const errorId = `${answerId}-error`;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get('answer');
    if (typeof answer !== 'string' || !answer.trim() || !onAnswer) return;
    setPending(true);
    setNotice('');
    setError('');
    void Promise.resolve(onAnswer(question, answer.trim())).then(() => {
      setNotice('Answer recorded. A continuation Run will appear in Agent work history.');
    }).catch(() => {
      setError('Could not record the answer. Your text is still here; reconnect and try again.');
    }).finally(() => {
      setPending(false);
    });
  };
  return <Card aria-label="Open question"><CardHeader><CardTitle>Question needs your input</CardTitle><CardDescription>{question.prompt}</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="grid gap-3"><Field><FieldLabel htmlFor={answerId}>Your answer</FieldLabel><Textarea id={answerId} name="answer" required disabled={pending} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />{error ? <FieldError id={errorId}>{error}</FieldError> : null}</Field><Button type="submit" variant="outline" disabled={pending || !onAnswer}>{pending ? 'Recording…' : 'Answer and continue'}</Button><p role="status" aria-live="polite" className="text-sm">{notice}</p></form></CardContent></Card>;
}

/** Deliberately inert placeholder; it conveys available context without introducing agent behavior. */
export function AgentCardPlaceholder(): React.JSX.Element {
  return <Card aria-label="Agent context placeholder"><CardHeader><CardTitle>Agent context</CardTitle><CardDescription>Details will appear here when available.</CardDescription></CardHeader></Card>;
}

export { matchesActivityFilter };
