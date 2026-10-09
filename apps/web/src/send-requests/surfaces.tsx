import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';
import * as React from 'react';
import { AppPage, PageContainer, PageHeader } from '@/components/app/patterns.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { SendApprovalFlow, SendSnapshot, type SendApprovalApi } from '../drafts/send-approval.js';
import type { DraftRecord } from '../drafts/contracts.js';
import type { OwnerSendRequest } from './contracts.js';

function SendRequestReview({ request, onRefresh, api }: Readonly<{ request: OwnerSendRequest; onRefresh: () => Promise<void>; api?: SendApprovalApi }>): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const reject = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await authenticatedFetch(`/api/v1/send-requests/${encodeURIComponent(request.id)}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Rejected request');
      await onRefresh();
    } catch (failure) { if (!(failure instanceof SessionExpiredError)) setError('Could not reject this request. Reload to check its current state.'); }
    finally { setBusy(false); }
  };
  return <Card><CardHeader><CardTitle>Draft {request.draftId}</CardTitle><CardDescription>Mailbox {request.accountId} · draft revision {request.draftVersion} · {request.state}</CardDescription></CardHeader><CardContent className="grid gap-4">
    {error && <p role="alert">{error}</p>}
    {request.snapshot && <SendSnapshot snapshot={request.snapshot} />}
    <SendApprovalFlow target={{ kind: 'send_request', id: request.id, version: request.draftVersion }} submission={request.submission ?? null} disabled={busy || request.state !== 'pending_owner_approval'} onRefresh={onRefresh} {...(api ? { api } : {})} />
    {request.state === 'pending_owner_approval' && <Button variant="destructive" disabled={busy} onClick={() => { void reject(); }}>Reject send request</Button>}
  </CardContent></Card>;
}

/** Both agent requests and owner-composed ambiguous submissions remain visible. */
export function PendingSendReview({ requests, drafts = [], onRefresh, api }: Readonly<{ requests: readonly OwnerSendRequest[]; drafts?: readonly DraftRecord[]; onRefresh: () => Promise<void>; api?: SendApprovalApi }>): React.JSX.Element {
  return <AppPage aria-label="Pending send review"><PageContainer measure="reading" className="grid gap-4">
    <PageHeader title="Pending send review" description="Review the exact recipient, subject and body snapshot. Unknown outcomes are never automatically resent; verification is read-only." />
    {requests.map(request => <SendRequestReview key={request.id} request={request} onRefresh={onRefresh} {...(api ? { api } : {})} />)}
    {drafts.filter(draft => !requests.some(request => request.draftId === draft.id)).map(draft => <Card key={draft.id}><CardHeader><CardTitle>{draft.subject || '(No subject)'}</CardTitle><CardDescription>Mailbox {draft.accountId} · draft revision {draft.version}</CardDescription></CardHeader><CardContent><SendApprovalFlow target={{ kind: 'draft', id: draft.id, version: draft.version }} submission={draft.submission ?? null} disabled onRefresh={onRefresh} {...(api ? { api } : {})} /></CardContent></Card>)}
    {!requests.length && !drafts.length && <p>No send requests are waiting.</p>}
  </PageContainer></AppPage>;
}
