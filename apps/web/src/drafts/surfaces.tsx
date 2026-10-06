import * as React from 'react';
import type { DraftRecord, DraftRevision } from './contracts.js';
import type { DraftFields } from '@hypermail/contracts';
import { SendApprovalFlow, SendSnapshot } from './send-approval.js';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldLabel } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Textarea } from '@/components/heroui/textarea.js';

export type DraftComposeProps = Readonly<{
  draft: DraftRecord;
  revisions?: readonly DraftRevision[];
  onAutosave?: (draft: DraftRecord) => Promise<void> | void;
  onRequestSend?: (draft: DraftRecord) => Promise<void> | void;
  onRefresh?: () => Promise<void>;
}>;

const isSendDisabled = (state: DraftRecord['state']): boolean => state !== 'editing' && state !== 'failed';

/** Keep local edits through conflicts; the host must not remount merely because a version changed. */
export function DraftCompose({ draft, revisions, onAutosave, onRequestSend, onRefresh }: DraftComposeProps): React.JSX.Element {
  const [fields, setFields] = React.useState<DraftFields>(() => ({ recipients: draft.recipients, subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat }));
  const [recipientText, setRecipientText] = React.useState(() => Object.fromEntries((['to', 'cc', 'bcc'] as const).map(kind => [kind, draft.recipients.filter(recipient => recipient.kind === kind).map(recipient => recipient.address).join(', ')])));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [conflict, setConflict] = React.useState(false);
  const [comparisonOpen, setComparisonOpen] = React.useState(false);
  const dirty = JSON.stringify(fields) !== JSON.stringify({ recipients: draft.recipients, subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat });
  const sendDisabled = isSendDisabled(draft.state) || dirty || busy || conflict;
  const updateRecipients = (kind: 'to' | 'cc' | 'bcc', text: string) => {
    setRecipientText(current => ({ ...current, [kind]: text }));
    setFields(current => ({ ...current, recipients: [...current.recipients.filter(recipient => recipient.kind !== kind), ...text.split(',').map(address => address.trim()).filter(Boolean).map(address => ({ kind, address }))] }));
  };
  const save = async () => {
    if (!onAutosave || busy) return;
    setBusy(true); setError('');
    try { await onAutosave({ ...draft, ...fields }); setConflict(false); }
    catch { setConflict(true); setError('The draft could not be saved. Your edits are preserved. Reload the saved version, compare, and save explicitly before sending.'); }
    finally { setBusy(false); }
  };
  const versionText = `Version ${String(draft.version)} · ${draft.createdBy === 'agent' ? 'Agent-created draft' : 'User-created draft'}`;

  return <Card aria-label="Draft composer" className="mx-auto min-w-0 max-w-4xl">
    <CardHeader className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Draft</CardTitle>
        <Badge variant={draft.state === 'failed' ? 'destructive' : 'secondary'}>{draft.state}</Badge>
      </div>
      <p role="status" className="text-sm text-muted-foreground">{versionText}</p>
    </CardHeader>
    <CardContent className="grid gap-4">
      {(['to', 'cc', 'bcc'] as const).map(kind => <Field key={kind}>
        <FieldLabel htmlFor={`draft-${kind}-${draft.id}`}>{kind.toUpperCase()}</FieldLabel>
        <Input id={`draft-${kind}-${draft.id}`} value={recipientText[kind] ?? ''} onChange={event => { updateRecipients(kind, event.target.value); }} readOnly={busy || isSendDisabled(draft.state)} />
      </Field>)}
      <Field>
        <FieldLabel htmlFor={`draft-subject-${draft.id}`}>Subject</FieldLabel>
        <Input id={`draft-subject-${draft.id}`} value={fields.subject} onChange={event => { setFields(current => ({ ...current, subject: event.target.value })); }} readOnly={busy || isSendDisabled(draft.state)} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`draft-message-${draft.id}`}>Message ({fields.bodyFormat})</FieldLabel>
        <Textarea id={`draft-message-${draft.id}`} value={fields.body} onChange={event => { setFields(current => ({ ...current, body: event.target.value })); }} rows={12} readOnly={busy || isSendDisabled(draft.state)} />
      </Field>
      {error && <p role="alert">{error}</p>}
      {conflict && onRefresh && <Button variant="outline" disabled={busy} onClick={() => { void onRefresh().then(() => { setConflict(false); }).catch(() => { setError('Could not reload. Your edits are still preserved.'); }); }}>Reload saved version and compare</Button>}
      {dirty && <div className="grid gap-3"><Button type="button" variant="outline" aria-expanded={comparisonOpen} aria-controls={`draft-comparison-${draft.id}`} onClick={() => { setComparisonOpen(!comparisonOpen); }}>Saved version for comparison</Button>{comparisonOpen && <div id={`draft-comparison-${draft.id}`} className="grid gap-3"><SendSnapshot snapshot={draft} /><Button type="button" variant="outline" disabled={busy} onClick={() => {
        setFields({ recipients: draft.recipients, subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat });
        setRecipientText(Object.fromEntries((['to', 'cc', 'bcc'] as const).map(kind => [kind, draft.recipients.filter(recipient => recipient.kind === kind).map(recipient => recipient.address).join(', ')])));
        setConflict(false); setError('');
      }}>Discard local edits and use saved version</Button></div>}</div>}
      {dirty && <p role="status">Unsaved changes — save before preparing a send.</p>}
      {onRefresh && <SendApprovalFlow target={{ kind: 'draft', id: draft.id, version: draft.version }} submission={draft.submission ?? null} disabled={sendDisabled} onRefresh={onRefresh} />}
      <FieldDescription>{revisions ? `${String(revisions.length)} saved version${revisions.length === 1 ? '' : 's'}` : 'Draft history has not been loaded.'}</FieldDescription>
      {!revisions && onRefresh && <Button type="button" variant="outline" disabled={busy} onClick={() => { void onRefresh().catch(() => { setError('Could not load draft history. Your edits are preserved.'); }); }}>Load saved history</Button>}
    </CardContent>
    <CardFooter className="flex-wrap justify-between gap-3">
      <Button type="button" variant="outline" disabled={busy || !onAutosave || isSendDisabled(draft.state)} onClick={() => { void save(); }}>Save draft</Button>
      <div className="grid justify-items-end gap-1">
        {!onRefresh && <Button type="button" disabled={sendDisabled || !onRequestSend} onClick={() => { void onRequestSend?.({ ...draft, ...fields }); }}>Review and send</Button>}
        <FieldDescription>Sending requires your explicit approval.</FieldDescription>
      </div>
    </CardFooter>
  </Card>;
}

