import * as React from 'react';
import type { DraftRecord, DraftRevision } from './contracts.js';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldLabel } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { RichTextEditor } from '@/components/app/rich-text-editor.js';

export type DraftComposeProps = Readonly<{
  draft: DraftRecord;
  revisions: readonly DraftRevision[];
  onAutosave?: (draft: DraftRecord) => void;
  onRequestSend?: (draft: DraftRecord) => void;
}>;

const isSendDisabled = (state: DraftRecord['state']): boolean => state === 'sending' || state === 'sent';

/** SSR-safe composition contract; hosts own input state/network calls and must show conflict responses. */
export function DraftCompose({ draft, revisions, onAutosave, onRequestSend }: DraftComposeProps): React.JSX.Element {
  const sendDisabled = isSendDisabled(draft.state);
  const [body, setBody] = React.useState(draft.body);
  React.useEffect(() => { setBody(draft.body); }, [draft.body, draft.id, draft.version]);
  const recipientText = draft.recipients.filter((recipient) => recipient.kind === 'to').map((recipient) => recipient.address).join(', ');
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
      <Field>
        <FieldLabel htmlFor="draft-to">To</FieldLabel>
        <Input id="draft-to" defaultValue={recipientText} required />
      </Field>
      <Field>
        <FieldLabel htmlFor="draft-subject">Subject</FieldLabel>
        <Input id="draft-subject" defaultValue={draft.subject} />
      </Field>
      <Field>
        <FieldLabel htmlFor="draft-message">Message</FieldLabel>
        <RichTextEditor id="draft-message" name="body" defaultValue={draft.body} disabled={sendDisabled} onChange={setBody} />
      </Field>
      <FieldDescription>{String(revisions.length)} saved version{revisions.length === 1 ? '' : 's'}</FieldDescription>
    </CardContent>
    <CardFooter className="flex-wrap justify-between gap-3">
      <Button type="button" variant="outline" onClick={() => onAutosave?.({ ...draft, body })}>Save draft</Button>
      <div className="grid justify-items-end gap-1">
        <Button type="button" disabled={sendDisabled} onClick={() => onRequestSend?.({ ...draft, body })}>Review and send</Button>
        <FieldDescription>Sending requires your explicit approval.</FieldDescription>
      </div>
    </CardFooter>
  </Card>;
}

