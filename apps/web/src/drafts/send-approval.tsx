import * as React from 'react';
import { z } from 'zod';
import { draftFieldsSchema } from '@hypermail/contracts';
import type { DraftFields } from '@hypermail/contracts';
import type { SubmissionView } from '@hypermail/send';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldLabel } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Textarea } from '@/components/heroui/textarea.js';

export type SendTarget = Readonly<{ kind: 'draft' | 'send_request'; id: string; version: number }>;
export type PreparedSend = Readonly<{ approvalId: string; expiresAt: string; snapshot: DraftFields & { accountId: string } }>;
export class SendUiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export interface SendApprovalApi {
  prepare(target: SendTarget, confirmation: string): Promise<PreparedSend>;
  confirm(target: SendTarget, approvalId: string, confirmation: string): Promise<void>;
  reauthenticate(password: string): Promise<void>;
  reconcile(target: SendTarget, approvalId: string): Promise<void>;
  manualReview(target: SendTarget, approvalId: string, outcome: 'observed_sent' | 'not_observed', note: string): Promise<void>;
}
const root = (target: SendTarget) => `/api/v1/${target.kind === 'draft' ? 'drafts' : 'send-requests'}/${encodeURIComponent(target.id)}`;
const preparedSendSchema = z.object({
  approvalId: z.string().min(1),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  snapshot: z.object({ ...draftFieldsSchema.shape, accountId: z.string().min(1) }),
});
const errorResponseSchema = z.object({ error: z.object({ code: z.string() }) });
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(result);
    throw new SendUiError(error.success ? error.data.error.code : 'REQUEST_FAILED', response.status);
  }
  const object = z.record(z.string(), z.unknown()).safeParse(result);
  if (!object.success) throw new SendUiError('INVALID_RESPONSE', 502);
  return object.data;
}
export const sendApprovalHttpApi: SendApprovalApi = {
  async prepare(target, confirmation) {
    const result = await post(`${root(target)}/approval`, { [target.kind === 'draft' ? 'expectedVersion' : 'expectedDraftVersion']: target.version, confirmation });
    const prepared = preparedSendSchema.safeParse(target.kind === 'draft' ? result['approval'] : result['request']);
    if (!prepared.success) throw new SendUiError('SNAPSHOT_UNAVAILABLE', 502);
    return prepared.data;
  },
  async confirm(target, approvalId, confirmation) {
    await post(target.kind === 'draft' ? `/api/v1/drafts/approvals/${encodeURIComponent(approvalId)}/send` : `${root(target)}/approvals/${encodeURIComponent(approvalId)}/confirm`, { confirmation });
  },
  async reauthenticate(password) { await post('/api/v1/auth/reauthenticate', { password }); },
  async reconcile(target, approvalId) { await post(`${root(target)}/reconcile`, { approvalId, expectedVersion: target.version }); },
  async manualReview(target, approvalId, outcome, note) { await post(`${root(target)}/manual-send-review`, { approvalId, expectedVersion: target.version, outcome, note }); },
};

/** Exact approved content is shown as text, including HTML, never as executable markup. */
export function SendSnapshot({ snapshot }: Readonly<{ snapshot: PreparedSend['snapshot'] }>): React.JSX.Element {
  return <section aria-label="Exact send snapshot" className="grid gap-3">
    <p>Mailbox {snapshot.accountId}</p>
    <dl>{snapshot.recipients.map((recipient, index) => <div key={index} className="flex gap-2"><dt>{recipient.kind.toUpperCase()}</dt><dd className="break-all">{recipient.address}</dd></div>)}</dl>
    <h3 className="font-semibold">{snapshot.subject || '(No subject)'}</h3>
    <p className="text-sm text-muted-foreground">Format: {snapshot.bodyFormat}</p>
    <pre className="whitespace-pre-wrap break-words font-sans">{snapshot.body}</pre>
  </section>;
}

export function SendApprovalFlow({ target, submission, disabled = false, onRefresh, api = sendApprovalHttpApi }: Readonly<{ target: SendTarget; submission?: SubmissionView | null; disabled?: boolean; onRefresh: () => Promise<void>; api?: SendApprovalApi }>): React.JSX.Element {
  const [prepared, setPrepared] = React.useState<PreparedSend | null>(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [reauth, setReauth] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [uncertain, setUncertain] = React.useState(false);
  const identity = `${target.kind}:${target.id}:${String(target.version)}`;
  const identityRef = React.useRef(identity);
  identityRef.current = identity;
  const active = React.useRef(false);
  React.useEffect(() => { setPrepared(null); setConfirmation(''); setReauth(false); setConflict(false); setUncertain(false); setError(''); }, [identity]);
  const handleError = (value: unknown, confirming = false) => {
    if (value instanceof SendUiError && value.code === 'FRESH_AUTH_REQUIRED') { setPrepared(null); setUncertain(false); setReauth(true); setError('Confirm your password to prepare a new snapshot. Nothing will be confirmed automatically.'); }
    else if (value instanceof SendUiError && value.status === 409) { setPrepared(null); setUncertain(false); setConflict(true); setError('This send changed or its approval expired. Reload and review before preparing again.'); }
    else { if (confirming) { setPrepared(null); setUncertain(true); } setError(confirming ? 'The submission outcome could not be read. Do not send again. Reload, then verify the provider outcome.' : 'The operation failed. Your intention and entered content are preserved.'); }
  };
  const run = async (work: () => Promise<void>, confirming = false) => {
    if (active.current) return;
    active.current = true;
    const startedIdentity = identity;
    setBusy(true); setError('');
    try { await work(); } catch (value) { if (identityRef.current === startedIdentity) handleError(value, confirming); } finally { active.current = false; setBusy(false); }
  };
  const prepare = async () => {
    const token = crypto.randomUUID();
    const startedIdentity = identity;
    const result = await api.prepare(target, token);
    if (identityRef.current !== startedIdentity) return;
    setConfirmation(token); setPrepared(result); setReauth(false);
  };
  const outstanding = submission && ['pending', 'dispatching', 'reported', 'unknown'].includes(submission.state);
  return <Card aria-label="Send approval"><CardHeader><CardTitle>Send approval</CardTitle></CardHeader><CardContent className="grid gap-4">
    {error && <p role="alert">{error}</p>}
    {submission && <section aria-label="Submission outcome" className="grid gap-2">
      <p role="status">{submission.state === 'verified' ? 'Provider-verified sent' : submission.state === 'rejected' && !submission.dispatchMayHaveOccurred ? 'Not submitted — approval expired before dispatch' : submission.state === 'reported' ? 'Submission confirmed; Sent filing not yet verified' : submission.state === 'unknown' ? 'Unknown submission outcome — do not resend' : `Submission: ${submission.state}`}</p>
      {submission.reasonCode && <p>{submission.reasonCode}</p>}
      {submission.manualReview && <p>{submission.manualReview.outcome === 'observed_sent' ? 'Verified by you (not provider proof)' : 'Not observed by you (does not prove it was not sent)'} · {submission.manualReview.note}</p>}
      {outstanding && <><p>Verification is read-only and never resends this message.</p><Button variant="outline" disabled={busy} onClick={() => { void run(async () => { await api.reconcile(target, submission.approvalId); await onRefresh(); }); }}>Verify provider outcome</Button>
        <Field><FieldLabel htmlFor={`send-note-${target.id}`}>Manual review note</FieldLabel><Textarea id={`send-note-${target.id}`} value={note} onChange={event => { setNote(event.target.value); }} maxLength={2000} /></Field>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !note.trim()} onClick={() => { void run(async () => { await api.manualReview(target, submission.approvalId, 'observed_sent', note); await onRefresh(); }); }}>I observed it in Sent</Button><Button variant="outline" disabled={busy || !note.trim()} onClick={() => { void run(async () => { await api.manualReview(target, submission.approvalId, 'not_observed', note); await onRefresh(); }); }}>I did not observe it</Button></div></>}
    </section>}
    {(conflict || uncertain) && <Button variant="outline" disabled={busy} onClick={() => { void run(async () => { await onRefresh(); setConflict(false); }); }}>Reload and review</Button>}
    {reauth && <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void run(async () => { const secret = password; setPassword(''); await api.reauthenticate(secret); await prepare(); }); }}><Field><FieldLabel htmlFor={`send-password-${target.id}`}>Confirm your password</FieldLabel><Input id={`send-password-${target.id}`} type="password" autoComplete="current-password" value={password} onChange={event => { setPassword(event.target.value); }} required /></Field><Button type="submit" disabled={busy}>Authenticate and prepare again</Button></form>}
    {prepared && !outstanding && <><SendSnapshot snapshot={prepared.snapshot} /><p>Approval expires {prepared.expiresAt}. This is the exact snapshot to be submitted.</p><Button disabled={busy || disabled || !(Date.parse(prepared.expiresAt) > Date.now())} onClick={() => { void run(async () => { setUncertain(true); await api.confirm(target, prepared.approvalId, confirmation); setPrepared(null); await onRefresh(); }, true); }}>Confirm this exact send</Button><Button variant="outline" disabled={busy} onClick={() => { setPrepared(null); }}>Cancel confirmation</Button></>}
    {!prepared && !reauth && !outstanding && !uncertain && submission?.state !== 'verified' && <Button disabled={busy || disabled || conflict} onClick={() => { void run(prepare); }}>Review and send</Button>}
    {busy && <p role="status">Working…</p>}
  </CardContent></Card>;
}
