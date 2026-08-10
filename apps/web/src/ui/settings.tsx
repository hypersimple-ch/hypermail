import * as React from 'react';
import { ArrowLeft, ExternalLink, Plus } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/heroui/alert.js';
import { Badge } from '@/components/heroui/badge.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { NativeSelect, NativeSelectOption } from '@/components/heroui/native-select.js';
import { Separator } from '@/components/heroui/separator.js';
import { Spinner } from '@/components/heroui/spinner.js';
import { PageHeader, StatePanel } from '@/components/app/patterns.js';

export type MailboxProvider = 'microsoft' | 'gmail' | 'imap';
export type MailboxState = 'pending' | 'ready' | 'degraded' | 'disabled';
export type AddMailboxProvider = 'gmail' | 'outlook' | 'imap';

export interface SettingsMailbox {
  id: string;
  provider: MailboxProvider;
  email: string;
  displayName: string | null;
  state: MailboxState;
}

export interface ImapConnectionInput {
  email: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  username: string;
  password: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpTls?: boolean;
}

export type StartMailboxConnectionInput =
  | { provider: 'gmail' | 'microsoft'; email?: string }
  | { provider: 'imap'; imap: ImapConnectionInput };

export interface PendingMailboxConnection {
  provider: 'gmail' | 'microsoft';
  handle: string;
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  email?: string;
}

export type MailboxConnectionResult =
  | { state: 'pending'; pending: PendingMailboxConnection; message?: string }
  | { state: 'ready'; message?: string }
  | { state: 'expired'; message?: string }
  | { state: 'error'; message?: string };

export interface CompleteMailboxConnectionInput {
  provider: 'gmail' | 'microsoft';
  handle: string;
  authorizationResponse?: string;
  code?: string;
  state?: string;
}

export interface SettingsProps {
  mailboxes: readonly SettingsMailbox[];
  onBack?: () => void;
  onStartConnection?: (input: StartMailboxConnectionInput) => Promise<MailboxConnectionResult>;
  onCompleteConnection?: (input: CompleteMailboxConnectionInput) => Promise<MailboxConnectionResult>;
  pendingConnection?: PendingMailboxConnection;
  statusNotice?: string;
}

const providerLabel: Record<MailboxProvider, string> = { microsoft: 'Outlook', gmail: 'Gmail', imap: 'IMAP' };
const stateLabel: Record<MailboxState, string> = { pending: 'Pending connection', ready: 'Connected', degraded: 'Needs attention', disabled: 'Disabled' };
const stateVariant: Record<MailboxState, 'secondary' | 'outline' | 'destructive'> = { pending: 'outline', ready: 'secondary', degraded: 'outline', disabled: 'destructive' };
const pageClass = 'mx-auto w-full max-w-5xl min-w-0 bg-background p-4 pb-24 sm:p-6';
const formText = (form: FormData, name: string): string => { const value = form.get(name); return typeof value === 'string' ? value : ''; };

function resultText(result: MailboxConnectionResult): string {
  if (result.message) return result.message;
  if (result.state === 'ready') return 'Mailbox connected.';
  if (result.state === 'expired') return 'This connection request expired. Start again.';
  if (result.state === 'error') return 'Could not connect the mailbox. Try again.';
  return 'Connection is waiting for verification.';
}

function PendingConnection({ pending, disabled, onComplete }: { pending: PendingMailboxConnection; disabled: boolean; onComplete: (input: CompleteMailboxConnectionInput) => void }) {
  const isOutlook = pending.provider === 'microsoft';
  return <Card className="gap-0 py-0" aria-label={`${isOutlook ? 'Outlook' : 'Gmail'} connection`}> 
    <CardHeader className="px-4 pt-4 pb-3"><CardTitle>{isOutlook ? 'Connect Outlook' : 'Connect Gmail'}</CardTitle><CardDescription>{isOutlook ? 'Use the device code below, then check the connection here.' : 'Continue to Google sign-in. Google will return you to Hypermail after approval.'}</CardDescription></CardHeader>
    <CardContent className="space-y-4 px-4 pb-4">
      {pending.authorizationUrl ? <a href={pending.authorizationUrl} {...(isOutlook ? { target: '_blank', rel: 'noreferrer' } : {})} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline underline-offset-4">Open {isOutlook ? 'Microsoft verification' : 'Google sign-in'} <ExternalLink aria-hidden="true" className="size-4" /></a> : null}
      {isOutlook ? <div className="space-y-2 text-sm"><p>Enter this code at the Microsoft verification page:</p>{pending.userCode ? <p className="rounded-md border border-border bg-muted px-3 py-2 font-mono font-semibold tracking-wide">{pending.userCode}</p> : <p>Waiting for a device code.</p>}{pending.expiresAt ? <p className="text-muted-foreground">Code expires {pending.expiresAt}.</p> : null}</div> : <p className="text-sm text-muted-foreground">You should be redirected automatically. If the redirect was blocked, use the Google sign-in link above. Hypermail will finish connecting when Google returns.</p>}
      {isOutlook ? <Button type="button" onClick={() => { onComplete({ provider: pending.provider, handle: pending.handle }); }} disabled={disabled}>{disabled ? <><Spinner />Checking connection…</> : 'Check connection'}</Button> : null}
    </CardContent>
  </Card>;
}

function AddMailboxForm({ disabled, onStart }: { disabled: boolean; onStart: (input: StartMailboxConnectionInput) => Promise<void> }) {
  const [provider, setProvider] = React.useState<AddMailboxProvider>('gmail');
  const [validationError, setValidationError] = React.useState('');
  const formRef = React.useRef<HTMLFormElement>(null);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setValidationError('');
    if (provider !== 'imap') {
      const email = formText(form, 'email').trim();
      void onStart({ provider: provider === 'outlook' ? 'microsoft' : 'gmail', ...(email ? { email } : {}) }).finally(() => { formRef.current?.reset(); });
      return;
    }
    const email = formText(form, 'imap-email').trim();
    const imapHost = formText(form, 'imap-host').trim();
    const imapPort = Number(formText(form, 'imap-port'));
    const username = formText(form, 'imap-username').trim();
    const password = formText(form, 'imap-password');
    const smtpHost = formText(form, 'smtp-host').trim();
    const smtpPortText = formText(form, 'smtp-port').trim();
    if (!email || !imapHost || !Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535 || !username || !password || (smtpHost && (!smtpPortText || !Number.isInteger(Number(smtpPortText)) || Number(smtpPortText) < 1 || Number(smtpPortText) > 65535))) {
      setValidationError('Enter the required IMAP details and a valid port.');
      return;
    }
    void onStart({ provider: 'imap', imap: { email, imapHost, imapPort, imapTls: form.get('imap-tls') === 'on', username, password, ...(smtpHost ? { smtpHost, smtpPort: Number(smtpPortText), smtpTls: form.get('smtp-tls') === 'on' } : {}) } }).finally(() => { formRef.current?.reset(); });
  };
  return <Card className="gap-0 py-0"><CardHeader className="px-4 pt-4 pb-3"><CardTitle>Add mailbox</CardTitle><CardDescription>Choose a provider and follow its connection steps.</CardDescription></CardHeader><CardContent className="px-4 pb-4"><form ref={formRef} noValidate onSubmit={submit} className="space-y-4">
    <Field><FieldLabel htmlFor="mailbox-provider">Provider</FieldLabel><NativeSelect id="mailbox-provider" value={provider} onChange={(event) => { setProvider(event.target.value as AddMailboxProvider); setValidationError(''); }} disabled={disabled}><NativeSelectOption value="gmail">Gmail</NativeSelectOption><NativeSelectOption value="outlook">Outlook</NativeSelectOption><NativeSelectOption value="imap">IMAP</NativeSelectOption></NativeSelect></Field>
    {provider !== 'imap' ? <Field><FieldLabel htmlFor="provider-email">Email address (optional)</FieldLabel><Input id="provider-email" name="email" type="email" autoComplete="email" placeholder="name@example.com" disabled={disabled} /><FieldDescription>Used to identify the mailbox while you connect it.</FieldDescription></Field> : <FieldSet disabled={disabled}><Field><FieldLabel htmlFor="imap-email">Mailbox email</FieldLabel><Input id="imap-email" name="imap-email" type="email" autoComplete="email" required disabled={disabled} /></Field><div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]"><Field><FieldLabel htmlFor="imap-host">IMAP host</FieldLabel><Input id="imap-host" name="imap-host" autoComplete="off" required disabled={disabled} /></Field><Field><FieldLabel htmlFor="imap-port">IMAP port</FieldLabel><Input id="imap-port" name="imap-port" type="number" min="1" max="65535" defaultValue="993" required disabled={disabled} /></Field></div><Field><label className="flex min-h-11 items-center gap-2 text-sm font-medium"><Input name="imap-tls" type="checkbox" defaultChecked disabled={disabled} className="size-4" />Use TLS for IMAP</label></Field><Field><FieldLabel htmlFor="imap-username">Username</FieldLabel><Input id="imap-username" name="imap-username" autoComplete="username" required disabled={disabled} /></Field><Field><FieldLabel htmlFor="imap-password">Password</FieldLabel><Input id="imap-password" name="imap-password" type="password" autoComplete="current-password" required disabled={disabled} /><FieldDescription>Your password is used only to connect this mailbox.</FieldDescription></Field><Separator /><p className="text-sm font-medium">SMTP (optional)</p><div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]"><Field><FieldLabel htmlFor="smtp-host">SMTP host</FieldLabel><Input id="smtp-host" name="smtp-host" autoComplete="off" disabled={disabled} /></Field><Field><FieldLabel htmlFor="smtp-port">SMTP port</FieldLabel><Input id="smtp-port" name="smtp-port" type="number" min="1" max="65535" defaultValue="587" disabled={disabled} /></Field></div><Field><label className="flex min-h-11 items-center gap-2 text-sm font-medium"><Input name="smtp-tls" type="checkbox" defaultChecked disabled={disabled} className="size-4" />Use TLS for SMTP</label></Field></FieldSet>}
    {validationError ? <FieldError>{validationError}</FieldError> : null}<Button type="submit" disabled={disabled}>{disabled ? <><Spinner />Connecting…</> : provider === 'imap' ? 'Connect IMAP' : `Continue with ${provider === 'outlook' ? 'Outlook' : 'Gmail'}`}</Button>
  </form></CardContent></Card>;
}

export function Settings({ mailboxes, onBack, onStartConnection, onCompleteConnection, pendingConnection, statusNotice }: SettingsProps): React.JSX.Element {
  const [adding, setAdding] = React.useState(false);
  const [pending, setPending] = React.useState<PendingMailboxConnection | undefined>(pendingConnection);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const [error, setError] = React.useState('');
  React.useEffect(() => { setPending(pendingConnection); }, [pendingConnection]);
  const applyResult = (result: MailboxConnectionResult) => { setFeedback(resultText(result)); setError(result.state === 'error' ? resultText(result) : ''); if (result.state === 'pending') setPending(result.pending); else if (result.state === 'ready' || result.state === 'expired') setPending(undefined); };
  const start = async (input: StartMailboxConnectionInput) => { if (!onStartConnection) return; setBusy(true); setFeedback(''); setError(''); try { applyResult(await onStartConnection(input)); } catch { setError('Could not connect the mailbox. Try again.'); } finally { setBusy(false); } };
  const complete = (input: CompleteMailboxConnectionInput) => { if (!onCompleteConnection) return; setBusy(true); setFeedback(''); setError(''); void onCompleteConnection(input).then(applyResult).catch(() => { setError('Could not check the connection. Try again.'); }).finally(() => { setBusy(false); }); };
  return <section className={pageClass} aria-label="Settings"><PageHeader title="Settings" description="Connected mailboxes" actions={<>{onBack ? <Button type="button" variant="ghost" onClick={onBack}><ArrowLeft aria-hidden="true" />More</Button> : null}<Button type="button" onClick={() => { setAdding((value) => !value); }} disabled={busy}><Plus aria-hidden="true" />Add mailbox</Button></>} /><div className="mt-6 space-y-4">
    {statusNotice ? <Alert aria-live="polite"><AlertDescription>{statusNotice}</AlertDescription></Alert> : null}{feedback && !error ? <div role="status" aria-live="polite" className="text-sm">{feedback}</div> : null}{error ? <Alert variant="destructive" aria-live="assertive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <section aria-labelledby="connected-mailboxes"><h2 id="connected-mailboxes" className="text-lg font-semibold">Current mailboxes</h2>{mailboxes.length ? <div className="mt-3 space-y-3">{mailboxes.map((mailbox) => <Card key={mailbox.id} className="gap-0 py-0"><CardContent className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4"><div className="min-w-0"><strong className="block truncate">{mailbox.displayName || mailbox.email}</strong><p className="mt-1 truncate text-sm text-muted-foreground">{providerLabel[mailbox.provider]} · {mailbox.email}</p></div><Badge variant={stateVariant[mailbox.state]}>{stateLabel[mailbox.state]}</Badge></CardContent></Card>)}</div> : <StatePanel className="mt-3" title="No mailboxes connected." description="Add Gmail, Outlook, or an IMAP mailbox to get started." />}</section>
    {pending ? <PendingConnection pending={pending} disabled={busy || !onCompleteConnection} onComplete={complete} /> : null}{adding ? <AddMailboxForm disabled={busy || !onStartConnection} onStart={start} /> : null}
  </div></section>;
}
