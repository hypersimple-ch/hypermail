import * as React from 'react';
import { Activity, ArrowLeft, ClipboardCheck, FilePenLine, Mail, MessageCircle, Paperclip, Plus, Send, X } from 'lucide-react';
import { AgentPanel, type AgentUiHandlers } from '../agent/ui.js';
import { Account as AccountScreen, type ChangePasswordInput, type ChangePasswordResult } from './account.js';
import { Settings, type CompleteMailboxConnectionInput, type MailboxConnectionResult, type PendingMailboxConnection, type SettingsMailbox, type StartMailboxConnectionInput } from './settings.js';
import type { ManagerSettingsView } from '../agent-connections/contracts.js';
import type { ManagerMutations } from '../mailbox-managers/index.js';
import { ActivityDetail as CanonicalActivityDetail, ActivityScreen as CanonicalActivityScreen } from '../activity/surfaces.js';
import type { ActivityFilter, ActivityPage, ActivityRecord } from '../activity/contracts.js';
import { PendingSendReview } from '../send-requests/surfaces.js';
import type { OwnerSendRequest } from '../send-requests/contracts.js';
import type { AgentDashboard } from '../agent/contracts.js';
import { Alert, AlertDescription } from '@/components/heroui/alert.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent } from '@/components/heroui/card.js';
import { Field, FieldLabel } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Select } from '@/components/heroui/select.js';
import { toast } from '@/components/heroui/toast.js';
import { RichTextEditor, type DraftBodyFormat } from '@/components/app/rich-text-editor.js';
import { AppPage, NavigationItem, PageContainer, PageHeader, StatePanel } from '@/components/app/patterns.js';
import { cn } from '@/lib/utils.js';
import { ChatSurface } from '@/conversations/ui.js';
import { OwnerMenu } from '@/components/app/owner-menu.js';
import { DraftCompose } from '../drafts/surfaces.js';
import type { DraftRecord, DraftRevision } from '../drafts/contracts.js';
import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';

export type MailState = 'loading' | 'ready' | 'empty' | 'error';
export type ResourceState = 'loading' | 'ready' | 'error';
export type { ActivityFilter } from '../activity/contracts.js';
export type Screen = 'inbox' | 'activity' | 'drafts' | 'sent' | 'settings' | 'account' | 'message' | 'compose' | 'activity-detail' | 'pending-sends';
export interface Account { id: string; label: string; address: string; unread?: number; }
export interface Attachment { id: string; name: string; size: string; safe?: boolean; }
export type DraftSaveInput = { accountId: string; recipient: string; subject: string; body: string; bodyFormat: DraftBodyFormat };
export interface Message { id: string; accountId: string; sender: string; senderAddress?: string; initials: string; subject: string; preview: string; received: string; receivedAt?: string; unread?: boolean; body?: string | undefined; attachments?: readonly Attachment[]; }
export interface ShellData { accounts: readonly Account[]; messages: readonly Message[]; activity: ActivityPage; activityState?: ResourceState; activityError?: string; activityLoadingMore?: boolean; selectedAccountId?: string; inboxState?: MailState; inboxNextCursor?: string | null; inboxLoadingMore?: boolean; inboxError?: string; }

const formText = (form: FormData, name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
const paneClass = 'min-w-0 bg-card';

function AccountMark({ message }: { message: Message }) {
  return <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-bold text-muted-foreground" aria-hidden="true">{message.initials}</span>;
}

function ErrorState({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <Alert variant="destructive" className="m-4 w-auto"><AlertDescription>{children}</AlertDescription>{action}</Alert>;
}

function ResourceContent({ state = 'ready', error, loadingTitle, errorMessage, hasRows, onRetry, children }: { state?: ResourceState; error?: string | undefined; loadingTitle: string; errorMessage: string; hasRows: boolean; onRetry?: (() => void) | undefined; children: React.ReactNode }) {
  const failed = state === 'error' || Boolean(error);
  return <>
    {failed ? <ErrorState action={onRetry ? <Button type="button" variant="outline" size="sm" disabled={state === 'loading'} onClick={onRetry}>Try again</Button> : undefined}>{error || errorMessage}</ErrorState> : null}
    {state === 'loading' ? <StatePanel className="m-4 w-auto" title={loadingTitle} loading /> : null}
    {hasRows || (state === 'ready' && !failed) ? children : null}
  </>;
}

export function MessageRow({ message, selected, onOpen }: { message: Message; selected?: boolean; onOpen?: () => void }) {
  return <article className={cn('min-w-0 border-b border-border', selected && 'border-l-4 border-l-primary bg-secondary/50', message.unread && 'font-semibold')}>
    <Button variant="ghost" className="grid h-auto min-h-[79px] w-full min-w-0 grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-start gap-2 rounded-none px-3 py-3 text-left font-normal" type="button" onClick={onOpen} aria-label={`Open message from ${message.sender}: ${message.subject}`}>
      <AccountMark message={message} />
      <span className="min-w-0"><strong className="block truncate">{message.sender}</strong><span className="block truncate font-medium">{message.subject}</span><small className="mt-0.5 block truncate text-sm font-normal text-muted-foreground">{message.preview}</small></span>
      <time className="text-right text-xs font-normal text-muted-foreground">{message.received}</time>
    </Button>
  </article>;
}

export function Inbox({ data, state = 'ready', selectedId, onOpen, onRetry, onAccountChange, onLoadMore }: { data: ShellData; state?: MailState; selectedId?: string | undefined; onOpen?: ((message: Message) => void) | undefined; onRetry?: (() => void) | undefined; onAccountChange?: ((id: string) => void) | undefined; onLoadMore?: (() => void) | undefined }) {
  const mailbox = data.accounts.find(account => account.id === data.selectedAccountId);
  const groups: { label: string; messages: Message[] }[] = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  for (const message of data.messages) {
    const date = message.receivedAt ? new Date(message.receivedAt) : undefined;
    const label = !date || !Number.isFinite(date.getTime()) ? 'Messages' : date >= today ? 'Today' : date >= yesterday ? 'Yesterday' : date.toLocaleDateString();
    let group = groups.at(-1);
    if (group?.label !== label) { group = { label, messages: [] }; groups.push(group); }
    group.messages.push(message);
  }
  const inboxState = data.inboxState ?? state;
  return <section className={paneClass} aria-label="Inbox">
    <div className="space-y-3 border-b border-border px-4 py-4">
      <PageHeader title={mailbox?.label ?? 'Inbox'} {...(mailbox?.unread !== undefined ? { description: `${String(mailbox.unread)} unread` } : {})} />
      {data.accounts.length ? <Select label="Mailbox" aria-label="Mailbox" value={data.selectedAccountId} options={data.accounts.map(account => ({ value: account.id, label: account.label }))} placeholder="Select a mailbox" disabled={!onAccountChange} onValueChange={value => { onAccountChange?.(value); }} /> : null}
      {onRetry && mailbox ? <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={inboxState === 'loading'}>Refresh</Button> : null}
    </div>
    {data.inboxError || inboxState === 'error' ? <ErrorState action={<Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>}>{data.inboxError ?? 'Could not load mail.'}</ErrorState> : null}
    {inboxState === 'loading' ? <StatePanel className="m-4 w-auto" title="Loading inbox…" loading /> : !data.messages.length ? <StatePanel className="m-4 w-auto" title={mailbox ? 'No mail here yet.' : 'Select or connect a mailbox.'} /> : groups.map(group => <React.Fragment key={group.label}><h2 className="px-4 pt-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">{group.label}</h2>{group.messages.map(message => <MessageRow key={message.id} message={message} selected={selectedId === message.id} onOpen={() => onOpen?.(message)} />)}</React.Fragment>)}
    {data.inboxNextCursor ? <Button className="m-4" type="button" variant="outline" onClick={onLoadMore} disabled={data.inboxLoadingMore || !onLoadMore}>{data.inboxLoadingMore ? 'Loading…' : 'Load more'}</Button> : data.messages.length && inboxState === 'ready' && !data.inboxError ? <p className="p-4 text-sm text-muted-foreground">End of mailbox.</p> : null}
  </section>;
}

export function Reader({ message, onBack, onAttachment, onOpenActivity, onDiscuss, onReply, onRetry, contextualActivity = [], error }: { message: Message; onBack?: () => void; onAttachment?: (attachment: Attachment) => Promise<void> | void; onOpenActivity?: (activity: ActivityRecord) => void; onDiscuss?: ((message: Message) => void) | undefined; onReply?: ((message: Message) => void) | undefined; onRetry?: (() => void) | undefined; contextualActivity?: readonly ActivityRecord[]; error?: string }) {
  return <article className="min-w-0 bg-card px-4 pb-24 sm:px-8" aria-label="Message detail"><header className="flex min-h-17 items-center border-b border-border"><Button variant="ghost" size="sm" type="button" onClick={onBack}><ArrowLeft aria-hidden="true" />Inbox</Button></header>
    <div className="mt-4 flex gap-2">{onDiscuss ? <Button type="button" variant="outline" disabled={message.body === undefined} onClick={() => { onDiscuss(message); }}>Discuss this mail</Button> : null}{onReply && message.senderAddress ? <Button type="button" variant="outline" disabled={message.body === undefined} onClick={() => { onReply(message); }}>Reply</Button> : null}</div>
    {error ? <ErrorState action={onRetry ? <Button type="button" variant="outline" onClick={onRetry}>Retry message</Button> : undefined}>{error}</ErrorState> : null}
    <div className="mx-auto max-w-3xl py-6"><h1 className="text-2xl font-semibold tracking-tight">{message.subject}</h1><div className="mt-5 grid grid-cols-[2.25rem_1fr] items-center gap-3"><AccountMark message={message} /><p><strong className="block">{message.sender}</strong><small className="text-muted-foreground">to me</small></p></div>
      {message.body === undefined ? !error ? <StatePanel className="my-7" title="Loading full message…" loading /> : null : <p className="my-7 leading-7 whitespace-pre-wrap">{message.body}</p>}
      {contextualActivity.length ? <Card className="my-4"><CardContent><strong>Activity for this message</strong><div className="mt-2 flex flex-wrap gap-2">{contextualActivity.map(activity => <Button key={activity.id} type="button" variant="outline" size="sm" onClick={() => { onOpenActivity?.(activity); }}>{activity.title}</Button>)}</div></CardContent></Card> : null}
      <div className="space-y-2">{message.attachments?.map(attachment => <Button key={attachment.id} type="button" variant="outline" className="h-auto w-full max-w-md justify-start py-3 text-left" onClick={() => { void onAttachment?.(attachment); }} aria-label={`Download attachment ${attachment.name}`}><Paperclip aria-hidden="true" /><span className="min-w-0"><span className="block truncate">{attachment.name} · {attachment.size}</span><small className="block font-normal text-muted-foreground">Download attachment</small></span></Button>)}</div>
    </div>
  </article>;
}

export function Compose({ accounts, onClose, onSave }: { accounts: readonly Account[]; onClose?: (() => void) | undefined; onSave?: ((draft: DraftSaveInput) => Promise<DraftRecord>) | undefined }) {
  const [pending, setPending] = React.useState(false);
  const submit = (event: React.SubmitEvent<HTMLFormElement>) => { event.preventDefault(); if (pending) return; const form = new FormData(event.currentTarget); const accountId = formText(form, 'accountId'); if (!onSave || !accountId) return; setPending(true); void onSave({ accountId, recipient: formText(form, 'to'), subject: formText(form, 'subject'), body: formText(form, 'body'), bodyFormat: formText(form, 'bodyFormat') === 'html' ? 'html' : 'markdown' }).then(() => { toast.success('Draft saved.'); }).catch((error: unknown) => { if (!(error instanceof SessionExpiredError)) toast.danger('Could not save draft. Your input has been kept.'); }).finally(() => { setPending(false); }); };
  return <AppPage aria-label="Compose message"><PageContainer measure="reading"><form onSubmit={submit} className="space-y-4"><PageHeader title="New message" actions={<Button variant="ghost" size="icon" type="button" onClick={onClose} aria-label="Close compose"><X aria-hidden="true" /></Button>} />
    <Field><Select id="compose-account" name="accountId" label="From account" required placeholder="Select an account" options={accounts.map(account => ({ value: account.id, label: account.label }))} /></Field>
    <Field><FieldLabel htmlFor="compose-to">To</FieldLabel><Input id="compose-to" name="to" type="email" placeholder="name@example.com" required /></Field>
    <Field><FieldLabel htmlFor="compose-subject">Subject</FieldLabel><Input id="compose-subject" name="subject" type="text" /></Field>
    <Field><FieldLabel id="compose-body-label" htmlFor="compose-body">Message</FieldLabel><RichTextEditor id="compose-body" name="body" defaultValue="" defaultFormat="markdown" ariaLabelledBy="compose-body-label" disabled={pending} /></Field>
    <div className="flex justify-end border-t border-border pt-4"><Button type="submit" disabled={pending || !onSave}>{pending ? 'Saving…' : 'Save draft'}</Button></div>
  </form></PageContainer></AppPage>;
}

export function Drafts({ drafts, onOpen }: { drafts: readonly DraftRecord[]; onOpen?: (draft: DraftRecord) => void }) { const editable = drafts.filter(draft => ['editing', 'ready', 'failed', 'sending'].includes(draft.state)); return <AppPage aria-label="Drafts"><PageHeader title="Drafts" className="mb-5" />{editable.length ? <div className="space-y-3">{editable.map(draft => <Card key={draft.id} className="gap-0 py-0"><CardContent className="flex items-center justify-between gap-4 px-4 py-4"><div className="min-w-0"><strong className="block truncate">{draft.subject || '(no subject)'}</strong><p className="mt-1 truncate text-sm text-muted-foreground">{draft.recipients.map(item => item.address).join(', ') || 'No recipient'} · {draft.state}</p></div><Button type="button" variant="outline" size="sm" onClick={() => onOpen?.(draft)} aria-label={`Open draft ${draft.subject || '(no subject)'}`}>Open</Button></CardContent></Card>)}</div> : <StatePanel title="No drafts yet." />}</AppPage>; }
export function Sent({ drafts }: { drafts: readonly DraftRecord[] }) { const sent = drafts.filter(draft => draft.state === 'sent'); return <AppPage aria-label="Sent"><PageHeader title="Sent" className="mb-5" />{sent.length ? <div className="space-y-3">{sent.map(draft => <Card key={draft.id} className="gap-0 py-0"><CardContent className="px-4 py-4"><strong>{draft.subject || '(no subject)'}</strong><p className="mt-1 text-sm text-muted-foreground">To {draft.recipients.map(item => item.address).join(', ') || 'no recipient'} · Sent</p></CardContent></Card>)}</div> : <StatePanel title="No sent messages." />}</AppPage>; }


type PrimaryDestination = Extract<Screen, 'inbox' | 'drafts' | 'sent' | 'pending-sends' | 'activity'>;
const destinations: Array<{ id: PrimaryDestination; label: string; icon: typeof Mail }> = [{ id: 'inbox', label: 'Inbox', icon: Mail }, { id: 'drafts', label: 'Drafts', icon: FilePenLine }, { id: 'sent', label: 'Sent', icon: Send }, { id: 'pending-sends', label: 'Approvals', icon: ClipboardCheck }, { id: 'activity', label: 'Activity', icon: Activity }];
const screenDestinations: Record<Screen, PrimaryDestination | undefined> = { inbox: 'inbox', message: 'inbox', activity: 'activity', 'activity-detail': 'activity', drafts: 'drafts', sent: 'sent', settings: undefined, account: undefined, 'pending-sends': 'pending-sends', compose: undefined };
export const destinationForScreen = (screen: Screen): PrimaryDestination | undefined => screenDestinations[screen];
const destinationActive = (screen: Screen, destination: PrimaryDestination): boolean => destinationForScreen(screen) === destination;
function Rail({ screen, ownerEmail, online, onScreen, onSignOut, approvalCount = 0 }: { screen: Screen; ownerEmail: string; online: boolean; onScreen: (screen: Screen) => void; onSignOut?: (() => Promise<void>) | undefined; approvalCount?: number }) {
  return <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-border bg-background p-4 [@media(min-width:700px)]:flex" aria-label="Mailbox navigation">
    <strong className="px-2 text-xl tracking-tight">hypermail</strong>
    <Button className="h-11 w-full max-w-none rounded-lg" type="button" onClick={() => { onScreen('compose'); }}><Plus aria-hidden="true" />Compose</Button>
    <nav className="grid gap-1" aria-label="Primary">{destinations.map(({ id, label, icon }) => <NavigationItem key={id} active={destinationActive(screen, id)} icon={icon} className={cn('min-h-11 gap-2 text-left [&_svg]:size-5', id === 'pending-sends' && 'mt-3 border-t border-border pt-3')} onClick={() => { onScreen(id); }}>{label}{id === 'pending-sends' && approvalCount > 0 ? <ApprovalBadge count={approvalCount} /> : null}</NavigationItem>)}</nav>
    <footer className="mt-auto min-w-0 border-t border-border pt-4"><OwnerMenu ownerEmail={ownerEmail} online={online} onNavigate={onScreen} {...(onSignOut ? { onSignOut } : {})} /></footer>
  </aside>;
}
function ApprovalBadge({ count }: { count: number }) { return <span aria-label={`${String(count)} pending approvals`} className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">{count > 99 ? '99+' : count}</span>; }
const isChatPath = (): boolean => typeof location !== 'undefined' && /^\/chat(?:\/|$)/.test(location.pathname);
function conversationFromPath(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const id = /^\/chat\/(.+)$/.exec(location.pathname)?.[1];
  if (!id) return undefined;
  try { return decodeURIComponent(id); } catch { return id; }
}

export function HypermailShell({ data, initialState = 'ready', initialScreen = 'inbox', drafts = [], draftHistories, dashboard, agentError, agentHandlers, proposalFolders = [], ownerEmail = '', online = typeof navigator === 'undefined' || navigator.onLine, settingsMailboxes = [], pendingMailboxConnection, settingsNotice, managerSettings, managerMutations, sendRequests = [], sendingState = 'ready', sendingError, onRetrySending, onRefreshSendRequests, onActivityFilter, onActivityLoadMore, onInboxRetry, onAccountChange, onLoadMore, onOpenMessage, onSaveDraft, onUpdateDraft, onRefreshDraft, onReply, onStartMailboxConnection, onCompleteMailboxConnection, onChangePassword, onSignOut }: {
  data: ShellData; initialState?: MailState; initialScreen?: Screen; drafts?: readonly DraftRecord[]; dashboard?: AgentDashboard | undefined; agentError?: string | undefined; agentHandlers?: AgentUiHandlers | undefined; proposalFolders?: React.ComponentProps<typeof AgentPanel>['proposalFolders']; ownerEmail?: string; online?: boolean; settingsMailboxes?: readonly SettingsMailbox[]; pendingMailboxConnection?: PendingMailboxConnection | undefined; settingsNotice?: string | undefined; managerSettings?: ManagerSettingsView | undefined; managerMutations?: ManagerMutations | undefined; sendRequests?: readonly OwnerSendRequest[];
  draftHistories?: Readonly<Record<string, readonly DraftRevision[]>>;
  sendingState?: ResourceState; sendingError?: string | undefined; onRetrySending?: (() => void) | undefined;
  onRefreshSendRequests?: (() => Promise<void>) | undefined; onActivityFilter?: ((filter: ActivityFilter) => Promise<void>) | undefined; onInboxRetry?: (() => void) | undefined; onAccountChange?: ((id: string) => void) | undefined; onLoadMore?: (() => void) | undefined; onOpenMessage?: ((message: Message) => Promise<Message>) | undefined;
  onActivityLoadMore?: (() => void) | undefined;
  onSaveDraft?: ((draft: DraftSaveInput) => Promise<DraftRecord>) | undefined; onUpdateDraft?: ((draft: DraftRecord) => Promise<void>) | undefined; onRefreshDraft?: ((id: string) => Promise<void>) | undefined; onReply?: ((message: Message) => Promise<DraftRecord>) | undefined;
  onStartMailboxConnection?: ((input: StartMailboxConnectionInput) => Promise<MailboxConnectionResult>) | undefined; onCompleteMailboxConnection?: ((input: CompleteMailboxConnectionInput) => Promise<MailboxConnectionResult>) | undefined; onChangePassword?: ((input: ChangePasswordInput) => Promise<ChangePasswordResult>) | undefined; onSignOut?: (() => Promise<void>) | undefined;
}) {
  const [screen, setScreen] = React.useState<Screen>(initialScreen); const [activityDetail,setActivityDetail]=React.useState<ActivityRecord>(); const [contextualActivity,setContextualActivity]=React.useState<readonly ActivityRecord[]>([]); const [selected, setSelected] = React.useState<Message>(); const [editingDraft, setEditingDraft] = React.useState<DraftRecord>(); const [detailError, setDetailError] = React.useState(''); const [activityError, setActivityError] = React.useState(false); const [activityMutationPending, setActivityMutationPending] = React.useState<'retry'|'acknowledge'>(); const activityMutationInFlight = React.useRef(false); const [activityFilter, setActivityFilter] = React.useState<ActivityFilter>('new'); const [idempotencyKey] = React.useState(() => globalThis.crypto.randomUUID());
  const messageEpoch = React.useRef(0);
  const switchAccount = (id: string): void => { messageEpoch.current += 1; setSelected(undefined); setContextualActivity([]); setDetailError(''); navigateScreen('inbox'); onAccountChange?.(id); };
  React.useEffect(() => { messageEpoch.current += 1; setSelected(undefined); setContextualActivity([]); setDetailError(''); }, [data.selectedAccountId]);
  const replyToMessage = onReply ? (message: Message): void => { void onReply(message).then(draft => { setEditingDraft(draft); navigateScreen('compose'); }).catch((error: unknown) => { if (!(error instanceof SessionExpiredError)) toast.danger('Could not prepare a reply from the full message. Try again.'); }); } : undefined;
  const [chatConversationId, setChatConversationId] = React.useState<string | undefined>(conversationFromPath);
  const [chatContext, setChatContext] = React.useState<{ accountId: string; messageId: string }>();
  const [chatOpen, setChatOpen] = React.useState(isChatPath);
  const [chatMounted, setChatMounted] = React.useState(isChatPath);
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const chatVisible = React.useRef(chatOpen);
  const assistantEntryOwned = React.useRef(false);
  const assistantReturnPending = React.useRef(false);
  const returnScreen = React.useRef<Screen>(initialScreen);
  const screenRef = React.useRef<Screen>(initialScreen);
  const requestedActivityId = React.useRef<string | undefined>(undefined);
  const loadedActivityId = React.useRef<string | undefined>(undefined);
  const activityFilterRef = React.useRef<ActivityFilter>('new');
  const activityDetailEpoch = React.useRef(0);
  const [activityDetailLoading, setActivityDetailLoading] = React.useState(false);
  const [activityDetailError, setActivityDetailError] = React.useState('');
  const [activityUnavailable, setActivityUnavailable] = React.useState(false);
  const [invalidLink, setInvalidLink] = React.useState(false);
  const applyScreen = React.useCallback((next: Screen): void => {
    if (next !== 'activity-detail') {
      activityDetailEpoch.current += 1;
      requestedActivityId.current = undefined;
    }
    screenRef.current = next;
    setInvalidLink(false);
    setScreen(next);
  }, []);
  const navigateScreen = (next: Screen): void => {
    applyScreen(next);
    history.pushState({ screen: next }, '', next === 'activity' ? '/activity' : '/');
  };
  const openChat = (context?: { accountId: string; messageId: string }): void => {
    if (context) setChatContext(context);
    if (!isChatPath()) {
      returnScreen.current = screenRef.current;
      const returnUrl = location.pathname + location.search + location.hash;
      history.pushState({ ...history.state, assistant: true, returnUrl, returnScreen: screenRef.current }, '', chatConversationId ? `/chat/${encodeURIComponent(chatConversationId)}` : '/chat');
      assistantEntryOwned.current = true;
    }
    chatVisible.current = true; setChatMounted(true); setChatOpen(true);
  };
  const changeChatOpen = (open: boolean): void => {
    if (open) { openChat(); return; }
    chatVisible.current = false; setChatOpen(false);
    if (isChatPath()) {
      const state: unknown = history.state;
      if (assistantEntryOwned.current && typeof state === 'object' && state !== null && 'assistant' in state && state.assistant === true) { assistantReturnPending.current = true; history.back(); }
      else { history.replaceState({ ...history.state, assistant: false, screen: 'inbox' }, '', '/'); applyScreen('inbox'); }
    }
  };
  const conversationOpened = (id: string): void => {
    setChatConversationId(id);
    if (chatVisible.current && isChatPath()) history.replaceState({ ...history.state, conversationId: id }, '', `/chat/${encodeURIComponent(id)}`);
  };
  const openMessage = (message: Message): void => {
    const generation = ++messageEpoch.current;
    setSelected({ ...message, body: undefined }); setDetailError(''); setContextualActivity([]); navigateScreen('message');
    if (onOpenMessage) void onOpenMessage(message).then(detail => { if (messageEpoch.current === generation) setSelected(detail); }).catch((error: unknown) => { if (!(error instanceof SessionExpiredError) && messageEpoch.current === generation) setDetailError(error instanceof Error ? error.message : 'Could not load this message. Retry when the provider is available.'); });
    else setDetailError('Full-message reading is unavailable.');
    void authenticatedFetch(`/api/v1/messages/${encodeURIComponent(message.id)}/activities`).then(async response => response.ok ? response.json() as Promise<{ items: ActivityRecord[] }> : Promise.reject(new Error())).then(result => { if (messageEpoch.current === generation) setContextualActivity(result.items); }).catch((error: unknown) => { if (!(error instanceof SessionExpiredError) && messageEpoch.current === generation) setContextualActivity([]); });
  };
  const loadActivityDetail = React.useCallback(async (id: string): Promise<boolean> => {
    if (requestedActivityId.current !== id) return true;
    const generation = ++activityDetailEpoch.current;
    const current = (): boolean => activityDetailEpoch.current === generation && requestedActivityId.current === id;
    setActivityDetailLoading(true); setActivityDetailError(''); setActivityUnavailable(false);
    try {
      const response = await authenticatedFetch(`/api/v1/activities/${encodeURIComponent(id)}`);
      if (!response.ok) {
        if (response.status === 404 && current() && loadedActivityId.current !== id) setActivityUnavailable(true);
        throw new Error('Could not load this activity.');
      }
      const result = await response.json() as { activity: ActivityRecord };
      if (current()) { loadedActivityId.current = id; setActivityDetail(result.activity); }
      return true;
    } catch (error) {
      if (current() && !(error instanceof SessionExpiredError)) setActivityDetailError('Could not load this activity.');
      return !current() || error instanceof SessionExpiredError;
    } finally {
      if (current()) setActivityDetailLoading(false);
    }
  }, []);
  const openActivity = React.useCallback((activity: ActivityRecord | Pick<ActivityRecord, 'id'>, push = true): void => {
    activityDetailEpoch.current += 1;
    requestedActivityId.current = activity.id;
    loadedActivityId.current = undefined;
    setActivityDetail(undefined); setActivityDetailError(''); setActivityUnavailable(false);
    applyScreen('activity-detail');
    if (push) history.pushState({ screen: 'activity-detail' }, '', `/activity/${encodeURIComponent(activity.id)}`);
    void loadActivityDetail(activity.id);
  }, [applyScreen, loadActivityDetail]);
  React.useEffect(() => {
    const applyRoute = (initial = false): void => {
      const path = location.pathname;
      if (isChatPath()) {
        const id = conversationFromPath();
        if (id) setChatConversationId(id);
        const state: unknown = history.state;
        if (typeof state === 'object' && state !== null && 'returnScreen' in state && typeof state.returnScreen === 'string') returnScreen.current = state.returnScreen as Screen;
        chatVisible.current = true; setChatMounted(true); setChatOpen(true);
        return;
      }
      if (chatVisible.current || assistantReturnPending.current) {
        chatVisible.current = false; assistantReturnPending.current = false; setChatOpen(false);
        screenRef.current = returnScreen.current; setScreen(returnScreen.current);
        return;
      }
      const match = /^\/activity\/([^/]+)$/.exec(path);
      if (match?.[1]) {
        let id: string;
        try { id = decodeURIComponent(match[1]); }
        catch { applyScreen('inbox'); setInvalidLink(true); return; }
        openActivity({ id }, false); return;
      }
      if (path === '/activity') { applyScreen('activity'); return; }
      const state: unknown = history.state;
      const saved: unknown = path === '/' && typeof state === 'object' && state !== null && 'screen' in state ? state.screen : undefined;
      const nonDetailScreens: readonly Screen[] = ['inbox', 'activity', 'drafts', 'sent', 'settings', 'account', 'pending-sends', 'compose'];
      if (typeof saved === 'string' && nonDetailScreens.includes(saved as Screen)) applyScreen(saved as Screen);
      else applyScreen(initial && path === '/' ? initialScreen : 'inbox');
    };
    applyRoute(true);
    const onPopState = (): void => { applyRoute(); };
    addEventListener('popstate', onPopState);
    return () => {
      removeEventListener('popstate', onPopState);
      activityDetailEpoch.current += 1; requestedActivityId.current = undefined;
      messageEpoch.current += 1;
    };
  }, [applyScreen, openActivity, initialScreen]);
  const refreshActivityProposals = React.useCallback(async (): Promise<void> => {
    const id = requestedActivityId.current;
    if (id) await loadActivityDetail(id);
  }, [loadActivityDetail]);
  const refreshAfterActivityMutation = async (id: string): Promise<void> => {
    const results = await Promise.allSettled([
      requestedActivityId.current === id ? loadActivityDetail(id) : Promise.resolve(true),
      onActivityFilter?.(activityFilterRef.current) ?? Promise.resolve(),
    ]);
    if (results.some(result => result.status === 'fulfilled' ? result.value === false : !(result.reason instanceof SessionExpiredError))) {
      toast.warning('Action completed, but Activity could not be refreshed. Try again to refresh without repeating the action.');
    }
  };
  const requestActivityMutation = (activity: ActivityRecord, endpoint: 'retry' | 'acknowledge'): void => {
    if (activityMutationInFlight.current) return;
    activityMutationInFlight.current = true; setActivityMutationPending(endpoint);
    void (async () => {
      if (!navigator.onLine) throw new Error('offline');
      const response = await authenticatedFetch(`/api/v1/activities/${encodeURIComponent(activity.id)}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: activity.version }) });
      if (!response.ok) throw new Error('mutation failed');
      toast.success(endpoint === 'retry' ? 'Activity retry queued.' : 'Activity acknowledged.');
      await refreshAfterActivityMutation(activity.id);
    })().catch((error: unknown) => {
      if (!(error instanceof SessionExpiredError)) toast.danger(endpoint === 'retry' ? 'Could not retry this activity. Reconnect and try again.' : 'Could not acknowledge this activity. Reconnect and try again.');
    }).finally(() => { activityMutationInFlight.current = false; setActivityMutationPending(undefined); });
  };
  const answerCanonical = async (question: NonNullable<ActivityRecord['question']>, answer: string): Promise<void> => {
    if (!navigator.onLine || !question.id || !question.version) throw new Error('offline or unavailable');
    const id = requestedActivityId.current;
    const response = await authenticatedFetch(`/api/v1/agent/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': 'v1' }, body: JSON.stringify({ answer, expectedVersion: question.version, idempotencyKey: globalThis.crypto.randomUUID() }) });
    if (!response.ok) throw new Error('answer failed');
    if (id) await refreshAfterActivityMutation(id);
  };
  const previousDashboard = React.useRef(dashboard);
  React.useEffect(() => {
    const changed = previousDashboard.current !== dashboard;
    previousDashboard.current = dashboard;
    if (changed && screenRef.current === 'activity-detail' && dashboard) void refreshActivityProposals();
  }, [dashboard, refreshActivityProposals]);
  const attachment = async (item: Attachment) => { if (!selected) return; setDetailError(''); try { const response = await authenticatedFetch(`/api/v1/accounts/${encodeURIComponent(selected.accountId)}/messages/${encodeURIComponent(selected.id)}/attachments/${encodeURIComponent(item.id)}`, { headers: { 'x-api-version': 'v1' } }); if (!response.ok) throw new Error(); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name; anchor.click(); URL.revokeObjectURL(url); } catch (error) { if (!(error instanceof SessionExpiredError)) toast.danger('Could not download this attachment. Try again.'); } };
  const chooseActivityFilter = (filter: ActivityFilter) => { activityFilterRef.current = filter; setActivityFilter(filter); setActivityError(false); if (onActivityFilter) void onActivityFilter(filter).catch((error: unknown) => { if (!(error instanceof SessionExpiredError) && activityFilterRef.current === filter) setActivityError(true); }); };
  const agentPanel = dashboard ? <AgentPanel proposalFolders={proposalFolders} dashboard={dashboard} idempotencyKey={idempotencyKey} {...(agentHandlers ? { handlers: agentHandlers } : {})} {...(agentError ? { error: agentError } : {})} /> : agentError ? <ErrorState>{agentError}</ErrorState> : undefined;
  const activityListError = data.activityError || (data.activityState === 'error' || activityError ? 'Could not load activity.' : undefined);
  const retryActivity = data.activity.items.length > 0 && data.activity.nextCursor && onActivityLoadMore ? onActivityLoadMore : onActivityFilter ? () => { chooseActivityFilter(activityFilter); } : undefined;
  const activityContent = <><CanonicalActivityScreen page={data.activity} filter={activityFilter} onFilterChange={chooseActivityFilter} onOpen={openActivity} onLoadMore={onActivityLoadMore} loadingMore={data.activityLoadingMore} loading={data.activityState === 'loading'} error={activityListError} onRetry={retryActivity} />{agentPanel ? <AppPage><PageContainer measure="reading"><div className="border-t border-border pt-6">{agentPanel}</div></PageContainer></AppPage> : null}</>;
  const pendingDrafts = drafts.filter(draft => draft.submission && ['pending', 'dispatching', 'reported', 'unknown'].includes(draft.submission.state));
  const sendingContent = (children: React.ReactNode, hasRows: boolean): React.ReactNode => <ResourceContent state={sendingState} error={sendingError} loadingTitle="Loading sending…" errorMessage="Could not load sending." hasRows={hasRows} onRetry={onRetrySending}>{children}</ResourceContent>;
  const retryActivityDetail = (): void => { const id = requestedActivityId.current; if (id) void loadActivityDetail(id); };
  const activityDetailContent = <AppPage><PageContainer measure="reading" className="grid gap-4">
    {activityUnavailable ? <><StatePanel title="This activity is unavailable." /><Button type="button" variant="ghost" onClick={() => { navigateScreen('activity'); }}>Activity</Button></> : activityDetail ? <>
      {activityDetailError ? <ErrorState action={<Button type="button" variant="outline" disabled={activityDetailLoading} onClick={retryActivityDetail}>Try again</Button>}>Could not refresh this activity.</ErrorState> : null}
      <CanonicalActivityDetail activity={activityDetail} proposalFolders={proposalFolders}
        onDiscussMessage={(accountId, messageId) => { openChat({ accountId, messageId }); }}
        {...(agentHandlers?.onReview ? { onReview: async input => { await agentHandlers.onReview?.(input); await refreshActivityProposals(); } } : {})}
        {...(agentHandlers?.onReloadProposals ? { onReloadProposals: async () => { await agentHandlers.onReloadProposals?.(); await refreshActivityProposals(); } } : {})}
        {...(activityMutationPending ? { pendingAction: activityMutationPending } : {})}
        onBack={() => { navigateScreen('activity'); }}
        onRetry={activity => { requestActivityMutation(activity, 'retry'); }}
        onAcknowledge={activity => { requestActivityMutation(activity, 'acknowledge'); }}
        onAnswerQuestion={answerCanonical}
        onOpenMessage={(accountId, messageId) => {
          const cached = data.messages.find(message => message.accountId === accountId && message.id === messageId);
          openMessage(cached ?? { id: messageId, accountId, sender: 'Unknown sender', initials: '?', subject: activityDetail.messageLabel, preview: '', received: '', body: undefined });
        }} />
    </> : activityDetailError ? <>
      <StatePanel title="Could not load this activity." />
      <Button type="button" variant="outline" disabled={activityDetailLoading} onClick={retryActivityDetail}>Try again</Button>
      <Button type="button" variant="ghost" onClick={() => { navigateScreen('activity'); }}>Activity</Button>
    </> : <StatePanel title="Loading Activity…" loading />}
  </PageContainer></AppPage>;
  const content = screen === 'activity-detail' ? activityDetailContent : screen === 'activity' ? activityContent
  : screen === 'drafts' ? sendingContent(<Drafts drafts={drafts} onOpen={draft => {
    setEditingDraft(draft); navigateScreen('compose');
    if (onRefreshDraft) void onRefreshDraft(draft.id).catch((error: unknown) => { if (!(error instanceof SessionExpiredError)) toast.danger('Could not refresh the saved draft. Local input is preserved.'); });
  }} />, drafts.some(draft => ['editing', 'ready', 'failed', 'sending'].includes(draft.state)))
  : screen === 'sent' ? sendingContent(<Sent drafts={drafts} />, drafts.some(draft => draft.state === 'sent'))
  : screen === 'pending-sends' ? sendingContent(onRefreshSendRequests ? <PendingSendReview requests={sendRequests} drafts={pendingDrafts} onRefresh={onRefreshSendRequests} /> : <StatePanel title="Approvals are unavailable." />, sendRequests.length > 0 || pendingDrafts.length > 0)
  : screen === 'settings' ? <Settings mailboxes={settingsMailboxes} onBack={() => { navigateScreen('inbox'); }}
    {...(onStartMailboxConnection ? { onStartConnection: onStartMailboxConnection } : {})}
    {...(onCompleteMailboxConnection ? { onCompleteConnection: onCompleteMailboxConnection } : {})}
    {...(pendingMailboxConnection ? { pendingConnection: pendingMailboxConnection } : {})}
    {...(settingsNotice ? { statusNotice: settingsNotice } : {})}
    {...(managerSettings ? { managerSettings } : {})} {...(managerMutations ? { managerMutations } : {})} online={online} />
  : screen === 'account' ? <AccountScreen ownerEmail={ownerEmail} onBack={() => { navigateScreen('inbox'); }}
    onChangePassword={onChangePassword ?? (() => Promise.resolve({ ok: false, error: 'Password change is unavailable.' }))}
    onSignOut={onSignOut ?? (() => Promise.reject(new Error('Sign out is unavailable.')))} />
  : screen === 'compose' ? editingDraft ? <AppPage><PageContainer measure="reading">
    <Button type="button" variant="ghost" onClick={() => { setEditingDraft(undefined); navigateScreen('drafts'); }}>Close draft</Button>
    <DraftCompose key={editingDraft.id} draft={drafts.find(draft => draft.id === editingDraft.id) ?? editingDraft}
      {...(onUpdateDraft ? { onAutosave: onUpdateDraft } : {})}
      {...(onRefreshDraft ? { onRefresh: () => onRefreshDraft(editingDraft.id) } : {})}
      {...(draftHistories?.[editingDraft.id] ? { revisions: draftHistories[editingDraft.id] } : {})} />
  </PageContainer></AppPage> : <Compose accounts={data.accounts} onClose={() => { setEditingDraft(undefined); navigateScreen('drafts'); }}
    {...(onSaveDraft ? { onSave: async input => { const draft = await onSaveDraft(input); setEditingDraft(draft); return draft; } } : {})} /> : null;
  const inboxDestination = destinationForScreen(screen) === 'inbox';
  const approvalCount = onRefreshSendRequests && sendingState === 'ready' ? sendRequests.filter(request => request.state === 'pending_owner_approval').length : 0;
  return <main className="min-h-dvh overflow-x-hidden bg-background [@media(min-width:700px)]:grid [@media(min-width:700px)]:grid-cols-[240px_minmax(0,1fr)]">
    <p className="sr-only" aria-live="polite">Viewing {screen}</p>
    <Rail screen={screen} ownerEmail={ownerEmail} online={online} onScreen={navigateScreen} approvalCount={approvalCount} {...(onSignOut ? { onSignOut } : {})} />
    <header className="sticky top-0 z-10 flex min-h-16 min-w-0 items-center gap-2 border-b border-border bg-background px-4 [@media(min-width:700px)]:hidden"><strong className="mr-auto text-lg tracking-tight">hypermail</strong><Button className="h-11 gap-2 px-3" type="button" onClick={() => { navigateScreen('compose'); }}><Plus aria-hidden="true" className="size-4" />Compose</Button><OwnerMenu compact ownerEmail={ownerEmail} online={online} onNavigate={navigateScreen} {...(onSignOut ? { onSignOut } : {})} /></header>
    <section className={cn('min-w-0 bg-card pb-[calc(154px+env(safe-area-inset-bottom))] [@media(min-width:700px)]:pb-0', inboxDestination && !invalidLink && 'lg:grid lg:grid-cols-[360px_minmax(0,1fr)]')} aria-label="Workspace">
      {invalidLink ? <AppPage><PageContainer measure="reading"><StatePanel title="This link is invalid." /><Button type="button" onClick={() => { navigateScreen('inbox'); }}>Back to Inbox</Button></PageContainer></AppPage> : inboxDestination ? <>
        <div className={cn('min-w-0 border-r border-border', screen === 'message' ? 'hidden lg:block' : 'block')}>
          <Inbox data={data} state={initialState} selectedId={selected?.id} onOpen={openMessage} onRetry={onInboxRetry} onAccountChange={switchAccount} onLoadMore={onLoadMore} />
        </div>
        <div className={cn('min-w-0 bg-card', screen === 'message' ? 'block' : 'hidden lg:block')}>
          {selected ? <Reader onDiscuss={message => { openChat({ accountId: message.accountId, messageId: message.id }); }} message={selected} onBack={() => { navigateScreen('inbox'); }} onAttachment={attachment} onOpenActivity={openActivity} contextualActivity={contextualActivity} error={detailError} {...(replyToMessage ? { onReply: replyToMessage } : {})} onRetry={() => { openMessage(selected); }} /> : <StatePanel title="No message selected." />}
        </div>
      </> : content}
    </section>
    <nav className="fixed right-0 bottom-0 left-0 z-10 grid h-[calc(66px+env(safe-area-inset-bottom))] grid-cols-5 items-stretch border-t border-border bg-background px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] [@media(min-width:700px)]:hidden" aria-label="Mobile primary">{destinations.map(({ id, label, icon }) => <NavigationItem key={id} active={destinationActive(screen, id)} icon={icon} className="relative h-full min-h-11 flex-col justify-center gap-0.5 px-1 py-1 text-xs [&_svg]:size-5" onClick={() => { navigateScreen(id); }}>{label}{id === 'pending-sends' && approvalCount > 0 ? <span className="absolute top-0 right-0"><ApprovalBadge count={approvalCount} /></span> : null}</NavigationItem>)}</nav>
    <Button ref={launcherRef} className="fixed right-4 bottom-[calc(82px+env(safe-area-inset-bottom))] z-20 size-14 min-w-14 rounded-full border border-border bg-primary text-primary-foreground [@media(min-width:700px)]:right-6 [@media(min-width:700px)]:bottom-6" size="icon" type="button" aria-label="Open Assistant" title="Assistant" aria-haspopup="dialog" aria-expanded={chatOpen} aria-controls="assistant-dialog" onClick={() => { openChat(); }}><MessageCircle aria-hidden="true" className="size-6" /></Button>
    {chatMounted ? <ChatSurface accounts={data.accounts} isOpen={chatOpen} onOpenChange={changeChatOpen} launcherRef={launcherRef} {...(chatConversationId ? { conversationId: chatConversationId } : {})} {...(chatContext ? { initialContext: chatContext } : {})} onConversationOpened={conversationOpened} /> : null}
  </main>;
}
