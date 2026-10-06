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
import { HypermailShell, type DraftSaveInput, type Screen, type ShellData } from './ui/index.js';
import type { DraftRecord, DraftRevision } from './drafts/contracts.js';
import type { OwnerSendRequest } from './send-requests/contracts.js';
import { ForgotPasswordSurface, ResetPasswordSurface, consumeRecoveryFragment, type RecoveryApi } from './auth/recovery-ui.js';
import type { ActivityPage } from './activity/contracts.js';
import type { ManagerChoice, ManagerSettingsView, MailboxManagerView } from './agent-connections/contracts.js';
import type { ManagerMutations } from './mailbox-managers/index.js';
import type { ChangePasswordInput, ChangePasswordResult } from './ui/account.js';
import type { CompleteMailboxConnectionInput, MailboxConnectionResult, PendingMailboxConnection, SettingsMailbox, StartMailboxConnectionInput } from './ui/settings.js';

const emptyActivity: ActivityPage = { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } };
const empty: ShellData = { accounts: [], messages: [], activity: emptyActivity };
type AppState = 'loading' | 'ready' | 'empty' | 'error' | 'unauthenticated' | 'bootstrap';
type SessionResponse = { user: { id: string; email: string }; accounts: SettingsMailbox[] };
type MailboxApiResult =
  | { status: 'pending'; handle?: string; verification?: { verificationUri?: string; userCode?: string; expiresAt?: string; message?: string } }
  | { status: 'ready' | 'expired' }
  | { status: 'error'; reason?: 'authorization_expired' | 'authorization_rejected' | 'provider_configuration' | 'token_exchange_failed' | 'gmail_profile_failed' | 'provider_unavailable' };
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; }
const recoveryEntry = location.pathname === '/auth/recovery/confirm';
const recoveryToken = recoveryEntry ? consumeRecoveryFragment() : null;
const recoveryApi: RecoveryApi = {
  async request(email) { const response = await fetch('/api/v1/auth/recovery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }); if (!response.ok) throw new Error('Recovery is unavailable.'); },
  async reset(token, password) { const response = await fetch('/api/v1/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) }); if (response.ok) return true; if (response.status === 400 || response.status === 409) return false; throw new Error('Reset is unavailable.'); },
};

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

function Login({ onComplete, onForgot, notice }: { onComplete: () => void; onForgot: () => void; notice?: string }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => { if (notice) toast(notice); }, [notice]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = new FormData(event.currentTarget); setPending(true); void fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }).then((response) => { if (response.ok) onComplete(); else toast.danger('Sign-in failed. Check your email and password.'); }).catch(() => { toast.danger('Sign-in is unavailable. Reconnect and try again.'); }).finally(() => { setPending(false); }); };
  return <AuthCard title="Hypermail"><form onSubmit={submit}><FieldSet disabled={pending}><Field><FieldLabel htmlFor="login-email">Email</FieldLabel><Input id="login-email" name="email" type="email" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="login-password">Password</FieldLabel><Input id="login-password" name="password" type="password" autoComplete="current-password" required /></Field><Button type="submit">{pending ? <><Spinner />Signing in…</> : 'Sign in'}</Button></FieldSet></form><Button type="button" variant="ghost" onClick={onForgot}>Forgot password?</Button></AuthCard>;
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
  const [data, setData] = React.useState<ShellData>(empty); const [drafts, setDrafts] = React.useState<readonly DraftRecord[]>([]);
  const [sendRequests, setSendRequests] = React.useState<readonly OwnerSendRequest[]>([]);
  const [draftHistories, setDraftHistories] = React.useState<Readonly<Record<string, readonly DraftRevision[]>>>({});
  const [recoveryMode, setRecoveryMode] = React.useState<'forgot' | 'reset' | undefined>(recoveryEntry ? 'reset' : undefined);
  const inboxEpoch = React.useRef(0); const selectedAccount = React.useRef<string | undefined>(undefined); const inboxCursor = React.useRef<string | null>(null); const loadingMoreEpoch = React.useRef<number | undefined>(undefined); const loadEpoch = React.useRef(0);
  const [dashboard, setDashboard] = React.useState<AgentDashboard | undefined>(); const [agentError, setAgentError] = React.useState('');
  const [proposalFolders, setProposalFolders] = React.useState<readonly { id: string; name: string; accountId: string }[]>([]);
  const [state, setState] = React.useState<AppState>('loading'); const [loginNotice, setLoginNotice] = React.useState('');
  const [managerSettings, setManagerSettings] = React.useState<ManagerSettingsView>();
  const [ownerEmail, setOwnerEmail] = React.useState(''); const [settingsMailboxes, setSettingsMailboxes] = React.useState<readonly SettingsMailbox[]>([]);
  const [pendingMailbox, setPendingMailbox] = React.useState<PendingMailboxConnection | undefined>(readPendingMailbox);
  const [initialScreen] = React.useState<Screen>(() => location.pathname === '/oauth/gmail/callback' ? 'settings' : /^\/chat(?:\/|$)/.test(location.pathname) ? 'chat' : 'inbox'); const callbackHandled = React.useRef(false);
  const loadInbox = React.useCallback(async (accountId: string, more = false): Promise<void> => {
    if (more && (!inboxCursor.current || loadingMoreEpoch.current === inboxEpoch.current)) return;
    const generation = more ? inboxEpoch.current : ++inboxEpoch.current;
    const cursor = more ? inboxCursor.current : null;
    selectedAccount.current = accountId;
    if (more) loadingMoreEpoch.current = generation; else inboxCursor.current = null;
    setData(current => ({ ...current, selectedAccountId: accountId, messages: current.selectedAccountId === accountId ? current.messages : [], inboxState: more ? current.inboxState ?? 'ready' : 'loading', inboxNextCursor: more ? current.inboxNextCursor ?? null : null, inboxLoadingMore: more, inboxError: '' }));
    try {
      const response = await fetch(`/api/v1/inbox?accountId=${encodeURIComponent(accountId)}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!response.ok) throw new Error(response.status === 404 ? 'This mailbox is unavailable.' : 'The mail provider is unavailable. Retry to refresh this mailbox.');
      const page = await response.json() as { messages: Array<{ id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string; is_read?: boolean }>; nextCursor: string | null };
      if (generation !== inboxEpoch.current || selectedAccount.current !== accountId) return;
      const incoming = page.messages.map(message => ({ id: message.id, accountId: message.account_id, sender: message.sender || 'Unknown sender', initials: (message.sender || '?').slice(0, 1).toUpperCase(), subject: message.subject || '(no subject)', preview: message.preview, received: new Date(message.received_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), receivedAt: message.received_at, ...(message.is_read !== undefined ? { unread: !message.is_read } : {}) }));
      inboxCursor.current = page.nextCursor;
      setData(current => {
        const byId = new Map((more ? current.messages : []).map(message => [message.id, message]));
        for (const message of incoming) byId.set(message.id, message);
        const messages = [...byId.values()];
        return { ...current, messages, inboxState: messages.length ? 'ready' : 'empty', inboxNextCursor: page.nextCursor, inboxLoadingMore: false, inboxError: '' };
      });
    } catch (error) {
      if (generation === inboxEpoch.current && selectedAccount.current === accountId) setData(current => ({ ...current, inboxState: current.messages.length ? 'ready' : 'error', inboxLoadingMore: false, inboxError: error instanceof Error ? error.message : 'Could not load mail.' }));
    } finally { if (loadingMoreEpoch.current === generation) loadingMoreEpoch.current = undefined; }
  }, []);
  const refreshDraftsAndSendRequests = React.useCallback(async (): Promise<void> => {
    const [draftResponse, requestResponse] = await Promise.all([fetch('/api/v1/drafts'), fetch('/api/v1/send-requests')]);
    if (!draftResponse.ok || !requestResponse.ok) throw new Error('Could not refresh sending state.');
    const [draftResult, requestResult] = await Promise.all([draftResponse.json() as Promise<{ drafts: DraftRecord[] }>, requestResponse.json() as Promise<{ requests: OwnerSendRequest[] }>]);
    setDrafts(draftResult.drafts); setSendRequests(requestResult.requests);
  }, []);
  const refreshDraft = React.useCallback(async (id: string): Promise<void> => {
    const [detail, history] = await Promise.all([fetch(`/api/v1/drafts/${encodeURIComponent(id)}`), fetch(`/api/v1/drafts/${encodeURIComponent(id)}/history`)]);
    if (!detail.ok || !history.ok) throw new Error('Could not load the saved draft and its history.');
    const record = (await detail.json() as { draft: DraftRecord }).draft;
    const revisions = (await history.json() as { revisions: DraftRevision[] }).revisions;
    await refreshDraftsAndSendRequests();
    setDrafts(current => [...current.filter(draft => draft.id !== id), record]); setDraftHistories(current => ({ ...current, [id]: revisions }));
  }, [refreshDraftsAndSendRequests]);
  const reloadProposals = React.useCallback(async (refreshDrafts = false): Promise<void> => {
    const response = await fetch('/api/v1/agent', { headers: { 'x-api-version': 'v1' } });
    if (!response.ok) throw new Error('Could not refresh proposals. Your input has been kept.');
    const result = await response.json() as { dashboard: AgentDashboard };
    if (refreshDrafts) {
      const draftResponse = await fetch('/api/v1/drafts');
      if (!draftResponse.ok) throw new Error('Could not refresh prepared drafts.');
      setDrafts((await draftResponse.json() as { drafts: DraftRecord[] }).drafts);
    }
    setDashboard(result.dashboard);
    setAgentError('');
  }, []);
  const load = React.useCallback(async (activityFilter: 'new' | 'questions' | 'failed' | 'history' = 'new') => {
    const generation = ++loadEpoch.current;
    const session = await fetch('/api/v1/session');
    if (generation !== loadEpoch.current) return;
    if (session.status === 401) { let bootstrapAvailable = false; try { bootstrapAvailable = (await session.json() as { bootstrapAvailable?: unknown }).bootstrapAvailable === true; } catch { /* Invalid bodies are not bootstrap capabilities. */ } setState(bootstrapAvailable ? 'bootstrap' : 'unauthenticated'); return; }
    if (!session.ok) throw new Error('load failed');
    const sessionBody = await session.json() as SessionResponse;
    const activity = await fetch(`/api/v1/activities?filter=${encodeURIComponent(activityFilter)}`);
    if (!activity.ok) throw new Error('load failed');
    const activityPage = await activity.json() as ActivityPage;
    await refreshDraftsAndSendRequests();
    if (generation !== loadEpoch.current) return;
    const accounts = sessionBody.accounts.map(account => ({ id: account.id, label: account.displayName ?? account.email, address: account.email }));
    setOwnerEmail(sessionBody.user.email); setSettingsMailboxes(sessionBody.accounts);
    setData(current => ({ ...current, accounts, activity: activityPage })); setState('ready');
    const accountId = accounts.find(account => account.id === selectedAccount.current)?.id ?? accounts[0]?.id;
    if (accountId) await loadInbox(accountId);
    else { inboxEpoch.current += 1; selectedAccount.current = undefined; inboxCursor.current = null; setData({ accounts, messages: [], activity: activityPage, inboxState: 'empty', inboxNextCursor: null }); }
    void Promise.resolve().then(() => fetch('/api/v1/agent-connections')).then(async response => { if (!response.ok) throw new Error('manager settings unavailable'); const result = await response.json() as { settings: ManagerSettingsView }; setManagerSettings(result.settings); }).catch(() => { setManagerSettings(undefined); });
    void Promise.all([reloadProposals(), fetch('/api/v1/agent/folders', { headers: { 'x-api-version': 'v1' } })]).then(async ([, response]) => {
      if (!response.ok) throw new Error('folders unavailable');
      setProposalFolders((await response.json() as { folders: readonly { id: string; name: string; accountId: string }[] }).folders);
    }).catch(() => { setAgentError('Could not refresh agent status or folders. Existing input has been kept.'); });
  }, [reloadProposals, refreshDraftsAndSendRequests, loadInbox]);
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
  React.useEffect(() => { if (recoveryMode) return; void load().catch(() => { setState('error'); }); }, [load, recoveryMode]);
  const hasActiveProposal = dashboard?.proposals.some(proposal => proposal.state === 'ready' || proposal.state === 'authorized' && (proposal.action?.state === 'authorized' || proposal.action?.state === 'executing' || proposal.action?.state === 'verifying')) ?? false;
  React.useEffect(() => {
    if (!online || !hasActiveProposal) return;
    let active = true;
    const interval = setInterval(() => {
      void reloadProposals(true).catch(() => { if (active) setAgentError('Could not refresh agent status. Reconnect to see the latest result.'); });
    }, 5_000);
    return () => { active = false; clearInterval(interval); };
  }, [online, hasActiveProposal, reloadProposals]);
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
  if (recoveryMode) return <AuthCard title="Account recovery">{recoveryMode === 'forgot' ? <ForgotPasswordSurface api={recoveryApi} onLogin={() => { setRecoveryMode(undefined); setState('unauthenticated'); }} /> : <ResetPasswordSurface api={recoveryApi} token={recoveryToken} onLogin={() => { history.replaceState(null, '', '/'); setRecoveryMode(undefined); setLoginNotice('Sign in with your current password.'); setState('unauthenticated'); }} />}</AuthCard>;
  if (state === 'loading') return <main className="grid min-h-dvh place-items-center bg-background" aria-busy="true"><span className="sr-only" role="status">Checking session…</span><Spinner className="size-6" /></main>;
  if (state === 'bootstrap') return <Bootstrap onComplete={() => { window.location.reload(); }} onSetupCompleted={() => { setLoginNotice('Setup is complete. Sign in to continue.'); setState('unauthenticated'); }} />;
  if (state === 'unauthenticated') return <Login onForgot={() => { setRecoveryMode('forgot'); }} onComplete={() => { window.location.reload(); }} notice={loginNotice} />;
  const openMessage = async (message: ShellData['messages'][number]) => { const response = await fetch(`/api/v1/messages/${encodeURIComponent(message.id)}`); if (!response.ok) throw new Error(response.status === 404 ? 'This message no longer exists at the provider.' : 'The provider is unavailable. Retry to load the full message.'); const detail = (await response.json() as { message: { body: string; senderAddress?: string; attachments: Array<{ id: string; name: string; sizeBytes: number }>; sender: string; subject: string } }).message; return { ...message, sender: detail.sender || message.sender, ...(detail.senderAddress ? { senderAddress: detail.senderAddress } : {}), subject: detail.subject || message.subject, body: detail.body, attachments: detail.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, size: `${String(attachment.sizeBytes)} bytes` })) }; };
  const saveDraft = async (input: DraftSaveInput): Promise<DraftRecord> => { const response = await fetch('/api/v1/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: input.accountId, recipients: [{ kind: 'to', address: input.recipient }], subject: input.subject, body: input.body, bodyFormat: input.bodyFormat }) }); if (!response.ok) throw new Error('Draft could not be saved.'); const record = (await response.json() as { draft: DraftRecord }).draft; setDrafts(current => [...current.filter(draft => draft.id !== record.id), record]); void refreshDraft(record.id).catch(() => { toast.warning('Draft saved; history could not be refreshed. Reopen it to retry.'); }); return record; };
  const updateDraft = async (draft: DraftRecord): Promise<void> => { const response = await fetch(`/api/v1/drafts/${encodeURIComponent(draft.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: draft.version, recipients: draft.recipients, subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat }) }); if (!response.ok) throw new Error('Draft changed or is unavailable. Your edits have been kept.'); const record = (await response.json() as { draft: DraftRecord }).draft; setDrafts(current => current.map(item => item.id === record.id ? record : item)); void refreshDraft(record.id).catch(() => { toast.warning('Draft saved; sending state could not be refreshed.'); }); };
  const reply = async (message: ShellData['messages'][number]): Promise<DraftRecord> => { if (message.body === undefined || !message.senderAddress) throw new Error('A full source message is required.'); const response = await fetch('/api/v1/drafts/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: message.accountId, sourceMessageId: message.id, recipients: [{ kind: 'to', address: message.senderAddress }], subject: message.subject, body: '', bodyFormat: 'markdown' }) }); if (!response.ok) throw new Error('Reply unavailable.'); const record = (await response.json() as { draft: DraftRecord }).draft; setDrafts(current => [...current.filter(draft => draft.id !== record.id), record]); void refreshDraft(record.id).catch(() => { toast.warning('Reply saved; history could not be refreshed.'); }); return record; };
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
    activateAssistant: mailbox => updateManagerSettings(`/api/v1/mailboxes/${encodeURIComponent(mailbox.mailboxId)}/assistant/activate`, { confirmed: true, expectedAssignmentRevision: mailbox.assignment.revision, expectedGrantRevision: mailbox.grant?.revision ?? null }),
  };
  const agentHandlers: AgentUiHandlers = {
    onReloadProposals: reloadProposals,
    onReview: async ({ proposalId, ...input }) => {
      if (!navigator.onLine) throw new Error('Reconnect before reviewing this proposal. Your input has been kept.');
      const response = await fetch(`/api/v1/agent/proposals/${encodeURIComponent(proposalId)}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify(input),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw Object.assign(new Error(result?.error?.message ?? 'Could not record this review. Your input has been kept.'), { status: response.status });
      }
      await reloadProposals();
    },
    onAnswer: ({ questionId, answer, expectedVersion, idempotencyKey }) => { void fetch(`/api/v1/agent/questions/${encodeURIComponent(questionId)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ answer, expectedVersion, idempotencyKey }) }).then((response) => { if (!response.ok) throw new Error('answer unavailable'); return load(); }).catch(() => { toast.danger('Could not record the agent answer. Try again.'); }); },
    onRetry: (action) => { void fetch(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ expectedVersion: action.version }) }).then((response) => { if (!response.ok) throw new Error('retry unavailable'); return load(); }).catch(() => { toast.danger('Could not retry the agent action. Try again.'); }); },
    onAutonomy: (target: AutonomyScope, autonomyState: AutonomyState, expectedVersion: number) => { void fetch('/api/v1/agent/autonomy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ scope: target.kind, ...(target.kind === 'account' ? { accountId: target.accountId } : {}), state: autonomyState, expectedVersion }) }).then((response) => { if (!response.ok) throw new Error('autonomy unavailable'); return load(); }).catch(() => { toast.danger('Could not update agent autonomy. Try again.'); }); },
  };
  return <HypermailShell data={data} initialState={state} initialScreen={initialScreen} online={online} drafts={drafts} draftHistories={draftHistories} sendRequests={sendRequests} onRefreshSendRequests={refreshDraftsAndSendRequests} onRefreshDraft={refreshDraft} onUpdateDraft={updateDraft} onReply={reply} dashboard={dashboard} agentError={agentError} agentHandlers={agentHandlers} proposalFolders={proposalFolders} ownerEmail={ownerEmail} settingsMailboxes={settingsMailboxes} {...(managerSettings ? { managerSettings, managerMutations } : {})} {...(pendingMailbox ? { pendingMailboxConnection: pendingMailbox } : {})} onActivityFilter={load} onInboxRetry={() => { if (selectedAccount.current) void loadInbox(selectedAccount.current); }} onAccountChange={id => { void loadInbox(id); }} onLoadMore={() => { if (selectedAccount.current) void loadInbox(selectedAccount.current, true); }} onOpenMessage={openMessage} onSaveDraft={saveDraft} onStartMailboxConnection={startMailboxConnection} onCompleteMailboxConnection={completeMailboxConnection} onChangePassword={changePassword} onSignOut={signOut} />;
}

function RootApp(): React.JSX.Element { return <><App /><PwaPresentation /><ToastProvider /></>; }

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Missing app root');
createRoot(appElement).render(<RootApp />);
