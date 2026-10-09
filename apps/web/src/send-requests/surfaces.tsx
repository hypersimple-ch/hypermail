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
      const response = await fetch(`/api/v1/send-requests/${encodeURIComponent(request.id)}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Rejected request');
      await onRefresh();
    } catch { setError('Could not reject this request. Reload to check its current state.'); }
    finally { setBusy(false); }
  };
  return <Card><CardHeader><CardTitle>{request.snapshot ? request.snapshot.subject || '(No subject)' : `Draft ${request.draftId}`}</CardTitle><CardDescription>Mailbox {request.accountId} · draft revision {request.draftVersion} · {request.state}</CardDescription></CardHeader><CardContent className="grid gap-4">
    {error && <p role="alert">{error}</p>}
    {request.snapshot && <SendSnapshot snapshot={request.snapshot} />}
    <SendApprovalFlow target={{ kind: 'send_request', id: request.id, version: request.draftVersion }} submission={request.submission ?? null} disabled={busy || request.state !== 'pending_owner_approval'} onRefresh={onRefresh} {...(api ? { api } : {})} />
    {request.state === 'pending_owner_approval' && <Button variant="destructive" disabled={busy} onClick={() => { void reject(); }}>Reject send request</Button>}
  </CardContent></Card>;
}

/** Both agent requests and owner-composed ambiguous submissions remain visible. */
export function PendingSendReview({ requests, drafts = [], onRefresh, api }: Readonly<{ requests: readonly OwnerSendRequest[]; drafts?: readonly DraftRecord[]; onRefresh: () => Promise<void>; api?: SendApprovalApi }>): React.JSX.Element {
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState('');
  const refreshPending = React.useRef(false);
  const approvalHeadingId = React.useId();
  const outcomesHeadingId = React.useId();
  const awaitingApproval = requests.filter(request => request.state === 'pending_owner_approval');
  const sendingOutcomes = requests.filter(request => request.state !== 'pending_owner_approval');
  const outstandingDrafts = drafts.filter(draft => !requests.some(request => request.draftId === draft.id));
  const refresh = async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    setRefreshError('');
    try { await onRefresh(); }
    catch { setRefreshError('Could not refresh approvals. Try again.'); }
    finally { refreshPending.current = false; setRefreshing(false); }
  };
  return <AppPage aria-label="Approvals"><PageContainer measure="reading" className="grid gap-4">
    <PageHeader title="Approvals" description="Review agent-requested sends and verify uncertain sending outcomes." actions={<Button variant="outline" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>} />
    {refreshError && <p role="alert">{refreshError}</p>}
    <section aria-labelledby={approvalHeadingId} className="grid gap-4">
      <h2 id={approvalHeadingId} className="text-lg font-semibold">Awaiting approval</h2>
      {awaitingApproval.map(request => <SendRequestReview key={request.id} request={request} onRefresh={onRefresh} {...(api ? { api } : {})} />)}
      {!awaitingApproval.length && <p>No requests need your approval.</p>}
    </section>
    <section aria-labelledby={outcomesHeadingId} className="grid gap-4">
      <h2 id={outcomesHeadingId} className="text-lg font-semibold">Sending outcomes</h2>
      {sendingOutcomes.map(request => <SendRequestReview key={request.id} request={request} onRefresh={onRefresh} {...(api ? { api } : {})} />)}
      {outstandingDrafts.map(draft => <Card key={draft.id}><CardHeader><CardTitle>{draft.subject || '(No subject)'}</CardTitle><CardDescription>Mailbox {draft.accountId} · draft revision {draft.version}</CardDescription></CardHeader><CardContent><SendApprovalFlow target={{ kind: 'draft', id: draft.id, version: draft.version }} submission={draft.submission ?? null} disabled onRefresh={onRefresh} {...(api ? { api } : {})} /></CardContent></Card>)}
    </section>
  </PageContainer></AppPage>;
}
