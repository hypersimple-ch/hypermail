import * as React from 'react';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent } from '@/components/heroui/card.js';
import { Select } from '@/components/heroui/select.js';
import { AppPage, PageHeader, StatePanel } from '@/components/app/patterns.js';
import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';

type Consent = Readonly<{
  clientName: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  request_token: string;
  mailboxes: readonly Readonly<{ id: string; email: string }>[];
}>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function isConsent(value: unknown): value is Consent {
  return record(value) && nonempty(value['clientName']) && nonempty(value['clientId']) && nonempty(value['redirectUri']) && nonempty(value['scope']) && nonempty(value['request_token'])
    && Array.isArray(value['mailboxes']) && value['mailboxes'].every((mailbox: unknown) => record(mailbox) && nonempty(mailbox['id']) && nonempty(mailbox['email']));
}
function redirectResult(value: unknown): string | null {
  if (!record(value) || !nonempty(value['redirectUrl'])) return null;
  try {
    const url = new URL(value['redirectUrl']);
    if (['javascript:', 'data:', 'vbscript:'].includes(url.protocol)) return null;
    return value['redirectUrl'];
  } catch { return null; }
}

export function OAuthConsent(): React.JSX.Element {
  const [consent, setConsent] = React.useState<Consent>();
  const [mailboxId, setMailboxId] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [decisionError, setDecisionError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [expired, setExpired] = React.useState(false);
  const epoch = React.useRef(0);
  const pendingRef = React.useRef(false);
  const blockedRef = React.useRef(false);
  const expiredRef = React.useRef(false);
  const loadConsent = React.useCallback(async (): Promise<void> => {
    if (expiredRef.current || pendingRef.current) return;
    const generation = ++epoch.current;
    setLoading(true); setLoadError(false);
    try {
      const response = await authenticatedFetch(window.location.pathname + window.location.search, { headers: { Accept: 'application/json' }, redirect: 'manual', credentials: 'same-origin' });
      if (!response.ok || response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('Invalid consent response');
      const body: unknown = await response.json();
      if (!isConsent(body)) throw new Error('Invalid consent response');
      if (generation !== epoch.current) return;
      setConsent(body); setMailboxId(''); setDecisionError(''); blockedRef.current = false;
    } catch (error) {
      if (generation !== epoch.current) return;
      if (!(error instanceof SessionExpiredError)) setLoadError(true);
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    const sessionExpired = (): void => { expiredRef.current = true; blockedRef.current = true; epoch.current += 1; setExpired(true); setLoading(false); setPending(false); };
    window.addEventListener('hypermail:session-expired', sessionExpired);
    void loadConsent();
    return () => { epoch.current += 1; window.removeEventListener('hypermail:session-expired', sessionExpired); };
  }, [loadConsent]);
  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (!consent || loading || pendingRef.current || blockedRef.current || expiredRef.current || decision === 'allow' && !consent.mailboxes.some(mailbox => mailbox.id === mailboxId)) return;
    pendingRef.current = true; blockedRef.current = true; setPending(true); setDecisionError('');
    const generation = epoch.current;
    let completed = false;
    try {
      const response = await authenticatedFetch('/oauth/authorize', {
        method: 'POST', redirect: 'manual', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_token: consent.request_token, decision, ...(decision === 'allow' ? { mailbox_id: mailboxId } : {}) }),
      });
      if (generation !== epoch.current) return;
      if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('Decision failed');
      const redirectUrl = redirectResult(await response.json());
      if (generation !== epoch.current) return;
      if (!redirectUrl) throw new Error('Invalid decision response');
      window.location.assign(redirectUrl);
      completed = true;
    } catch (error) {
      if (generation !== epoch.current) return;
      if (!(error instanceof SessionExpiredError)) setDecisionError('Your decision could not be confirmed. This consent may have expired or already been used. Reload consent before making another decision.');
    } finally {
      pendingRef.current = false;
      if (generation === epoch.current && !completed) setPending(false);
    }
  };
  return <AppPage aria-label="OAuth consent" className="max-w-2xl space-y-6">
    <PageHeader title="Authorize access" />
    {loading ? <StatePanel title="Loading consent…" loading /> : loadError || !consent && !expired ? <StatePanel title="Could not load consent." description="The authorization request could not be loaded. Check the request and try again." action={<Button type="button" onClick={() => { void loadConsent(); }}>Try again</Button>} /> : null}
    {consent ? <Card><CardContent className="space-y-5">
      <dl className="space-y-3"><div><dt className="font-semibold">Client</dt><dd>{consent.clientName}</dd></div><div><dt className="font-semibold">Redirect destination</dt><dd className="break-all">{consent.redirectUri}</dd></div><div><dt className="font-semibold">Scope</dt><dd>{consent.scope}</dd></div></dl>
      <Select id="oauth-mailbox" label="Mailbox" required placeholder="Choose a mailbox" value={mailboxId} disabled={loading || pending || expired} options={consent.mailboxes.map(mailbox => ({ value: mailbox.id, label: mailbox.email }))} onValueChange={setMailboxId} />
      {consent.mailboxes.length === 0 ? <p>No mailboxes are available. Connect a mailbox before allowing access.</p> : null}
      {decisionError ? <div role="alert" className="space-y-3"><p>{decisionError}</p><Button type="button" disabled={loading || pending || expired} onClick={() => { void loadConsent(); }}>Reload consent</Button></div> : null}
      <div className="flex gap-3"><Button type="button" disabled={!mailboxId || loading || pending || expired || !!decisionError} onClick={() => { void decide('allow'); }}>Allow</Button><Button type="button" variant="outline" disabled={loading || pending || expired || !!decisionError} onClick={() => { void decide('deny'); }}>Deny</Button></div>
      {pending ? <p role="status">Recording decision…</p> : null}
    </CardContent></Card> : null}
  </AppPage>;
}
