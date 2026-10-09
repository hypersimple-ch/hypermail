import * as React from 'react';
import { SessionExpiredError } from '../lib/authenticated-fetch.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/heroui/alert.js';
import { Badge } from '@/components/heroui/badge.js';
import { Link } from '@heroui/react/link';
import { Button, buttonVariants } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldLabel } from '@/components/heroui/field.js';
import { Textarea } from '@/components/heroui/textarea.js';
import { Input } from '@/components/heroui/input.js';
import { ownerActionCorrectionSchema, type DraftBodyFormat, type OwnerActionCorrection, type Recipient } from '@hypermail/contracts';
import type { AgentAction, AgentAlert, AgentDashboard, AgentProposal, AgentQuestion, AutonomyScope, AutonomyState, ProposalFolder, ProposalReviewRequest } from './contracts.js';
import { Select } from '@/components/heroui/select.js';

export type AgentUiHandlers = Readonly<{
  onAnswer?: (input: Readonly<{ questionId: string; answer: string; expectedVersion: number; idempotencyKey: string }>) => void;
  onRetry?: (action: AgentAction) => void;
  onAutonomy?: (target: AutonomyScope, state: AutonomyState, expectedVersion: number) => void;
  onReview?: (input: ProposalReviewRequest) => Promise<void>;
  onReloadProposals?: () => Promise<void>;
}>;


export type AgentProposalCardProps = Readonly<{
  proposal: AgentProposal;
  proposalFolders?: readonly ProposalFolder[];
  onReview?: AgentUiHandlers['onReview'];
  onReloadProposals?: AgentUiHandlers['onReloadProposals'];
}>;

/** The displayed score is descriptive only; review eligibility comes from durable state. */
export function AgentProposalCard({ proposal, proposalFolders = [], onReview, onReloadProposals }: AgentProposalCardProps): React.JSX.Element {
  const payload = proposal.payload;
  const draft = 'draft' in payload ? payload.draft : undefined;
  const [correcting, setCorrecting] = React.useState(false);
  const [snapshotOpen, setSnapshotOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [kind, setKind] = React.useState<OwnerActionCorrection['kind']>(payload.kind);
  const [reason, setReason] = React.useState('');
  const [folderId, setFolderId] = React.useState('destinationFolderId' in payload.target ? payload.target.destinationFolderId : '');
  const [addresses, setAddresses] = React.useState<Record<Recipient['kind'], string>>({
    to: draft?.recipients.filter((recipient) => recipient.kind === 'to').map((recipient) => recipient.address).join(', ') ?? '',
    cc: draft?.recipients.filter((recipient) => recipient.kind === 'cc').map((recipient) => recipient.address).join(', ') ?? '',
    bcc: draft?.recipients.filter((recipient) => recipient.kind === 'bcc').map((recipient) => recipient.address).join(', ') ?? '',
  });
  const [subject, setSubject] = React.useState(draft?.subject ?? '');
  const [body, setBody] = React.useState(draft?.body ?? '');
  const [bodyFormat, setBodyFormat] = React.useState<DraftBodyFormat>(draft?.bodyFormat ?? 'markdown');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [recorded, setRecorded] = React.useState(false);
  const inFlight = React.useRef(false);
  const submission = React.useRef<{ digest: string; key: string } | null>(null);
  const folders = proposalFolders.filter((folder) => folder.accountId === proposal.accountId);
  const messageTarget = 'messageId' in payload.target;
  const kinds: readonly OwnerActionCorrection['kind'][] = messageTarget ? ['archive', 'move', 'recoverable_trash', 'draft_create'] : ['draft_edit'];
  const disabled = pending || conflict || recorded || !onReview || proposal.state !== 'waiting_review';
  const inputId = `proposal-${proposal.id}`;

  const review = async (decision: ProposalReviewRequest['decision']): Promise<void> => {
    if (disabled || inFlight.current) return;
    setError('');
    let correction: OwnerActionCorrection | undefined;
    if (decision === 'correct') {
      const target = 'messageId' in payload.target
        ? { accountId: payload.target.accountId, messageId: payload.target.messageId }
        : { accountId: payload.target.accountId, draftId: payload.target.draftId };
      if (kind === 'move' && !folders.some((folder) => folder.id === folderId)) {
        setError('Choose an available folder from this mailbox.');
        return;
      }
      const recipients: Recipient[] = (['to', 'cc', 'bcc'] as const).flatMap((recipientKind) =>
        addresses[recipientKind].split(',').map((address) => address.trim()).filter(Boolean).map((address) => ({ kind: recipientKind, address })));
      const parsed = ownerActionCorrectionSchema.safeParse({
        kind, target: kind === 'move' ? { ...target, destinationFolderId: folderId } : target, reason,
        ...(kind === 'draft_create' || kind === 'draft_edit' ? { draft: { recipients, subject, body, bodyFormat } } : {}),
        ...(kind === 'draft_edit' && payload.kind === 'draft_edit' ? { expectedVersion: payload.expectedVersion } : {}),
      });
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
        return;
      }
      correction = parsed.data;
    } else if (reason.length > 2_000) {
      setError('The review comment must be at most 2000 characters.');
      return;
    }
    const content = { proposalId: proposal.id, expectedRevision: proposal.revision, decision, ...(reason.trim() ? { reason } : {}), ...(correction ? { correction } : {}) };
    const digest = JSON.stringify(content);
    if (submission.current?.digest !== digest) submission.current = { digest, key: crypto.randomUUID() };
    const input: ProposalReviewRequest = { ...content, idempotencyKey: submission.current.key };
    inFlight.current = true;
    setPending(true);
    try {
      await onReview(input);
      setRecorded(true);
    } catch (failure) {
      if (failure instanceof SessionExpiredError) return;
      const stale = failure instanceof Error && 'status' in failure && failure.status === 409;
      setConflict(stale);
      setError(stale ? 'This proposal changed. Your edits are preserved. Reload and inspect its current revision before submitting again.' : failure instanceof Error ? failure.message : 'Review could not be recorded. Your edits are preserved; retry safely.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const reload = async (): Promise<void> => {
    if (!onReloadProposals || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onReloadProposals();
      setConflict(false);
      setError('');
    } catch (failure) {
      if (!(failure instanceof SessionExpiredError)) setError('Could not reload the proposal. Your edits are still here.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return <Card aria-label={`Proposal: ${proposal.kind}`} className="min-w-0">
    <CardHeader>
      <CardTitle>{proposal.kind.replaceAll('_', ' ')}</CardTitle>
      <CardDescription>{proposal.reason}</CardDescription>
      <p className="text-sm">{proposal.confidence === null ? 'Owner correction — no model score' : `Confidence estimation: ${String(proposal.confidence)}`} · Threshold: {String(proposal.threshold)}</p>
      <p className="text-sm text-muted-foreground">Model confidence is not a calibrated probability or permission to act.</p>
    </CardHeader>
    <CardContent className="grid min-w-0 gap-3">
      <Badge variant={proposal.state === 'blocked' ? 'destructive' : 'secondary'}>{proposal.state} · revision {proposal.revision}</Badge>
      {proposal.action ? <p>Action {proposal.action.id}: {proposal.action.state}{proposal.action.errorCode ? ` · ${proposal.action.errorCode}` : ''}</p> : null}
      {proposal.supersedesProposalId ? <p>Corrects proposal {proposal.supersedesProposalId}</p> : null}
      <Button type="button" variant="outline" aria-expanded={snapshotOpen} aria-controls={`${inputId}-snapshot`} onClick={() => { setSnapshotOpen(!snapshotOpen); }}>Immutable action snapshot</Button>
      {snapshotOpen ? <pre id={`${inputId}-snapshot`} className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(payload, null, 2)}</pre> : null}
      <Button type="button" variant="outline" aria-expanded={evidenceOpen} aria-controls={`${inputId}-evidence`} onClick={() => { setEvidenceOpen(!evidenceOpen); }}>Evidence and consulted precedents</Button>
      {evidenceOpen ? <pre id={`${inputId}-evidence`} className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(proposal.evidenceSnapshot, null, 2)}</pre> : null}
      {proposal.dependencies.length ? <ul className="break-words">{proposal.dependencies.map((dependency) => <li key={dependency.proposalId}>Depends on {dependency.proposalId}: {dependency.state} · action {dependency.actionState ?? 'not authorized'}</li>)}</ul> : null}
      {proposal.state === 'waiting_review' ? <div className="grid gap-3">
        <Field><FieldLabel htmlFor={`${inputId}-reason`}>{correcting ? 'Correction reason (required)' : 'Review comment (optional)'}</FieldLabel><Textarea id={`${inputId}-reason`} value={reason} onChange={(event) => { setReason(event.target.value); }} maxLength={2_000} disabled={pending || recorded} /><FieldDescription>A comment alone does not change the action. Free-form rewriting belongs in contextual chat; explicitly enter the wanted content below.</FieldDescription></Field>
        {correcting ? <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void review('correct'); }}>
          <Field><Select id={`${inputId}-kind`} label="Corrected action" value={kind} disabled={pending || recorded} onValueChange={(value) => { setKind(value as OwnerActionCorrection['kind']); }} options={kinds.map(value => ({ value, label: value.replaceAll('_', ' ') }))} /></Field>
          <p className="break-words text-sm">Mailbox and {messageTarget ? 'message' : 'draft'} stay fixed: {JSON.stringify(payload.target)}{'expectedVersion' in payload ? ` · expected draft version ${String(payload.expectedVersion)}` : ''}</p>
          {kind === 'move' ? <Field><Select id={`${inputId}-folder`} label="Destination folder" placeholder="Choose a folder" value={folderId} disabled={pending || recorded} onValueChange={(value) => { setFolderId(value); }} required options={folders.map(folder => ({ value: folder.id, label: folder.name }))} />{!folders.length ? <FieldDescription>No available folders loaded for this mailbox.</FieldDescription> : null}</Field> : null}
          {kind === 'draft_create' || kind === 'draft_edit' ? <>
            {(['to', 'cc', 'bcc'] as const).map((recipientKind) => <Field key={recipientKind}><FieldLabel htmlFor={`${inputId}-${recipientKind}`}>{recipientKind.toUpperCase()} (comma-separated)</FieldLabel><Input id={`${inputId}-${recipientKind}`} value={addresses[recipientKind]} disabled={pending || recorded} onChange={(event) => { setAddresses((current) => ({ ...current, [recipientKind]: event.target.value })); }} /></Field>)}
            <Field><FieldLabel htmlFor={`${inputId}-subject`}>Subject</FieldLabel><Input id={`${inputId}-subject`} value={subject} maxLength={998} disabled={pending || recorded} onChange={(event) => { setSubject(event.target.value); }} /></Field>
            <Field><Select id={`${inputId}-format`} label="Body format" value={bodyFormat} disabled={pending || recorded} onValueChange={(value) => { setBodyFormat(value as DraftBodyFormat); }} options={[{ value: 'markdown', label: 'Markdown' }, { value: 'html', label: 'HTML' }]} /></Field>
            <Field><FieldLabel htmlFor={`${inputId}-body`}>Body</FieldLabel><Textarea id={`${inputId}-body`} value={body} rows={8} maxLength={2_000_000} disabled={pending || recorded} onChange={(event) => { setBody(event.target.value); }} /></Field>
          </> : null}
          <Button type="submit" disabled={disabled}>{pending ? 'Recording…' : 'Confirm displayed correction'}</Button>
        </form> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={disabled} onClick={() => { void review('approve'); }}>Approve unchanged</Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => { void review('reject'); }}>Reject</Button>
          <Button type="button" variant="outline" disabled={disabled} aria-expanded={correcting} onClick={() => { setCorrecting(!correcting); }}>{correcting ? 'Close correction' : 'Correct'}</Button>
        </div>
        {!onReview ? <p>Review controls are unavailable in this view.</p> : null}
      </div> : null}
      {recorded ? <p role="status">Review recorded. The current proposal state will appear after refresh.</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {conflict ? <Button type="button" variant="outline" disabled={pending || !onReloadProposals} onClick={() => { void reload(); }}>Reload current proposal</Button> : null}
    </CardContent>
  </Card>;
}
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
        {action.recoverable && action.reversalHref ? <Link href={action.reversalHref} className={buttonVariants({ variant: 'link', size: 'sm' })}>Review reversal</Link> : null}
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
  const submit = (event: React.SubmitEvent<HTMLFormElement>): void => { event.preventDefault();
  const answer = new FormData(event.currentTarget).get('answer');
  onAnswer?.({ questionId: question.id, answer: typeof answer === 'string' ? answer : '', expectedVersion: question.version, idempotencyKey }); };
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
export function AgentPanel({ dashboard, idempotencyKey, handlers = {}, error, proposalFolders = [] }: Readonly<{ dashboard: AgentDashboard; idempotencyKey: string; handlers?: AgentUiHandlers; error?: string | undefined; proposalFolders?: readonly ProposalFolder[] }>): React.JSX.Element {
  const openQuestion = dashboard.questions.find((question) => question.state === 'open');
  return <aside aria-label="Agent" className="grid min-w-0 gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <AgentAlerts alerts={dashboard.alerts} />
    <section aria-label="Agent proposals" className="grid gap-3"><h2 className="text-lg font-semibold">Action proposals</h2>{dashboard.proposals.map((proposal) => <AgentProposalCard key={proposal.id} proposal={proposal} proposalFolders={proposalFolders} onReview={handlers.onReview} onReloadProposals={handlers.onReloadProposals} />)}</section>
    <AutonomyControls dashboard={dashboard} handlers={handlers} />
    <section aria-label="Agent actions" className="grid gap-3"><h2 className="text-lg font-semibold">Agent actions</h2>{dashboard.actions.map((action) => <AgentActionCard key={action.id} action={action} {...(handlers.onRetry === undefined ? {} : { onRetry: handlers.onRetry })} />)}</section>
    {openQuestion ? <AgentQuestionSheet question={openQuestion} idempotencyKey={idempotencyKey} {...(handlers.onAnswer === undefined ? {} : { onAnswer: handlers.onAnswer })} /> : null}
    <p aria-live="polite" className="min-h-6 text-sm text-muted-foreground">Agent status updates while polling continues.</p>
  </aside>;
}
