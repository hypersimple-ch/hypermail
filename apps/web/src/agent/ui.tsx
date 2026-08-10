import * as React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/heroui/alert.js';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldLabel } from '@/components/heroui/field.js';
import { Textarea } from '@/components/heroui/textarea.js';
import type { AgentAction, AgentAlert, AgentDashboard, AgentQuestion, AutonomyScope, AutonomyState } from './contracts.js';

export type AgentUiHandlers = Readonly<{
  onAnswer?: (input: Readonly<{ questionId: string; answer: string; expectedVersion: number; idempotencyKey: string }>) => void;
  onRetry?: (action: AgentAction) => void;
  onAutonomy?: (target: AutonomyScope, state: AutonomyState, expectedVersion: number) => void;
}>;

export function AgentAlerts({ alerts }: Readonly<{ alerts: readonly AgentAlert[] }>): React.JSX.Element {
  return <section aria-label="Agent safety and account status" data-polling="continues" className="grid gap-2">
    {alerts.map((alert) => <Alert key={alert.id} variant={alert.kind === 'poll_failure' ? 'destructive' : 'default'}>
      <AlertTitle>{alert.kind.replaceAll('_', ' ')}:</AlertTitle>
      <AlertDescription>{alert.message}</AlertDescription>
    </Alert>)}
  </section>;
}

export function AgentActionCard({ action, onRetry }: Readonly<{ action: AgentAction; onRetry?: (action: AgentAction) => void }>): React.JSX.Element {
  const canRetry = action.status === 'failed' || action.status === 'blocked';
  return <Card aria-label={`Agent action: ${action.title}`}>
    <CardHeader>
      <CardTitle>{action.title}</CardTitle>
      <CardDescription><strong>Why: </strong>{action.reason}</CardDescription>
    </CardHeader>
    <CardContent className="grid gap-3">
      <p><strong>Outcome: </strong>{action.outcome ?? 'Waiting for an outcome.'}</p>
      <p><strong>Verification: </strong>{action.verification ?? 'Verification pending.'}</p>
      <Badge variant={action.status === 'failed' || action.status === 'blocked' ? 'destructive' : 'secondary'}>Status: {action.status}</Badge>
      <div className="flex flex-wrap gap-2">
        {canRetry ? <Button type="button" variant="outline" size="sm" onClick={() => onRetry?.(action)} aria-label={`Retry ${action.title}`}>Retry</Button> : null}
        {action.recoverable && action.reversalHref ? <Button asChild variant="link" size="sm"><a href={action.reversalHref}>Review reversal</a></Button> : null}
      </div>
    </CardContent>
  </Card>;
}

export function AgentQuestionSheet({ question, idempotencyKey, pending = false, onAnswer }: Readonly<{
  question: AgentQuestion;
  idempotencyKey: string;
  pending?: boolean;
  onAnswer?: AgentUiHandlers['onAnswer'];
}>): React.JSX.Element {
  const inputId = `agent-answer-${question.id}`;
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get('answer');
    onAnswer?.({ questionId: question.id, answer: typeof answer === 'string' ? answer : '', expectedVersion: question.version, idempotencyKey });
  };
  return <Card role="dialog" aria-modal="true" aria-labelledby={`${inputId}-title`}>
    <CardHeader>
      <CardTitle id={`${inputId}-title`}>Agent needs your answer</CardTitle>
      <CardDescription>{question.prompt}</CardDescription>
    </CardHeader>
    <CardContent>
      <form onSubmit={submit} className="grid gap-4">
        <Field>
          <FieldLabel htmlFor={inputId}>Your answer</FieldLabel>
          <Textarea id={inputId} name="answer" required rows={3} disabled={pending} />
          <FieldDescription>Submitting records your answer and resumes this work once. Repeating a submission is safe.</FieldDescription>
        </Field>
        <Button type="submit" disabled={pending}>{pending ? 'Recording answer…' : 'Answer and resume'}</Button>
      </form>
    </CardContent>
  </Card>;
}

export function AutonomyControls({ dashboard, handlers = {} }: Readonly<{ dashboard: AgentDashboard; handlers?: AgentUiHandlers }>): React.JSX.Element {
  const control = (label: string, target: AutonomyScope, status: AgentDashboard['autonomy']['global']) => {
    const next: AutonomyState = status.state === 'paused' ? 'running' : 'paused';
    return <div className="flex flex-wrap items-center justify-between gap-3" key={label}>
      <span>{label}: {status.state === 'paused' ? 'Paused' : 'Active'}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => handlers.onAutonomy?.(target, next, status.version)} aria-pressed={status.state === 'paused'}>{next === 'paused' ? 'Pause' : 'Resume'}</Button>
    </div>;
  };
  return <Card aria-label="Agent autonomy controls">
    <CardHeader><CardTitle>Autonomy</CardTitle></CardHeader>
    <CardContent className="grid gap-3">
      {control('All accounts', { kind: 'global' }, dashboard.autonomy.global)}
      {Object.entries(dashboard.autonomy.accounts).map(([accountId, state]) => control(`Account ${accountId}`, { kind: 'account', accountId }, state))}
    </CardContent>
  </Card>;
}

/** SSR-safe: no browser globals, effects, storage, or opaque-memory data are accessed. */
export function AgentPanel({ dashboard, idempotencyKey, handlers = {}, error }: Readonly<{ dashboard: AgentDashboard; idempotencyKey: string; handlers?: AgentUiHandlers; error?: string | undefined }>): React.JSX.Element {
  const openQuestion = dashboard.questions.find((question) => question.state === 'open');
  return <aside aria-label="Agent" className="grid min-w-0 gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <AgentAlerts alerts={dashboard.alerts} />
    <Card><CardContent className="pt-6 text-sm text-muted-foreground">Memory is active to help the agent, but it is not inspectable in milestone one.</CardContent></Card>
    <AutonomyControls dashboard={dashboard} handlers={handlers} />
    <section aria-label="Agent actions" className="grid gap-3"><h2 className="text-lg font-semibold">Agent actions</h2>{dashboard.actions.map((action) => <AgentActionCard key={action.id} action={action} {...(handlers.onRetry === undefined ? {} : { onRetry: handlers.onRetry })} />)}</section>
    {openQuestion ? <AgentQuestionSheet question={openQuestion} idempotencyKey={idempotencyKey} {...(handlers.onAnswer === undefined ? {} : { onAnswer: handlers.onAnswer })} /> : null}
    <p aria-live="polite" className="min-h-6 text-sm text-muted-foreground">Agent status updates while polling continues.</p>
  </aside>;
}
