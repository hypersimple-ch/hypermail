import * as React from 'react';
import { AgentPanel, type AgentUiHandlers } from '../agent/ui.js';
import type { AgentDashboard } from '../agent/contracts.js';

export type MailState = 'loading' | 'ready' | 'empty' | 'error';
export type ActivityState = 'new' | 'question' | 'failed' | 'complete';
export type Screen = 'inbox' | 'activity' | 'drafts' | 'sent' | 'more' | 'message' | 'compose';

export interface Account { id: string; label: string; address: string; unread: number; color: 'blue' | 'green' | 'amber' | 'gray'; }
export interface Attachment { id: string; name: string; size: string; safe: boolean; }
export interface Draft { id: string; accountId: string; recipients: readonly { kind: string; address: string }[]; subject: string; body: string; state: string; updatedAt: string; }
export interface Message { id: string; accountId: string; sender: string; initials: string; subject: string; preview: string; received: string; unread?: boolean; body: string; attachments?: readonly Attachment[]; }
export interface ActivityItem { id: string; expectedVersion?: number; state: ActivityState; title: string; context: string; time: string; action: string; }
export interface ShellData { accounts: readonly Account[]; messages: readonly Message[]; activity: readonly ActivityItem[]; }

const h = React.createElement;
const cx = (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ');

function IconButton({ label, children, onClick }: { label: string; children?: React.ReactNode; onClick?: () => void }) {
  return h('button', { className: 'hm-icon-button', type: 'button', 'aria-label': label, onClick }, children);
}

function AccountMark({ message, color = 'green' }: { message: Message; color?: Account['color'] }) {
  return h('span', { className: `hm-avatar hm-${color}`, 'aria-hidden': 'true' }, message.initials);
}

export function MessageRow({ message, selected, onOpen }: { message: Message; selected?: boolean; onOpen?: () => void }) {
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [startX, setStartX] = React.useState<number | null>(null);
  const [notice, setNotice] = React.useState('');
  const complete = (action: string) => { setNotice(`${action} for ${message.sender}. Undo available.`); setActionsOpen(false); };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (startX === null) return;
    const delta = event.clientX - startX;
    if (Math.abs(delta) >= 72) complete(delta < 0 ? 'Archived' : 'Marked unread');
    setStartX(null);
  };
  return h('article', {
    className: cx('hm-message-row', message.unread && 'is-unread', selected && 'is-selected'),
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => { setStartX(event.clientX); }, onPointerUp,
  },
  h('button', { className: 'hm-row-open', type: 'button', onClick: onOpen, 'aria-label': `Open message from ${message.sender}: ${message.subject}` },
    h(AccountMark, { message }),
    h('span', { className: 'hm-message-copy' }, h('strong', null, message.sender), h('span', null, message.subject), h('small', null, message.preview)),
    h('time', null, message.received)),
  h(IconButton, { label: `Message actions for ${message.sender}`, onClick: () => { setActionsOpen(!actionsOpen); } }, '⋯'),
  actionsOpen && h('div', { className: 'hm-row-actions', role: 'menu', 'aria-label': 'Message actions' },
    h('button', { type: 'button', role: 'menuitem', onClick: () => { complete('Archived'); } }, 'Archive'),
    h('button', { type: 'button', role: 'menuitem', onClick: () => { complete('Marked unread'); } }, 'Mark unread')),
  h('p', { className: 'hm-sr-only', 'aria-live': 'polite' }, notice));
}

function Filters({ labels, selected = 0 }: { labels: readonly string[]; selected?: number }) {
  return h('div', { className: 'hm-filters', 'aria-label': 'Filters' }, labels.map((label, index) => h('button', { className: cx('hm-chip', index === selected && 'is-active'), type: 'button', key: label, 'aria-pressed': index === selected }, label)));
}

export function Inbox({ data, state = 'ready', selectedId, onOpen }: { data: ShellData; state?: MailState; selectedId?: string | undefined; onOpen?: ((message: Message) => void) | undefined }) {
  const unread = data.accounts.reduce((sum, account) => sum + account.unread, 0);
  return h('section', { className: 'hm-list-pane', 'aria-label': 'Inbox' },
    h('header', { className: 'hm-list-header' }, h('div', null, h('h1', null, 'All Accounts'), h('p', null, `${String(unread)} unread`)), h(IconButton, { label: 'Search mail' }, '⌕')),
    h('div', { className: 'hm-search' }, h('label', null, 'Search', h('input', { type: 'search', placeholder: 'Search mail', 'aria-label': 'Search mail' }))),
    h(Filters, { labels: ['All mail', 'Unread', 'Starred'] }),
    state === 'loading' ? h('p', { className: 'hm-state', role: 'status' }, 'Loading inbox…') :
    state === 'error' ? h('div', { className: 'hm-state hm-error', role: 'alert' }, 'Could not load mail. ', h('button', { type: 'button' }, 'Try again')) :
    state === 'empty' ? h('p', { className: 'hm-state' }, 'No mail here yet.') :
    h(React.Fragment, null, h('h2', { className: 'hm-section-label' }, 'Today'), data.messages.map((message) => h(MessageRow, { key: message.id, message, selected: selectedId === message.id, onOpen: () => onOpen?.(message) }))));
}

export function Activity({ data, state = 'ready', onAction, agentPanel }: { data: ShellData; state?: MailState; onAction?: ((item: ActivityItem) => void) | undefined; agentPanel?: React.ReactNode | undefined }) {
  const labels = ['New', 'Questions', 'Failed', 'History'];
  const statusText: Record<ActivityState, string> = { new: 'New', question: 'Needs input', failed: 'Failed', complete: 'Completed' };
  return h('section', { className: 'hm-activity-pane', 'aria-label': 'Activity' }, h('header', { className: 'hm-list-header' }, h('div', null, h('h1', null, 'Activity'), h('p', null, 'Agent work and exceptions'))), h(Filters, { labels }),
    state === 'loading' ? h('p', { className: 'hm-state', role: 'status' }, 'Loading activity…') :
    state === 'error' ? h('div', { className: 'hm-state hm-error', role: 'alert' }, 'Could not load activity. ', h('button', { type: 'button' }, 'Try again')) :
    state === 'empty' ? h('p', { className: 'hm-state' }, 'Nothing needs attention.') :
    h(React.Fragment, null, data.activity.map((item) => h('article', { className: 'hm-event', key: item.id }, h('span', { className: `hm-status hm-status-${item.state}` }, statusText[item.state]), h('div', null, h('strong', null, item.title), h('p', null, `${item.context} · ${item.time}`)), h('button', { type: 'button', onClick: () => onAction?.(item), disabled: item.action !== 'Retry' && item.action !== 'Acknowledge' }, item.action))), agentPanel));
}

export function Reader({ message, onBack, onAttachment }: { message: Message; onBack?: () => void; onAttachment?: (attachment: Attachment) => void }) {
  return h('article', { className: 'hm-reader', 'aria-label': 'Message detail' },
    h('header', { className: 'hm-reader-toolbar' }, h('button', { className: 'hm-back', type: 'button', onClick: onBack }, '‹ Inbox'), h('div', null, h('button', { type: 'button' }, 'Archive'), h('button', { type: 'button' }, 'Reply'), h('button', { type: 'button', 'aria-label': 'More message actions' }, '⋯'))),
    h('h1', null, message.subject), h('p', { className: 'hm-from' }, h(AccountMark, { message }), h('strong', null, message.sender), h('small', null, 'to me · Today, 7:58 AM')), h('p', { className: 'hm-body' }, message.body),
    message.attachments?.map((attachment) => h('button', { className: 'hm-attachment', type: 'button', key: attachment.id, onClick: () => { onAttachment?.(attachment); }, 'aria-label': `Open attachment ${attachment.name}; ${attachment.safe ? 'checked safe' : 'check before opening'}` }, '⌁ ', attachment.name, ' · ', attachment.size, h('small', null, attachment.safe ? 'Checked safe' : 'Review before opening'))),
    h(AgentCard, null));
}

export function AgentCard() {
  const [details, setDetails] = React.useState(false);
  const sheetRef = React.useRef<{ focus?: () => void } | null>(null);
  React.useEffect(() => {
    if (!details) return undefined;
    sheetRef.current?.focus?.();
    const browserDocument = (globalThis as { document?: { addEventListener: (type: string, listener: (event: { key?: string }) => void) => void; removeEventListener: (type: string, listener: (event: { key?: string }) => void) => void } }).document;
    if (!browserDocument) return undefined;
    const closeOnEscape = (event: { key?: string }) => { if (event.key === 'Escape') setDetails(false); };
    browserDocument.addEventListener('keydown', closeOnEscape);
    return () => { browserDocument.removeEventListener('keydown', closeOnEscape); };
  }, [details]);
  const closeOnEscape = (event: React.KeyboardEvent) => { if (event.key === 'Escape') setDetails(false); };
  return h(React.Fragment, null, h('aside', { className: 'hm-agent-card', 'aria-label': 'Hypermail reply suggestion' }, h('div', null, h('strong', null, '✦ Hypermail suggests a reply'), h(IconButton, { label: 'Suggestion options' }, '⋯')), h('p', null, '“Yes, 3pm works for me. See you then!”'), h('footer', null, h('button', { className: 'hm-secondary', type: 'button' }, 'Edit'), h('button', { className: 'hm-primary', type: 'button' }, 'Review reply'), h('button', { className: 'hm-text-action', type: 'button', onClick: () => { setDetails(true); } }, 'Agent details'))),
    details && h('div', { className: 'hm-sheet-backdrop', role: 'presentation', onClick: () => { setDetails(false); } }, h('section', { className: 'hm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hm-agent-title', tabIndex: -1, ref: (node: unknown) => { sheetRef.current = node as { focus?: () => void } | null; }, onKeyDown: closeOnEscape, onClick: (event: React.MouseEvent) => { event.stopPropagation(); } }, h('button', { className: 'hm-sheet-close', type: 'button', onClick: () => { setDetails(false); }, 'aria-label': 'Close agent details' }, 'Close'), h('h2', { id: 'hm-agent-title' }, 'Agent details'), h('p', null, 'This suggestion moves the call to 3pm. Review or edit it before any message is sent.'))));
}

const formText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export function Compose({ accounts, draft, onClose, onSave }: { accounts: readonly Account[]; draft?: Draft | undefined; onClose?: (() => void) | undefined; onSave?: ((draft: { id?: string; accountId: string; recipient: string; subject: string; body: string }) => Promise<void>) | undefined }) {
  const [pending, setPending] = React.useState(false); const [error, setError] = React.useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const accountId = formText(form, 'accountId'); if (!onSave || !accountId) return; setPending(true); setError(''); void onSave({ ...(draft ? { id: draft.id } : {}), accountId, recipient: formText(form, 'to'), subject: formText(form, 'subject'), body: formText(form, 'body') }).then(() => { onClose?.(); }).catch(() => { setError('Could not save draft. Try again.'); }).finally(() => { setPending(false); }); };
  return h('section', { className: 'hm-compose', 'aria-label': 'Compose message' }, h('form', { onSubmit: submit }, h('header', null, h('button', { type: 'button', onClick: onClose, 'aria-label': 'Close compose' }, '×'), h('h1', null, 'New message'), h('button', { className: 'hm-text-action', type: 'button', disabled: true, title: 'Sending is unavailable until an approved delivery endpoint is configured.' }, 'Send disabled')),
    h('label', null, 'From account', h('select', { name: 'accountId', required: true, defaultValue: draft?.accountId }, accounts.map((account) => h('option', { key: account.id, value: account.id }, account.label)))), h('label', null, 'To', h('input', { name: 'to', type: 'email', placeholder: 'name@example.com', required: true, defaultValue: draft?.recipients.find((recipient) => recipient.kind === 'to')?.address ?? '' })), h('label', null, 'Subject', h('input', { name: 'subject', type: 'text', defaultValue: draft?.subject ?? '' })), h('label', { className: 'hm-editor-label' }, 'Message', h('textarea', { name: 'body', defaultValue: draft?.body ?? '' })), error && h('p', { role: 'alert' }, error), h('footer', null, h(IconButton, { label: 'Add attachment' }, '＋'), h(IconButton, { label: 'Use agent assistance' }, '✦'), h('button', { type: 'submit', disabled: pending }, pending ? 'Saving…' : 'Save draft'))));
}

export function Drafts({ drafts, onOpen }: { drafts: readonly Draft[]; onOpen?: (draft: Draft) => void }) {
  return h('section', { className: 'hm-list-pane', 'aria-label': 'Drafts' }, h('header', { className: 'hm-list-header' }, h('h1', null, 'Drafts')), drafts.length ? drafts.map((draft) => h('article', { className: 'hm-event', key: draft.id }, h('div', null, h('strong', null, draft.subject || '(no subject)'), h('p', null, `${draft.recipients.map((item) => item.address).join(', ') || 'No recipient'} · ${draft.state}`)), h('button', { type: 'button', onClick: () => onOpen?.(draft), 'aria-label': `Edit draft ${draft.subject || '(no subject)'}` }, 'Edit'))) : h('p', { className: 'hm-state' }, 'No drafts yet.'));
}
export function More() { return h('section', { className: 'hm-list-pane', 'aria-label': 'More' }, h('header', { className: 'hm-list-header' }, h('h1', null, 'More')), h('p', null, 'Settings and account options are coming soon.')); }

function Rail({ screen, onScreen }: { screen: Screen; onScreen: (screen: Screen) => void }) {
  const destinations: Array<[Screen, string]> = [['inbox', 'Inbox'], ['activity', 'Activity'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['more', 'More']];
  return h('aside', { className: 'hm-rail', 'aria-label': 'Mailbox navigation' }, h('strong', { className: 'hm-brand' }, 'hypermail'), h('button', { className: 'hm-compose-button', type: 'button', onClick: () => { onScreen('compose'); } }, '＋ Compose'), h('nav', { 'aria-label': 'Primary' }, destinations.map(([id, label]) => h('button', { type: 'button', className: screen === id ? 'is-selected' : undefined, 'aria-current': screen === id ? 'page' : undefined, onClick: () => { onScreen(id); }, key: id }, label, id === 'activity' && h('span', null, '3')))), h('nav', { className: 'hm-folders', 'aria-label': 'Folders' }, h('strong', null, 'Folders'), h('button', { type: 'button' }, 'Receipts'), h('button', { type: 'button' }, 'Travel')), h('p', { className: 'hm-online' }, 'Personal · Work', h('small', null, 'Online')));
}

export function HypermailShell({ data, initialState = 'ready', drafts = [], dashboard, agentHandlers, onActivityAction, onOpenMessage, onSaveDraft }: { data: ShellData; initialState?: MailState; drafts?: readonly Draft[]; dashboard?: AgentDashboard | undefined; agentHandlers?: AgentUiHandlers | undefined; onActivityAction?: ((item: ActivityItem) => void) | undefined; onOpenMessage?: ((message: Message) => Promise<Message>) | undefined; onSaveDraft?: ((draft: { id?: string; accountId: string; recipient: string; subject: string; body: string }) => Promise<void>) | undefined }) {
  const [screen, setScreen] = React.useState<Screen>('inbox'); const [selected, setSelected] = React.useState(data.messages[0]); const [editingDraft, setEditingDraft] = React.useState<Draft | undefined>(); const [idempotencyKey] = React.useState(() => globalThis.crypto.randomUUID());
  const openMessage = (message: Message) => { setSelected(message); setScreen('message'); if (onOpenMessage) void onOpenMessage(message).then(setSelected).catch(() => {}); };
  const reader = selected ? h(Reader, { message: selected, onBack: () => { setScreen('inbox'); }, onAttachment: (attachment: Attachment) => { void fetch(`/api/v1/accounts/${encodeURIComponent(selected.accountId)}/messages/${encodeURIComponent(selected.id)}/attachments/${encodeURIComponent(attachment.id)}`, { headers: { 'x-api-version': 'v1' } }).then((response) => response.ok ? response.blob() : Promise.reject(new Error('Attachment unavailable'))).then((blob) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = attachment.name; anchor.click(); URL.revokeObjectURL(url); }).catch(() => {}); } }) : null;
  const activityPanel = dashboard ? h(AgentPanel, { dashboard, idempotencyKey, ...(agentHandlers ? { handlers: agentHandlers } : {}) }) : undefined;
  const mobileContent = screen === 'activity' ? h(Activity, { data, state: initialState, ...(onActivityAction ? { onAction: onActivityAction } : {}), ...(activityPanel ? { agentPanel: activityPanel } : {}) }) : screen === 'drafts' || screen === 'sent' ? h(Drafts, { drafts, onOpen: (draft) => { setEditingDraft(draft); setScreen('compose'); } }) : screen === 'more' ? h(More) : screen === 'compose' ? h(Compose, { accounts: data.accounts, ...(editingDraft ? { draft: editingDraft } : {}), onClose: () => { setEditingDraft(undefined); setScreen('drafts'); }, ...(onSaveDraft ? { onSave: onSaveDraft } : {}) }) : screen === 'message' ? reader : h(Inbox, { data, state: initialState, selectedId: selected?.id, onOpen: openMessage });
  return h('main', { className: 'hm-shell' }, h(Rail, { screen, onScreen: setScreen }), h('div', { className: 'hm-mobile-content' }, mobileContent), h('section', { className: 'hm-desktop-content', 'aria-label': 'Desktop mailbox' }, screen === 'inbox' ? h(Inbox, { data, state: initialState, selectedId: selected?.id, onOpen: openMessage }) : mobileContent, screen === 'inbox' && reader), h('nav', { className: 'hm-bottom-nav', 'aria-label': 'Mobile primary' }, [['inbox', 'Inbox'], ['activity', 'Activity'], ['drafts', 'Drafts'], ['more', 'More']].map(([id, label]) => h('button', { type: 'button', key: id, className: screen === id ? 'is-selected' : undefined, 'aria-current': screen === id ? 'page' : undefined, onClick: () => { setScreen(id as Screen); } }, label, id === 'activity' && h('span', null, '3')))), h('button', { className: 'hm-fab', type: 'button', 'aria-label': 'Compose', onClick: () => { setScreen('compose'); } }, '＋'));
}
