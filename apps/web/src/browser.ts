/// <reference lib="dom" />

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { HypermailShell, type ActivityItem, type ActivityState, type Draft, type ShellData } from './ui/index.js';
import type { AgentDashboard, AgentUiHandlers, AutonomyScope, AutonomyState } from './agent/index.js';
import { activateWaitingUpdate, registerPwaWorker, type ServiceWorkerRegistrationLike } from './pwa/registration.js';
import { initialPwaState } from './pwa/state.js';
import './ui/hypermail.css';

const empty: ShellData = { accounts: [], messages: [], activity: [] };
type BrowserDraft = Draft;
type ActivityResponse = { id: string; state: string; version: number; title: string; accountLabel: string; createdAt: string };
const toActivityState = (state: string): ActivityState => state === 'failed' ? 'failed' : state === 'waiting_question' ? 'question' : state === 'acknowledged' ? 'complete' : 'new';
const activityItem = (item: ActivityResponse): ActivityItem => ({ id: item.id, expectedVersion: item.version, state: toActivityState(item.state), title: item.title, context: item.accountLabel, time: new Date(item.createdAt).toLocaleString(), action: item.state === 'failed' ? 'Retry' : item.state === 'handled' ? 'Acknowledge' : 'Review' });
const appElement = document.getElementById('app');
if (!appElement) throw new Error('Missing app root');
const root = createRoot(appElement);

function Login({ onComplete, notice }: { onComplete: () => void; notice?: string }) {
  const [error, setError] = React.useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }).then((response) => { if (response.ok) onComplete(); else setError('Sign-in failed. Check your email and password.'); }).catch(() => { setError('Sign-in is unavailable. Reconnect and try again.'); }); };
  return React.createElement('main', { className: 'auth-screen', 'aria-labelledby': 'auth-title' }, React.createElement('section', { className: 'shell' }, React.createElement('h1', { id: 'auth-title' }, 'Hypermail'), notice && React.createElement('p', { role: 'status' }, notice), React.createElement('form', { onSubmit: submit }, React.createElement('label', null, 'Email', React.createElement('input', { name: 'email', type: 'email', autoComplete: 'email', required: true })), React.createElement('label', null, 'Password', React.createElement('input', { name: 'password', type: 'password', autoComplete: 'current-password', required: true })), React.createElement('button', { type: 'submit' }, 'Sign in')), error && React.createElement('p', { role: 'alert' }, error)));
}

function Bootstrap({ onComplete, onSetupCompleted }: { onComplete: () => void; onSetupCompleted: () => void }) {
  const [error, setError] = React.useState(''); const [pending, setPending] = React.useState(false);
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = event.currentTarget; const password = form.elements.namedItem('password') as HTMLInputElement; const confirmation = form.elements.namedItem('confirmPassword') as HTMLInputElement; confirmation.setCustomValidity(password.value === confirmation.value ? '' : 'Passwords do not match.'); if (!form.reportValidity()) return; setError(''); setPending(true); void fetch('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: new FormData(form).get('email'), password: password.value }) }).then((response) => { if (response.status === 201) onComplete(); else if (response.status === 409) onSetupCompleted(); else setError('Setup is unavailable. Try again.'); }).catch(() => { setError('Setup is unavailable. Try again.'); }).finally(() => { setPending(false); }); };
  const confirmPassword = (event: React.FormEvent<HTMLInputElement>) => { const input = event.currentTarget; const password = input.form?.elements.namedItem('password') as HTMLInputElement | null; input.setCustomValidity(password?.value === input.value ? '' : 'Passwords do not match.'); };
  return React.createElement('main', { className: 'auth-screen', 'aria-labelledby': 'auth-title' }, React.createElement('section', { className: 'shell' }, React.createElement('h1', { id: 'auth-title' }, 'Set up Hypermail'), React.createElement('p', { id: 'setup-password-help' }, 'Create the private owner account for this Hypermail installation.'), React.createElement('form', { onSubmit: submit }, React.createElement('fieldset', { disabled: pending }, React.createElement('label', null, 'Email', React.createElement('input', { name: 'email', type: 'email', autoComplete: 'email', required: true })), React.createElement('label', null, 'Password', React.createElement('input', { name: 'password', type: 'password', autoComplete: 'new-password', minLength: 12, maxLength: 1024, required: true, 'aria-describedby': 'setup-password-help' })), React.createElement('label', null, 'Confirm password', React.createElement('input', { name: 'confirmPassword', type: 'password', autoComplete: 'new-password', minLength: 12, maxLength: 1024, required: true, onInput: confirmPassword, 'aria-describedby': error ? 'setup-password-help setup-error' : 'setup-password-help' })), React.createElement('button', { type: 'submit' }, pending ? 'Setting up…' : 'Set up private owner'))), error && React.createElement('p', { id: 'setup-error', role: 'alert' }, error)));
}

function App() {
  const [data, setData] = React.useState<ShellData>(empty); const [drafts, setDrafts] = React.useState<readonly BrowserDraft[]>([]);
  const [dashboard, setDashboard] = React.useState<AgentDashboard | undefined>();
  const [state, setState] = React.useState<'loading' | 'ready' | 'empty' | 'error' | 'unauthenticated' | 'bootstrap'>('loading'); const [loginNotice, setLoginNotice] = React.useState('');
  const load = React.useCallback(async () => {
    const session = await fetch('/api/v1/session');
    if (session.status === 401) { let bootstrapAvailable = false; try { bootstrapAvailable = (await session.json() as { bootstrapAvailable?: unknown }).bootstrapAvailable === true; } catch { /* Invalid bodies are not bootstrap capabilities. */ } setState(bootstrapAvailable ? 'bootstrap' : 'unauthenticated'); return; }
    if (!session.ok) throw new Error('load failed');
    const [inbox, activity, draftResponse] = await Promise.all([fetch('/api/v1/inbox'), fetch('/api/v1/activities?filter=new'), fetch('/api/v1/drafts')]);
    if (!inbox.ok || !activity.ok || !draftResponse.ok) throw new Error('load failed');
    const accounts = (await session.json() as { accounts: Array<{ id: string; displayName: string | null; email: string }> }).accounts.map((account) => ({ id: account.id, label: account.displayName ?? account.email, address: account.email, unread: 0, color: 'blue' as const }));
    const messages = (await inbox.json() as { messages: Array<{ id: string; account_id: string; sender: string; subject: string; preview: string; received_at: string }> }).messages.map((message) => ({ id: message.id, accountId: message.account_id, sender: message.sender || 'Unknown sender', initials: (message.sender || '?').slice(0, 1).toUpperCase(), subject: message.subject || '(no subject)', preview: message.preview, received: new Date(message.received_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), body: message.preview }));
    const items = (await activity.json() as { items: ActivityResponse[] }).items.map(activityItem);
    setDrafts((await draftResponse.json() as { drafts: BrowserDraft[] }).drafts); setData({ accounts, messages, activity: items }); setState(messages.length || items.length ? 'ready' : 'empty');
    void fetch('/api/v1/agent', { headers: { 'x-api-version': 'v1' } }).then(async (response) => response.ok ? response.json() as Promise<{ dashboard: AgentDashboard }> : undefined).then((result) => { setDashboard(result?.dashboard); }).catch(() => { setDashboard(undefined); });
  }, []);
  React.useEffect(() => { void load().catch(() => { setState('error'); }); }, [load]);
  if (state === 'loading') return React.createElement('main', { className: 'auth-screen', 'aria-busy': 'true' }, React.createElement('p', { className: 'hm-sr-only', role: 'status' }, 'Checking session…'));
  if (state === 'bootstrap') return React.createElement(Bootstrap, { onComplete: () => { window.location.reload(); }, onSetupCompleted: () => { setLoginNotice('Setup is complete. Sign in to continue.'); setState('unauthenticated'); } });
  if (state === 'unauthenticated') return React.createElement(Login, { onComplete: () => { window.location.reload(); }, notice: loginNotice });
  const openMessage = async (message: ShellData['messages'][number]) => { const response = await fetch(`/api/v1/messages/${encodeURIComponent(message.id)}`); if (!response.ok) throw new Error('message unavailable'); const detail = (await response.json() as { message: { body: string; attachments: Array<{ id: string; name: string; sizeBytes: number }>; sender: string; subject: string } }).message; return { ...message, sender: detail.sender || message.sender, subject: detail.subject || message.subject, body: detail.body || '', attachments: detail.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, size: `${String(attachment.sizeBytes)} bytes`, safe: true })) }; };
  const saveDraft = async (draft: { id?: string; accountId: string; recipient: string; subject: string; body: string }) => { const response = await fetch(draft.id ? `/api/v1/drafts/${encodeURIComponent(draft.id)}` : '/api/v1/drafts', { method: draft.id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: draft.accountId, recipients: [{ kind: 'to', address: draft.recipient }], subject: draft.subject, body: draft.body }) }); if (!response.ok) throw new Error('draft unavailable'); await load(); };
  const mutateActivity = async (item: ActivityItem) => { const endpoint = item.action === 'Retry' ? 'retry' : item.action === 'Acknowledge' ? 'acknowledge' : null; if (!endpoint || item.expectedVersion === undefined) return; const response = await fetch(`/api/v1/activities/${encodeURIComponent(item.id)}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: item.expectedVersion }) }); if (!response.ok) throw new Error('activity unavailable'); await load(); };
  const agentHandlers: AgentUiHandlers = {
    onAnswer: ({ questionId, answer, expectedVersion, idempotencyKey }) => { void fetch(`/api/v1/agent/questions/${encodeURIComponent(questionId)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ answer, expectedVersion, idempotencyKey }) }).then((response) => { if (!response.ok) throw new Error('answer unavailable'); return load(); }).catch(() => {}); },
    onRetry: (action) => { void fetch(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ expectedVersion: action.version }) }).then((response) => { if (!response.ok) throw new Error('retry unavailable'); return load(); }).catch(() => {}); },
    onAutonomy: (target: AutonomyScope, autonomyState: AutonomyState, expectedVersion: number) => { void fetch('/api/v1/agent/autonomy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ scope: target.kind, ...(target.kind === 'account' ? { accountId: target.accountId } : {}), state: autonomyState, expectedVersion }) }).then((response) => { if (!response.ok) throw new Error('autonomy unavailable'); return load(); }).catch(() => {}); },
  };
  return React.createElement(HypermailShell, { data, initialState: state, drafts, dashboard, agentHandlers, onActivityAction: (item) => { void mutateActivity(item); }, onOpenMessage: openMessage, onSaveDraft: saveDraft });
}
root.render(React.createElement(App));

let deferredInstall: BeforeInstallPromptEvent | undefined; let registration: ServiceWorkerRegistrationLike | undefined;
const install = document.querySelector<HTMLButtonElement>('#install'); const update = document.querySelector<HTMLButtonElement>('#update'); const connection = document.querySelector('#connection');
const showConnection = () => { if (connection) connection.textContent = navigator.onLine ? 'Online' : 'Offline — reconnect to use Hypermail.'; };
showConnection(); addEventListener('online', showConnection); addEventListener('offline', showConnection);
addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event as BeforeInstallPromptEvent; if (install) install.hidden = false; });
install?.addEventListener('click', () => { void deferredInstall?.prompt(); });
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  void registerPwaWorker(navigator.serviceWorker, (pwaState) => { if (pwaState.update === 'available' && update) update.hidden = false; }, initialPwaState).then((value) => { registration = value; }).catch(() => {});
}
update?.addEventListener('click', () => { if (registration) activateWaitingUpdate(registration); });
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; }
