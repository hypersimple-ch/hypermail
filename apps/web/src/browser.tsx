/// <reference lib="dom" />

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentDashboard, AgentUiHandlers, AutonomyScope, AutonomyState } from './agent/index.js';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card.js';
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet } from '@/components/ui/field.js';
import { Input } from '@/components/ui/input.js';
import { Spinner } from '@/components/ui/spinner.js';
import { activateWaitingUpdate, registerPwaWorker, type ServiceWorkerRegistrationLike } from './pwa/registration.js';
import { initialPwaState } from './pwa/state.js';
import { HypermailShell, type ActivityItem, type ActivityState, type Draft, type ShellData } from './ui/index.js';

const empty: ShellData = { accounts: [], messages: [], activity: [] };
type BrowserDraft = Draft;
type ActivityResponse = { id: string; state: string; version: number; title: string; accountLabel: string; createdAt: string };
type AppState = 'loading' | 'ready' | 'empty' | 'error' | 'unauthenticated' | 'bootstrap';
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; }

const toActivityState = (state: string): ActivityState => state === 'failed' ? 'failed' : state === 'waiting_question' ? 'question' : state === 'acknowledged' ? 'complete' : 'new';
const activityItem = (item: ActivityResponse): ActivityItem => ({ id: item.id, expectedVersion: item.version, state: toActivityState(item.state), title: item.title, context: item.accountLabel, time: new Date(item.createdAt).toLocaleString(), action: item.state === 'failed' ? 'Retry' : item.state === 'handled' ? 'Acknowledge' : 'Review' });

function AuthCard({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <main className="grid min-h-dvh place-items-center bg-background p-4" aria-labelledby="auth-title"><Card className="w-full max-w-md"><CardHeader><h1 id="auth-title" className="text-2xl font-semibold tracking-tight">{title}</h1>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent>{children}</CardContent></Card></main>;
}

function Login({ onComplete, notice }: { onComplete: () => void; notice?: string }): React.JSX.Element {
  const [error, setError] = React.useState(''); const [pending, setPending] = React.useState(false);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = new FormData(event.currentTarget); setError(''); setPending(true); void fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }).then((response) => { if (response.ok) onComplete(); else setError('Sign-in failed. Check your email and password.'); }).catch(() => { setError('Sign-in is unavailable. Reconnect and try again.'); }).finally(() => { setPending(false); }); };
  return <AuthCard title="Hypermail"><div className="grid gap-4">{notice ? <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}<form onSubmit={submit}><FieldSet disabled={pending}><Field><FieldLabel htmlFor="login-email">Email</FieldLabel><Input id="login-email" name="email" type="email" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="login-password">Password</FieldLabel><Input id="login-password" name="password" type="password" autoComplete="current-password" required /></Field><Button type="submit">{pending ? <><Spinner />Signing in…</> : 'Sign in'}</Button></FieldSet></form>{error ? <FieldError>{error}</FieldError> : null}</div></AuthCard>;
}

function Bootstrap({ onComplete, onSetupCompleted }: { onComplete: () => void; onSetupCompleted: () => void }): React.JSX.Element {
  const [error, setError] = React.useState(''); const [pending, setPending] = React.useState(false);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = event.currentTarget; const password = form.elements.namedItem('password') as HTMLInputElement; const confirmation = form.elements.namedItem('confirmPassword') as HTMLInputElement; confirmation.setCustomValidity(password.value === confirmation.value ? '' : 'Passwords do not match.'); if (!form.reportValidity()) return; setError(''); setPending(true); void fetch('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: new FormData(form).get('email'), password: password.value }) }).then((response) => { if (response.status === 201) onComplete(); else if (response.status === 409) onSetupCompleted(); else setError('Setup is unavailable. Try again.'); }).catch(() => { setError('Setup is unavailable. Try again.'); }).finally(() => { setPending(false); }); };
  const confirmPassword = (event: React.FormEvent<HTMLInputElement>) => { const input = event.currentTarget; const password = input.form?.elements.namedItem('password') as HTMLInputElement | null; input.setCustomValidity(password?.value === input.value ? '' : 'Passwords do not match.'); };
  return <AuthCard title="Set up Hypermail" description="Create the private owner account for this Hypermail installation."><form onSubmit={submit}><FieldSet disabled={pending}><Field><FieldLabel htmlFor="setup-email">Email</FieldLabel><Input id="setup-email" name="email" type="email" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="setup-password">Password</FieldLabel><Input id="setup-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required aria-describedby="setup-password-help" /><FieldDescription id="setup-password-help">Use at least 12 characters.</FieldDescription></Field><Field><FieldLabel htmlFor="setup-confirm-password">Confirm password</FieldLabel><Input id="setup-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required onInput={confirmPassword} aria-describedby={error ? 'setup-password-help setup-error' : 'setup-password-help'} /></Field><Button type="submit">{pending ? <><Spinner />Setting up…</> : 'Set up private owner'}</Button></FieldSet>{error ? <FieldError id="setup-error">{error}</FieldError> : null}</form></AuthCard>;
}

function PwaPresentation(): React.JSX.Element {
  const [online, setOnline] = React.useState(() => navigator.onLine); const [installAvailable, setInstallAvailable] = React.useState(false); const [updateAvailable, setUpdateAvailable] = React.useState(false);
  const deferredInstall = React.useRef<BeforeInstallPromptEvent | undefined>(undefined); const registration = React.useRef<ServiceWorkerRegistrationLike | undefined>(undefined);
  React.useEffect(() => { const updateConnection = () => { setOnline(navigator.onLine); }; addEventListener('online', updateConnection); addEventListener('offline', updateConnection); return () => { removeEventListener('online', updateConnection); removeEventListener('offline', updateConnection); }; }, []);
  React.useEffect(() => { const available = (event: Event) => { event.preventDefault(); deferredInstall.current = event as BeforeInstallPromptEvent; setInstallAvailable(true); }; addEventListener('beforeinstallprompt', available); return () => { removeEventListener('beforeinstallprompt', available); }; }, []);
  React.useEffect(() => { if (!('serviceWorker' in navigator)) return; let reloading = false; const reload = () => { if (!reloading) { reloading = true; location.reload(); } }; navigator.serviceWorker.addEventListener('controllerchange', reload); void registerPwaWorker(navigator.serviceWorker, (pwaState) => { setUpdateAvailable(pwaState.update === 'available'); }, initialPwaState).then((value) => { registration.current = value; }).catch(() => {}); return () => { navigator.serviceWorker.removeEventListener('controllerchange', reload); }; }, []);
  const install = () => { void deferredInstall.current?.prompt(); };
  const update = () => { if (registration.current) activateWaitingUpdate(registration.current); };
  return <><p role="status" aria-live="polite" className="sr-only">{online ? 'Online' : 'Offline — reconnect to use Hypermail.'}</p>{installAvailable || updateAvailable ? <aside aria-label="Application utilities" className="fixed inset-x-0 bottom-3 z-10 flex flex-wrap justify-center gap-2 px-4"><Card className="flex-row items-center gap-2 p-2 shadow-lg">{installAvailable ? <Button type="button" variant="outline" onClick={install}>Install Hypermail</Button> : null}{updateAvailable ? <Button type="button" variant="outline" onClick={update}>Reload to update</Button> : null}</Card></aside> : null}</>;
}

function App(): React.JSX.Element {
  const [data, setData] = React.useState<ShellData>(empty); const [drafts, setDrafts] = React.useState<readonly BrowserDraft[]>([]);
  const [dashboard, setDashboard] = React.useState<AgentDashboard | undefined>(); const [agentError, setAgentError] = React.useState('');
  const [state, setState] = React.useState<AppState>('loading'); const [loginNotice, setLoginNotice] = React.useState('');
  const load = React.useCallback(async (activityFilter: 'new' | 'questions' | 'failed' | 'history' = 'new') => {
    const session = await fetch('/api/v1/session');
    if (session.status === 401) { let bootstrapAvailable = false; try { bootstrapAvailable = (await session.json() as { bootstrapAvailable?: unknown }).bootstrapAvailable === true; } catch { /* Invalid bodies are not bootstrap capabilities. */ } setState(bootstrapAvailable ? 'bootstrap' : 'unauthenticated'); return; }
    if (!session.ok) throw new Error('load failed');
    const [inbox, activity, draftResponse] = await Promise.all([fetch('/api/v1/inbox'), fetch(`/api/v1/activities?filter=${encodeURIComponent(activityFilter)}`), fetch('/api/v1/drafts')]);
    if (!inbox.ok || !activity.ok || !draftResponse.ok) throw new Error('load failed');
    const accounts = (await session.json() as { accounts: Array<{ id: string; displayName: string | null; email: string }> }).accounts.map((account) => ({ id: account.id, label: account.displayName ?? account.email, address: account.email, unread: 0, color: 'blue' as const }));
    const messages = (await inbox.json() as { messages: Array<{ id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string }> }).messages.map((message) => ({ id: message.id, accountId: message.account_id, sender: message.sender || 'Unknown sender', initials: (message.sender || '?').slice(0, 1).toUpperCase(), subject: message.subject || '(no subject)', preview: message.preview, received: new Date(message.received_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), body: message.preview }));
    const items = (await activity.json() as { items: ActivityResponse[] }).items.map(activityItem);
    setDrafts((await draftResponse.json() as { drafts: BrowserDraft[] }).drafts); setData({ accounts, messages, activity: items }); setState(messages.length || items.length ? 'ready' : 'empty');
    void fetch('/api/v1/agent', { headers: { 'x-api-version': 'v1' } }).then(async (response) => response.ok ? response.json() as Promise<{ dashboard: AgentDashboard }> : Promise.reject(new Error('agent unavailable'))).then((result) => { setAgentError(''); setDashboard(result.dashboard); }).catch(() => { setDashboard(undefined); setAgentError('Could not load agent status. Try again later.'); });
  }, []);
  React.useEffect(() => { void load().catch(() => { setState('error'); }); }, [load]);
  if (state === 'loading') return <main className="grid min-h-dvh place-items-center bg-background" aria-busy="true"><span className="sr-only" role="status">Checking session…</span><Spinner className="size-6" /></main>;
  if (state === 'bootstrap') return <Bootstrap onComplete={() => { window.location.reload(); }} onSetupCompleted={() => { setLoginNotice('Setup is complete. Sign in to continue.'); setState('unauthenticated'); }} />;
  if (state === 'unauthenticated') return <Login onComplete={() => { window.location.reload(); }} notice={loginNotice} />;
  const openMessage = async (message: ShellData['messages'][number]) => { const response = await fetch(`/api/v1/messages/${encodeURIComponent(message.id)}`); if (!response.ok) throw new Error('message unavailable'); const detail = (await response.json() as { message: { body: string; attachments: Array<{ id: string; name: string; sizeBytes: number }>; sender: string; subject: string } }).message; return { ...message, sender: detail.sender || message.sender, subject: detail.subject || message.subject, body: detail.body || '', attachments: detail.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, size: `${String(attachment.sizeBytes)} bytes` })) }; };
  const saveDraft = async (draft: { id?: string; expectedVersion?: number; accountId: string; recipient: string; subject: string; body: string }) => { const response = await fetch(draft.id ? `/api/v1/drafts/${encodeURIComponent(draft.id)}` : '/api/v1/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: draft.accountId, recipients: [{ kind: 'to', address: draft.recipient }], subject: draft.subject, body: draft.body, ...(draft.id ? { expectedVersion: draft.expectedVersion } : {}) }) }); if (!response.ok) throw new Error('draft unavailable'); await load(); };
  const mutateActivity = async (item: ActivityItem) => { const endpoint = item.action === 'Retry' ? 'retry' : item.action === 'Acknowledge' ? 'acknowledge' : null; if (!endpoint || item.expectedVersion === undefined) return; const response = await fetch(`/api/v1/activities/${encodeURIComponent(item.id)}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: item.expectedVersion }) }); if (!response.ok) throw new Error('activity unavailable'); await load(); };
  const agentHandlers: AgentUiHandlers = {
    onAnswer: ({ questionId, answer, expectedVersion, idempotencyKey }) => { void fetch(`/api/v1/agent/questions/${encodeURIComponent(questionId)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ answer, expectedVersion, idempotencyKey }) }).then((response) => { if (!response.ok) throw new Error('answer unavailable'); return load(); }).catch(() => { setAgentError('Could not record the agent answer. Try again.'); }); },
    onRetry: (action) => { void fetch(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ expectedVersion: action.version }) }).then((response) => { if (!response.ok) throw new Error('retry unavailable'); return load(); }).catch(() => { setAgentError('Could not retry the agent action. Try again.'); }); },
    onAutonomy: (target: AutonomyScope, autonomyState: AutonomyState, expectedVersion: number) => { void fetch('/api/v1/agent/autonomy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ scope: target.kind, ...(target.kind === 'account' ? { accountId: target.accountId } : {}), state: autonomyState, expectedVersion }) }).then((response) => { if (!response.ok) throw new Error('autonomy unavailable'); return load(); }).catch(() => { setAgentError('Could not update agent autonomy. Try again.'); }); },
  };
  return <HypermailShell data={data} initialState={state} drafts={drafts} dashboard={dashboard} agentError={agentError} agentHandlers={agentHandlers} onActivityAction={mutateActivity} onActivityFilter={load} onInboxRetry={() => { void load(); }} onOpenMessage={openMessage} onSaveDraft={saveDraft} />;
}

function RootApp(): React.JSX.Element { return <><App /><PwaPresentation /></>; }

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Missing app root');
createRoot(appElement).render(<RootApp />);
