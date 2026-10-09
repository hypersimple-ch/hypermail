/// <reference lib="dom" />

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HypermailShell, type Screen } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';
import { PwaUtilities } from '../../src/components/app/pwa-utilities.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';
import type { OwnerSendRequest } from '../../src/send-requests/contracts.js';
import type { Conversation, ConversationMessage } from '@hypermail/contracts';

const params = new URLSearchParams(location.search);
const screen = (params.get('screen') ?? 'inbox') as Screen;
const mode = params.get('mode');
if (params.get('largeText') === 'true') document.documentElement.style.fontSize = '20px';
const timestamp = '2026-10-01T00:00:00Z';
const conversation: Conversation = { id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', scope: 'mailbox', accountId: 'personal', contextMessageId: null, version: 1, createdAt: timestamp, updatedAt: timestamp };
const messages: ConversationMessage[] = Array.from({ length: 32 }, (_, index) => ({ id: `fixture-message-${String(index)}`, conversationId: conversation.id, sequence: index + 1, role: index % 2 ? 'assistant' : 'user', content: `Fixture message ${String(index + 1)}: ${'A deterministic conversation keeps the transcript scrollable. '.repeat(5)}`, requestId: null, replyTo: null, createdAt: timestamp, turn: null }));
let postedMessage: ConversationMessage | undefined;
const completePendingReply = () => {
  const pendingMessage = postedMessage;
  if (!pendingMessage?.turn) throw new Error('No pending fixture turn');
  const index = messages.findIndex(message => message.id === pendingMessage.id);
  messages[index] = { ...pendingMessage, turn: { ...pendingMessage.turn, state: 'completed' } };
  messages.push({ ...pendingMessage, id: 'fixture-completed-reply', sequence: pendingMessage.sequence + 1, role: 'assistant', content: 'Reply completed while minimized', requestId: null, replyTo: pendingMessage.id, turn: null });
};
const draft = (id: string, subject: string): DraftRecord => ({ id, accountId: 'personal', sourceMessageId: null, recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject, body: 'Exact fixture body', bodyFormat: 'markdown', createdBy: 'user', state: 'editing', version: 1, createdAt: timestamp, updatedAt: timestamp });
const unknown: DraftRecord = { ...draft('unknown-draft', 'Uncertain owner submission'), submission: { approvalId: 'unknown-approval', state: 'unknown', reasonCode: 'PROVIDER_SENT_ID_UNVERIFIABLE', manualReview: null, dispatchMayHaveOccurred: true } };
let requests: OwnerSendRequest[] = ['pending_owner_approval', 'pending_owner_approval', 'rejected'].map((state, index) => ({ id: `request-${String(index)}`, accountId: index === 1 ? 'work' : 'personal', draftId: `draft-${String(index)}`, draftVersion: 1, state: state as OwnerSendRequest['state'], approvalId: null, actionId: null, providerMessageId: null, expiresAt: '2099-01-01T00:00:00Z', completedAt: null, reasonCode: null, createdAt: timestamp, updatedAt: timestamp, snapshot: draft(`draft-${String(index)}`, `Agent request ${String(index + 1)}`) }));
// All network work is fixture-only: no live conversation, approval, or send endpoints.
window.fetch = (input, init) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    let body: unknown;
    if (url.pathname === '/api/v1/conversations') body = init?.method === 'POST' ? { conversation } : { conversations: [conversation], nextCursor: null };
    else if (url.pathname === `/api/v1/conversations/${conversation.id}/messages` && (!init?.method || init.method === 'GET')) body = { conversation, messages, nextCursor: null };
    else if (/^\/api\/v1\/messages\/[^/]+\/activities$/.test(url.pathname) && (!init?.method || init.method === 'GET')) body = { items: [] };
    else if (url.pathname === `/api/v1/conversations/${conversation.id}/messages` && init?.method === 'POST') {
      if (typeof init.body !== 'string') return Promise.reject(new Error('Missing JSON fixture request body'));
      const input = JSON.parse(init.body) as { requestId: string; content: string };
      const turn = { id: 'fixture-turn', userMessageId: 'fixture-post', state: 'pending' as const, attempt: 0, availableAt: timestamp, errorCode: null, claimExpiresAt: null };
      postedMessage = { id: turn.userMessageId, conversationId: conversation.id, sequence: messages.length + 1, role: 'user', content: input.content, requestId: input.requestId, replyTo: null, createdAt: timestamp, turn };
      messages.push(postedMessage); body = { conversation: { ...conversation, version: 2 }, message: postedMessage, turn, replayed: false };
    }
    else if (/^\/api\/v1\/send-requests\/request-\d\/reject$/.test(url.pathname) && init?.method === 'POST') {
      const id = url.pathname.split('/')[4]; requests = requests.map(request => request.id === id ? { ...request, state: 'rejected' } : request); body = {};
    } else throw new Error(`Unexpected fixture request: ${init?.method ?? 'GET'} ${url.pathname}`);
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Fixture request failed', { cause: error }));
  }
};
function Fixture(): React.JSX.Element {
  const [loaded, setLoaded] = React.useState(requests);
  const openMessage: NonNullable<React.ComponentProps<typeof HypermailShell>['onOpenMessage']> = message => {
    const full = mockShellData.messages.find(item => item.id === message.id && item.accountId === message.accountId);
    if (!full || full.body === undefined) return Promise.reject(new Error('Missing full-message fixture'));
    return Promise.resolve(full);
  };
  return <><HypermailShell data={mockShellData} onOpenMessage={openMessage} initialScreen={mode === 'approvals' ? 'pending-sends' : screen === 'message' ? 'inbox' : screen} sendingState={mode === 'loading' ? 'loading' : mode === 'load-error' ? 'error' : 'ready'} ownerEmail="owner.with.an.extremely.long.private.address.for.viewport.checks@example.test" online settingsMailboxes={[{ id: 'personal', provider: 'gmail', email: 'owner@example.test', displayName: 'Personal', state: 'ready' }]} drafts={[unknown]} sendRequests={loaded} onRefreshSendRequests={() => { if (mode === 'refresh-error') return Promise.reject(new Error('Fixture refresh failure')); setLoaded([...requests]); return Promise.resolve(); }} onChangePassword={() => Promise.resolve({ ok: true })} onSignOut={() => Promise.resolve()} />{mode === 'utilities' && <PwaUtilities installAvailable updateAvailable onInstall={() => {}} onUpdate={() => {}} />}</>;
}
const app = document.getElementById('app');
if (!app) throw new Error('Missing layout fixture root');
const root = createRoot(app);
flushSync(() => { root.render(<Fixture />); });
const visible = (selector: string, scope: ParentNode = document): HTMLElement | undefined => Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
if (screen === 'message') {
  const message = visible('button[aria-label^="Open message from"]');
  if (!message) throw new Error('No selectable message in the layout fixture');
  flushSync(() => { message.click(); });
}
const box = (element: Element | undefined) => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const dimensions = ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'] as const;
  return Object.fromEntries(dimensions.map(key => [key, Math.round(rect[key] * 100) / 100]));
};
function metrics() {
  const navigation = visible('nav[aria-label="Mobile primary"]');
  const rail = visible('aside[aria-label="Mailbox navigation"]');
  const compose = visible('button[aria-label="Compose"]') ?? Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent.trim() === 'Compose' && button.getBoundingClientRect().width > 0);
  const dialog = visible('#assistant-dialog');
  const backdrop = visible('[data-slot="modal-backdrop"]');
  const transcript = dialog ? visible('[data-slot="assistant-transcript"], [aria-label="Conversation messages"]', dialog) : undefined;
  const toolbar = visible('[aria-label="Message formatting"]');
  const filter = visible('[data-slot="filter-group"]');
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Activity"] [data-slot="card-content"]')).filter(row => row.querySelector('[data-slot="chip"]') && row.querySelector('button'));
  const surface = (selector: string) => { const element = visible(selector); return element ? getComputedStyle(element).backgroundColor : null; };
  return {
    viewport: { width: innerWidth, height: innerHeight }, document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    rail: { rect: box(rail), padding: rail ? parseFloat(getComputedStyle(rail).paddingLeft) : null }, compose: box(compose),
    inbox: { list: box(visible('[aria-label="Inbox"]')), reader: box(visible('[aria-label="Message detail"]')) },
    mobile: { nav: box(navigation), targets: navigation ? Array.from(navigation.querySelectorAll('button')).map(button => box(button)) : [], labels: navigation ? Array.from(navigation.querySelectorAll('button')).map(button => button.textContent.trim()) : [] },
    assistant: { fab: box(visible('button[aria-label="Open Assistant"]')), dialog: box(dialog), close: box(visible('button[aria-label="Minimize Assistant"]')), composer: box(visible('#chat-message')), transcript: box(transcript), transcriptClientHeight: transcript?.clientHeight, transcriptScrollHeight: transcript?.scrollHeight, backdrop: box(backdrop), blur: backdrop ? getComputedStyle(backdrop).backdropFilter : null, dim: backdrop ? getComputedStyle(backdrop).backgroundColor : null, animations: dialog?.getAnimations().filter(animation => animation.playState === 'running').length ?? 0 },
    menu: box(visible('[role="menu"]')), utilities: box(visible('[aria-label="Application utilities"]')),
    composeEditor: { client: toolbar?.clientWidth, scroll: toolbar?.scrollWidth, toolbar: box(toolbar), bold: box(toolbar ? visible('button[aria-label="Bold"]', toolbar) : undefined) },
    activity: { filterClientWidth: filter?.clientWidth, filterScrollWidth: filter?.scrollWidth, rows: rows.map(row => ({ container: box(row), children: Array.from(row.children).map(child => box(child)) })) },
    surfaces: { page: getComputedStyle(document.body).backgroundColor, input: surface('[data-slot="input"]'), richEditor: surface('[data-slot="rich-text-editor"]'), select: surface('[data-slot="select-trigger"]') },
  };
}
Object.assign(window, { layoutMetrics: metrics, completePendingReply });
setTimeout(() => {
  if (mode === 'owner-menu' || mode === 'assistant') {
    const trigger = visible(`button[aria-label="${mode === 'owner-menu' ? 'Account and settings' : 'Open Assistant'}"]`);
    if (!trigger) throw new Error('Missing real overlay fixture trigger');
    trigger.click();
  }
  const output = document.getElementById('layout-result');
  if (!output) throw new Error('Missing layout metric output');
  output.textContent = JSON.stringify(metrics()); output.dataset.ready = 'true';
}, 100);
