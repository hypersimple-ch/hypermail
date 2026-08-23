/// <reference lib="dom" />

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentDashboard, AgentUiHandlers, AutonomyScope, AutonomyState } from './agent/index.js';
import { ToastProvider, toast } from '@/components/heroui/toast.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Spinner } from '@/components/heroui/spinner.js';
import { activateWaitingUpdate, registerPwaWorker, type ServiceWorkerRegistrationLike } from './pwa/registration.js';
import { initialPwaState } from './pwa/state.js';
import { HypermailShell, type Draft, type Screen, type ShellData } from './ui/index.js';
import type { ActivityPage } from './activity/contracts.js';
import type { ManagerChoice, ManagerSettingsView, MailboxManagerView } from './agent-connections/contracts.js';
import type { ManagerMutations } from './mailbox-managers/index.js';
import type { ChangePasswordInput, ChangePasswordResult } from './ui/account.js';
import type { CompleteMailboxConnectionInput, MailboxConnectionResult, PendingMailboxConnection, SettingsMailbox, StartMailboxConnectionInput } from './ui/settings.js';

const emptyActivity: ActivityPage = { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } };
const empty: ShellData = { accounts: [], messages: [], activity: emptyActivity };
type BrowserDraft = Draft;
type AppState = 'loading' | 'ready' | 'empty' | 'error' | 'unauthenticated' | 'bootstrap';
type SessionResponse = { user: { id: string; email: string }; accounts: SettingsMailbox[] };
type MailboxApiResult =
  | { status: 'pending'; handle?: string; verification?: { verificationUri?: string; userCode?: string; expiresAt?: string; message?: string } }
  | { status: 'ready' | 'expired' }
  | { status: 'error'; reason?: 'authorization_expired' | 'authorization_rejected' | 'provider_configuration' | 'token_exchange_failed' | 'gmail_profile_failed' | 'provider_unavailable' };
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; }

const pendingMailboxStorageKey = 'hypermail.pending-mailbox.v1';
const readPendingMailbox = (): PendingMailboxConnection | undefined => {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingMailboxStorageKey) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const pending = value as Record<string, unknown>;
    const expiry = typeof pending['expiresAt'] === 'string' ? Date.parse(pending['expiresAt']) : Number.NaN;
    if ((pending['provider'] !== 'gmail' && pending['provider'] !== 'microsoft') || typeof pending['handle'] !== 'string' || !Number.isFinite(expiry) || expiry <= Date.now()) {
      sessionStorage.removeItem(pendingMailboxStorageKey);
      return undefined;
    }
    return { provider: pending['provider'], handle: pending['handle'], expiresAt: pending['expiresAt'] as string };
  } catch { return undefined; }
};
const persistPendingMailbox = (pending: PendingMailboxConnection): void => {
  try { sessionStorage.setItem(pendingMailboxStorageKey, JSON.stringify({ provider: pending.provider, handle: pending.handle, expiresAt: pending.expiresAt ?? '' })); } catch { /* A blocked storage API must not retain provider callback data elsewhere. */ }
};
const clearPendingMailbox = (): void => { try { sessionStorage.removeItem(pendingMailboxStorageKey); } catch { /* Nothing else retains the pending handle. */ } };
const mailboxProvider = (provider: 'gmail' | 'microsoft'): 'gmail' | 'outlook' => provider === 'microsoft' ? 'outlook' : 'gmail';
const gmailAuthorizationUrl = (value: string): string => {
  const url = new URL(value);
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Invalid Gmail authorization URL.');
  return url.toString();
};


function AuthCard({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <main className="grid min-h-dvh place-items-center bg-background p-4" aria-labelledby="auth-title"><Card className="w-full max-w-md"><CardHeader><h1 id="auth-title" className="text-2xl font-semibold tracking-tight">{title}</h1>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent>{children}</CardContent></Card></main>;
}

function Login({ onComplete, notice }: { onComplete: () => void; notice?: string }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => { if (notice) toast(notice); }, [notice]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = new FormData(event.currentTarget); setPending(true); void fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }).then((response) => { if (response.ok) onComplete(); else toast.danger('Sign-in failed. Check your email and password.'); }).catch(() => { toast.danger('Sign-in is unavailable. Reconnect and try again.'); }).finally(() => { setPending(false); }); };
  return <AuthCard title="Hypermail"><form onSubmit={submit}><FieldSet disabled={pending}><Field><FieldLabel htmlFor="login-email">Email</FieldLabel><Input id="login-email" name="email" type="email" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="login-password">Password</FieldLabel><Input id="login-password" name="password" type="password" autoComplete="current-password" required /></Field><Button type="submit">{pending ? <><Spinner />Signing in…</> : 'Sign in'}</Button></FieldSet></form></AuthCard>;
}

function Bootstrap({ onComplete, onSetupCompleted }: { onComplete: () => void; onSetupCompleted: () => void }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = event.currentTarget; const password = form.elements.namedItem('password') as HTMLInputElement; const confirmation = form.elements.namedItem('confirmPassword') as HTMLInputElement; confirmation.setCustomValidity(password.value === confirmation.value ? '' : 'Passwords do not match.'); if (!form.reportValidity()) return; setPending(true); void fetch('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: new FormData(form).get('email'), password: password.value }) }).then((response) => { if (response.status === 201) onComplete(); else if (response.status === 409) onSetupCompleted(); else toast.danger('Setup is unavailable. Try again.'); }).catch(() => { toast.danger('Setup is unavailable. Try again.'); }).finally(() => { setPending(false); }); };
  const confirmPassword = (event: React.FormEvent<HTMLInputElement>) => { const input = event.currentTarget; const password = input.form?.elements.namedItem('password') as HTMLInputElement | null; input.setCustomValidity(password?.value === input.value ? '' : 'Passwords do not match.'); };
  return <AuthCard title="Set up Hypermail" description="Create the private owner account for this Hypermail installation."><form onSubmit={submit}><FieldSet disabled={pending}><Field><FieldLabel htmlFor="setup-email">Email</FieldLabel><Input id="setup-email" name="email" type="email" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="setup-password">Password</FieldLabel><Input id="setup-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required aria-describedby="setup-password-help" /><FieldDescription id="setup-password-help">Use at least 12 characters.</FieldDescription></Field><Field><FieldLabel htmlFor="setup-confirm-password">Confirm password</FieldLabel><Input id="setup-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required onInput={confirmPassword} aria-describedby="setup-password-help" /></Field><Button type="submit">{pending ? <><Spinner />Setting up…</> : 'Set up private owner'}</Button></FieldSet></form></AuthCard>;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = React.useState(() => navigator.onLine);
  React.useEffect(() => { const updateConnection = () => { setOnline(navigator.onLine); }; addEventListener('online', updateConnection); addEventListener('offline', updateConnection); return () => { removeEventListener('online', updateConnection); removeEventListener('offline', updateConnection); }; }, []);
  return online;
}

function PwaPresentation(): React.JSX.Element {
  const online = useOnlineStatus(); const [installAvailable, setInstallAvailable] = React.useState(false); const [updateAvailable, setUpdateAvailable] = React.useState(false);
  const deferredInstall = React.useRef<BeforeInstallPromptEvent | undefined>(undefined); const registration = React.useRef<ServiceWorkerRegistrationLike | undefined>(undefined);
  React.useEffect(() => { const available = (event: Event) => { event.preventDefault(); deferredInstall.current = event as BeforeInstallPromptEvent; setInstallAvailable(true); }; addEventListener('beforeinstallprompt', available); return () => { removeEventListener('beforeinstallprompt', available); }; }, []);
  React.useEffect(() => { if (!('serviceWorker' in navigator)) return; let reloading = false; const reload = () => { if (!reloading) { reloading = true; location.reload(); } }; navigator.serviceWorker.addEventListener('controllerchange', reload); void registerPwaWorker(navigator.serviceWorker, (pwaState) => { setUpdateAvailable(pwaState.update === 'available'); }, initialPwaState).then((value) => { registration.current = value; }).catch(() => {}); return () => { navigator.serviceWorker.removeEventListener('controllerchange', reload); }; }, []);
  const install = () => { void deferredInstall.current?.prompt(); };
  const update = () => { if (registration.current) activateWaitingUpdate(registration.current); };
  return <><p role="status" aria-live="polite" className="sr-only">{online ? 'Online' : 'Offline — reconnect to use Hypermail.'}</p>{installAvailable || updateAvailable ? <aside aria-label="Application utilities" className="fixed inset-x-0 bottom-20 z-10 flex flex-wrap justify-center gap-2 px-4 [@media(min-width:700px)]:bottom-3"><Card className="flex-row items-center gap-2 p-2">{installAvailable ? <Button type="button" variant="outline" onClick={install}>Install Hypermail</Button> : null}{updateAvailable ? <Button type="button" variant="outline" onClick={update}>Reload to update</Button> : null}</Card></aside> : null}</>;
}

function App(): React.JSX.Element {
  const online = useOnlineStatus();
  const [data, setData] = React.useState<ShellData>(empty); const [drafts, setDrafts] = React.useState<readonly BrowserDraft[]>([]);
  const [dashboard, setDashboard] = React.useState<AgentDashboard | undefined>(); const [agentError, setAgentError] = React.useState('');
  const [state, setState] = React.useState<AppState>('loading'); const [loginNotice, setLoginNotice] = React.useState('');
  const [managerSettings, setManagerSettings] = React.useState<ManagerSettingsView>();
  const [ownerEmail, setOwnerEmail] = React.useState(''); const [settingsMailboxes, setSettingsMailboxes] = React.useState<readonly SettingsMailbox[]>([]);
  const [pendingMailbox, setPendingMailbox] = React.useState<PendingMailboxConnection | undefined>(readPendingMailbox);
  const [initialScreen] = React.useState<Screen>(() => location.pathname === '/oauth/gmail/callback' ? 'settings' : 'inbox'); const callbackHandled = React.useRef(false);
  const load = React.useCallback(async (activityFilter: 'new' | 'questions' | 'failed' | 'history' = 'new') => {
    const session = await fetch('/api/v1/session');
    if (session.status === 401) { let bootstrapAvailable = false; try { bootstrapAvailable = (await session.json() as { bootstrapAvailable?: unknown }).bootstrapAvailable === true; } catch { /* Invalid bodies are not bootstrap capabilities. */ } setState(bootstrapAvailable ? 'bootstrap' : 'unauthenticated'); return; }
    if (!session.ok) throw new Error('load failed');
    const sessionBody = await session.json() as SessionResponse;
    const [inbox, activity, draftResponse] = await Promise.all([fetch('/api/v1/inbox'), fetch(`/api/v1/activities?filter=${encodeURIComponent(activityFilter)}`), fetch('/api/v1/drafts')]);
    if (!inbox.ok || !activity.ok || !draftResponse.ok) throw new Error('load failed');
    const accounts = sessionBody.accounts.map((account) => ({ id: account.id, label: account.displayName ?? account.email, address: account.email, unread: 0 }));
    const messages = (await inbox.json() as { messages: Array<{ id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string }> }).messages.map((message) => ({ id: message.id, accountId: message.account_id, sender: message.sender || 'Unknown sender', initials: (message.sender || '?').slice(0, 1).toUpperCase(), subject: message.subject || '(no subject)', preview: message.preview, received: new Date(message.received_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), body: message.preview }));
    const activityPage = await activity.json() as ActivityPage;
    setOwnerEmail(sessionBody.user.email); setSettingsMailboxes(sessionBody.accounts);
    setDrafts((await draftResponse.json() as { drafts: BrowserDraft[] }).drafts); setData({ accounts, messages, activity: activityPage }); setState(messages.length || activityPage.items.length ? 'ready' : 'empty');
    void Promise.resolve().then(() => fetch('/api/v1/agent-connections')).then(async response => { if (!response.ok) throw new Error('manager settings unavailable'); const result = await response.json() as { settings: ManagerSettingsView }; setManagerSettings(result.settings); }).catch(() => { setManagerSettings(undefined); });
    void fetch('/api/v1/agent', { headers: { 'x-api-version': 'v1' } }).then(async (response) => response.ok ? response.json() as Promise<{ dashboard: AgentDashboard }> : Promise.reject(new Error('agent unavailable'))).then((result) => { setAgentError(''); setDashboard(result.dashboard); }).catch(() => { setDashboard(undefined); setAgentError('Could not load agent status. Try again later.'); });
  }, []);
  const startMailboxConnection = React.useCallback(async (input: StartMailboxConnectionInput): Promise<MailboxConnectionResult> => {
    const body = input.provider === 'imap'
      ? { provider: 'imap', email: input.imap.email, config: { host: input.imap.imapHost, port: input.imap.imapPort, secure: input.imap.imapTls, user: input.imap.username, password: input.imap.password, ...(input.imap.smtpHost ? { smtpHost: input.imap.smtpHost, smtpPort: input.imap.smtpPort, smtpSecure: input.imap.smtpTls } : {}) } }
      : { provider: mailboxProvider(input.provider), ...(input.email ? { email: input.email } : {}) };
    const response = await fetch('/api/v1/mailboxes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null) as MailboxApiResult | null;
    if (response.ok && payload?.status === 'pending' && input.provider !== 'imap' && payload.handle && payload.verification?.verificationUri && payload.verification.expiresAt) {
      const authorizationUrl = input.provider === 'gmail' ? gmailAuthorizationUrl(payload.verification.verificationUri) : payload.verification.verificationUri;
      const pending: PendingMailboxConnection = { provider: input.provider, handle: payload.handle, authorizationUrl, expiresAt: payload.verification.expiresAt, ...(payload.verification.userCode ? { userCode: payload.verification.userCode } : {}), ...(input.email ? { email: input.email } : {}) };
      persistPendingMailbox(pending); setPendingMailbox(pending);
      if (input.provider === 'gmail') window.location.assign(authorizationUrl);
      return { state: 'pending', pending, message: input.provider === 'gmail' ? 'Redirecting to Google…' : 'Continue with Microsoft verification.' };
    }
    if (response.ok && payload?.status === 'ready') {
      clearPendingMailbox(); setPendingMailbox(undefined); await load();
      return { state: 'ready', message: 'Mailbox connected.' };
    }
    return { state: 'error', message: `${input.provider === 'microsoft' ? 'Outlook' : input.provider === 'gmail' ? 'Gmail' : 'IMAP'} connection is unavailable. Check the mailbox details and provider configuration, then try again.` };
  }, [load]);
  const completeMailboxConnection = React.useCallback(async (input: CompleteMailboxConnectionInput): Promise<MailboxConnectionResult> => {
    const response = await fetch('/api/v1/mailboxes/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: mailboxProvider(input.provider), handle: input.handle, ...(input.authorizationResponse ? { authorizationResponse: input.authorizationResponse } : {}), ...(input.code ? { code: input.code } : {}), ...(input.state ? { state: input.state } : {}) }) });
    const payload = await response.json().catch(() => null) as MailboxApiResult | null;
    if (payload?.status === 'ready' && response.ok) {
      clearPendingMailbox(); setPendingMailbox(undefined); await load();
      return { state: 'ready', message: 'Mailbox connected.' };
    }
    if (payload?.status === 'pending') {
      const pending = pendingMailbox?.provider === input.provider && pendingMailbox.handle === input.handle ? pendingMailbox : { provider: input.provider, handle: input.handle };
      setPendingMailbox(pending);
      return { state: 'pending', pending, message: 'Connection is still waiting for provider verification.' };
    }
    if (payload?.status === 'expired') {
      clearPendingMailbox(); setPendingMailbox(undefined);
      return { state: 'expired', message: 'This connection request expired. Start again.' };
    }
    clearPendingMailbox(); setPendingMailbox(undefined);
    const gmailMessage = payload?.status === 'error' && payload.reason === 'provider_configuration'
      ? 'Google rejected the OAuth client configuration. Check the client ID, secret, and exact callback, then start again.'
      : payload?.status === 'error' && payload.reason === 'token_exchange_failed'
        ? 'Google rejected the authorization code during token exchange. Start the Gmail connection again.'
        : payload?.status === 'error' && payload.reason === 'gmail_profile_failed'
          ? 'Google authorized the app, but Gmail profile access failed. Check that Gmail API access is available, then start again.'
          : payload?.status === 'error' && payload.reason === 'authorization_expired'
            ? 'Google authorization expired or was already used. Start the Gmail connection again.'
            : payload?.status === 'error' && payload.reason === 'authorization_rejected'
              ? 'Google authorization state did not match. Start the Gmail connection again.'
              : 'Gmail connection could not be completed. Start again or check provider availability.';
    return { state: 'error', message: input.provider === 'microsoft' ? 'Outlook connection could not be completed. Start again or check provider availability.' : gmailMessage };
  }, [load, pendingMailbox]);
  const changePassword = React.useCallback(async (input: ChangePasswordInput): Promise<ChangePasswordResult> => {
    const response = await fetch('/api/v1/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (response.ok) return { ok: true };
    return { ok: false, error: response.status === 429 ? 'Too many attempts. Wait before trying again.' : 'Your current password was not accepted.' };
  }, []);
  const signOut = React.useCallback(async (): Promise<void> => {
    const response = await fetch('/api/v1/auth/logout', { method: 'POST' });
    if (!response.ok && response.status !== 204) throw new Error('sign out unavailable');
    clearPendingMailbox(); window.location.reload();
  }, []);
  React.useEffect(() => { void load().catch(() => { setState('error'); }); }, [load]);
  React.useEffect(() => {
    if (callbackHandled.current || (state !== 'ready' && state !== 'empty') || location.pathname !== '/oauth/gmail/callback') return;
    callbackHandled.current = true;
    const callback = new URL(location.href); const code = callback.searchParams.get('code'); const providerError = callback.searchParams.has('error'); const authorizationResponse = callback.toString();
    window.history.replaceState(window.history.state, '', '/');
    const pending = readPendingMailbox();
    if (providerError) { clearPendingMailbox(); setPendingMailbox(undefined); toast.warning('Google sign-in was not completed. Start the Gmail connection again.'); return; }
    if (!pending || pending.provider !== 'gmail' || !code) { toast.danger('Gmail connection details were missing or expired. Start again.'); return; }
    void completeMailboxConnection({ provider: 'gmail', handle: pending.handle, authorizationResponse }).then((result) => { const message = result.message ?? (result.state === 'ready' ? 'Mailbox connected.' : 'Gmail connection is still pending.'); if (result.state === 'ready') toast.success(message); else if (result.state === 'error') toast.danger(message); else toast(message); }).catch(() => { clearPendingMailbox(); setPendingMailbox(undefined); toast.danger('Gmail connection could not be completed. Start again.'); });
  }, [completeMailboxConnection, state]);
  if (state === 'loading') return <main className="grid min-h-dvh place-items-center bg-background" aria-busy="true"><span className="sr-only" role="status">Checking session…</span><Spinner className="size-6" /></main>;
  if (state === 'bootstrap') return <Bootstrap onComplete={() => { window.location.reload(); }} onSetupCompleted={() => { setLoginNotice('Setup is complete. Sign in to continue.'); setState('unauthenticated'); }} />;
  if (state === 'unauthenticated') return <Login onComplete={() => { window.location.reload(); }} notice={loginNotice} />;
  const openMessage = async (message: ShellData['messages'][number]) => { const response = await fetch(`/api/v1/messages/${encodeURIComponent(message.id)}`); if (!response.ok) throw new Error('message unavailable'); const detail = (await response.json() as { message: { body: string; attachments: Array<{ id: string; name: string; sizeBytes: number }>; sender: string; subject: string } }).message; return { ...message, sender: detail.sender || message.sender, subject: detail.subject || message.subject, body: detail.body || '', attachments: detail.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, size: `${String(attachment.sizeBytes)} bytes` })) }; };
  const saveDraft = async (draft: { id?: string; expectedVersion?: number; accountId: string; recipient: string; subject: string; body: string }) => { const response = await fetch(draft.id ? `/api/v1/drafts/${encodeURIComponent(draft.id)}` : '/api/v1/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: draft.accountId, recipients: [{ kind: 'to', address: draft.recipient }], subject: draft.subject, body: draft.body, ...(draft.id ? { expectedVersion: draft.expectedVersion } : {}) }) }); if (!response.ok) throw new Error('draft unavailable'); await load(); };
  const updateManagerSettings = async (path: string, body: Readonly<Record<string, unknown>>): Promise<void> => {
    if (!navigator.onLine) throw new Error('offline');
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => null) as { settings?: ManagerSettingsView } | null;
    if (!response.ok || !result?.settings) throw new Error('manager settings unavailable');
    setManagerSettings(result.settings);
  };
  const managerMutations: ManagerMutations = {
    setDefault: (manager: ManagerChoice, revision: number) => updateManagerSettings('/api/v1/mailbox-managers/default', { manager, expectedRevision: revision }),
    setLifecycle: (id, nextState, revision) => updateManagerSettings(`/api/v1/agent-connections/${encodeURIComponent(id)}/${nextState === 'security_revoked' ? 'security-revoke' : 'lifecycle'}`, { state: nextState, expectedRevision: revision }),
    setAssignment: (mailbox: MailboxManagerView, manager: ManagerChoice, automatic: boolean) => updateManagerSettings(`/api/v1/mailbox-managers/${encodeURIComponent(mailbox.mailboxId)}/assignment`, { manager, automaticProcessingEnabled: automatic, expectedAssignmentRevision: mailbox.assignment.revision, ...(mailbox.grant ? { expectedGrantRevision: mailbox.grant.revision } : {}) }),
    reapprove: (mailbox: MailboxManagerView) => updateManagerSettings(`/api/v1/mailbox-managers/${encodeURIComponent(mailbox.mailboxId)}/reapprove`, { expectedGrantRevision: mailbox.grant?.revision, idempotencyKey: crypto.randomUUID() }),
  };
  const agentHandlers: AgentUiHandlers = {
    onAnswer: ({ questionId, answer, expectedVersion, idempotencyKey }) => { void fetch(`/api/v1/agent/questions/${encodeURIComponent(questionId)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ answer, expectedVersion, idempotencyKey }) }).then((response) => { if (!response.ok) throw new Error('answer unavailable'); return load(); }).catch(() => { toast.danger('Could not record the agent answer. Try again.'); }); },
    onRetry: (action) => { void fetch(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ expectedVersion: action.version }) }).then((response) => { if (!response.ok) throw new Error('retry unavailable'); return load(); }).catch(() => { toast.danger('Could not retry the agent action. Try again.'); }); },
    onAutonomy: (target: AutonomyScope, autonomyState: AutonomyState, expectedVersion: number) => { void fetch('/api/v1/agent/autonomy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ scope: target.kind, ...(target.kind === 'account' ? { accountId: target.accountId } : {}), state: autonomyState, expectedVersion }) }).then((response) => { if (!response.ok) throw new Error('autonomy unavailable'); return load(); }).catch(() => { toast.danger('Could not update agent autonomy. Try again.'); }); },
  };
  return <HypermailShell data={data} initialState={state} initialScreen={initialScreen} online={online} drafts={drafts} dashboard={dashboard} agentError={agentError} agentHandlers={agentHandlers} ownerEmail={ownerEmail} settingsMailboxes={settingsMailboxes} {...(managerSettings ? { managerSettings, managerMutations } : {})} {...(pendingMailbox ? { pendingMailboxConnection: pendingMailbox } : {})} onActivityFilter={load} onInboxRetry={() => { void load(); }} onOpenMessage={openMessage} onSaveDraft={saveDraft} onStartMailboxConnection={startMailboxConnection} onCompleteMailboxConnection={completeMailboxConnection} onChangePassword={changePassword} onSignOut={signOut} />;
}

function RootApp(): React.JSX.Element { return <><App /><PwaPresentation /><ToastProvider /></>; }

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Missing app root');
createRoot(appElement).render(<RootApp />);
