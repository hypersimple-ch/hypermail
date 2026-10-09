import * as React from 'react';
import { ArrowLeft, Bot, FilePenLine, Mail, MoreHorizontal, Paperclip, Plus, Send, Settings as SettingsIcon, UserRound, X } from 'lucide-react';
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
import { DraftCompose } from '../drafts/surfaces.js';
import type { DraftRecord, DraftRevision } from '../drafts/contracts.js';
import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';

export type MailState = 'loading' | 'ready' | 'empty' | 'error';
export type ResourceState = 'loading' | 'ready' | 'error';
export type { ActivityFilter } from '../activity/contracts.js';
export type Screen = 'inbox' | 'activity' | 'drafts' | 'sent' | 'more' | 'settings' | 'account' | 'message' | 'compose' | 'activity-detail' | 'pending-sends' | 'chat';
export interface Account { id: string; label: string; address: string; unread?: number; }
export interface Attachment { id: string; name: string; size: string; safe?: boolean; }
export type DraftSaveInput = { accountId: string; recipient: string; subject: string; body: string; bodyFormat: DraftBodyFormat };
export interface Message { id: string; accountId: string; sender: string; senderAddress?: string; initials: string; subject: string; preview: string; received: string; receivedAt?: string; unread?: boolean; body?: string | undefined; attachments?: readonly Attachment[]; }
export interface ShellData { accounts: readonly Account[]; messages: readonly Message[]; activity: ActivityPage; activityState?: ResourceState; activityError?: string; activityLoadingMore?: boolean; selectedAccountId?: string; inboxState?: MailState; inboxNextCursor?: string | null; inboxLoadingMore?: boolean; inboxError?: string; }

const formText = (form: FormData, name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
const paneClass = 'min-w-0 bg-background';

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
  return <article className="min-w-0 bg-background px-4 pb-24 sm:px-8" aria-label="Message detail"><header className="flex min-h-17 items-center border-b border-border"><Button variant="ghost" size="sm" type="button" onClick={onBack}><ArrowLeft aria-hidden="true" />Inbox</Button></header>
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
export function More({ ownerEmail, onSettings, onAccount, onPendingSends, onChat, onSent }: { ownerEmail?: string; onSettings?: () => void; onAccount?: () => void; onPendingSends?: () => void; onChat?: () => void; onSent?: () => void }) {
  return <AppPage aria-label="More"><PageHeader title="More" description="Mailbox and owner controls" className="mb-5" /><div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2 xl:grid-cols-3">
    <Button type="button" variant="outline" className="h-auto min-h-20 w-full min-w-0 justify-start gap-3 rounded-lg px-4 py-4 text-left" onClick={onSettings} disabled={!onSettings}><SettingsIcon aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0"><strong className="block">Settings</strong><span className="mt-1 block text-sm font-normal text-muted-foreground">Add and review connected mailboxes.</span></span></Button>
    <Button type="button" variant="outline" className="h-auto min-h-20 w-full min-w-0 justify-start gap-3 rounded-lg px-4 py-4 text-left" onClick={onAccount} disabled={!onAccount}><UserRound aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0"><strong className="block">Account</strong><span className="mt-1 block truncate text-sm font-normal text-muted-foreground">{ownerEmail || 'Owner identity and password security.'}</span></span></Button>
    <Button type="button" variant="outline" className="h-auto min-h-20 w-full min-w-0 justify-start gap-3 rounded-lg px-4 py-4 text-left lg:col-span-2 xl:col-span-1" onClick={onPendingSends}><Send aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0"><strong className="block">Pending sends</strong><span className="mt-1 block text-sm font-normal text-muted-foreground">Review agent-requested sends.</span></span></Button>
    <Button type="button" variant="outline" className="h-auto min-h-20 w-full min-w-0 justify-start gap-3 rounded-lg px-4 py-4 text-left" onClick={onChat} disabled={!onChat}><Bot aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0"><strong className="block">Chat</strong><span className="mt-1 block text-sm font-normal text-muted-foreground">Scoped conversations with the assistant.</span></span></Button>
    <Button type="button" variant="outline" className="h-auto min-h-20 w-full min-w-0 justify-start gap-3 rounded-lg px-4 py-4 text-left" onClick={onSent} disabled={!onSent}><Send aria-hidden="true" className="size-5 shrink-0" /><span className="min-w-0"><strong className="block">Sent</strong><span className="mt-1 block text-sm font-normal text-muted-foreground">Review sent messages.</span></span></Button>
  </div></AppPage>;
}

type PrimaryDestination = Extract<Screen, 'inbox' | 'activity' | 'drafts' | 'sent' | 'more'>;
const destinations: Array<{ id: PrimaryDestination; label: string; icon: typeof Mail }> = [{ id: 'inbox', label: 'Inbox', icon: Mail }, { id: 'activity', label: 'Activity', icon: Bot }, { id: 'drafts', label: 'Drafts', icon: FilePenLine }, { id: 'sent', label: 'Sent', icon: Send }, { id: 'more', label: 'More', icon: MoreHorizontal }];
const screenDestinations: Record<Screen, PrimaryDestination | undefined> = { inbox: 'inbox', message: 'inbox', activity: 'activity', 'activity-detail': 'activity', drafts: 'drafts', sent: 'sent', more: 'more', settings: 'more', account: 'more', 'pending-sends': 'more', compose: undefined, chat: 'more' };
export const destinationForScreen = (screen: Screen): PrimaryDestination | undefined => screenDestinations[screen];
const destinationActive = (screen: Screen, destination: PrimaryDestination): boolean => destinationForScreen(screen) === destination;
function Rail({ screen, ownerEmail, online, onScreen }: { screen: Screen; ownerEmail: string; online: boolean; onScreen: (screen: Screen) => void }) { return <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-border bg-card p-4 [@media(min-width:700px)]:flex" aria-label="Mailbox navigation"><strong className="px-2 text-xl tracking-tight">hypermail</strong><Button type="button" onClick={() => { onScreen('compose'); }}><Plus aria-hidden="true" />Compose</Button><nav className="grid gap-1" aria-label="Primary">{destinations.map(({ id, label, icon }) => <NavigationItem key={id} active={screen !== 'chat' && destinationActive(screen, id)} icon={icon} onClick={() => { onScreen(id); }}>{label}</NavigationItem>)}<NavigationItem active={screen === 'chat'} icon={Bot} onClick={() => { onScreen('chat'); }}>Chat</NavigationItem></nav><footer className="mt-auto flex min-w-0 items-center gap-3 border-t border-border px-2 pt-4" aria-label="Owner and connection status"><UserRound aria-hidden="true" className="size-5 shrink-0 text-muted-foreground"/><span className="min-w-0 text-sm"><bdi className="block truncate font-medium">{ownerEmail || 'Owner'}</bdi><span className="block text-muted-foreground">{online ? 'Online' : 'Offline'}</span></span></footer></aside>; }

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
  const [chatConversationId, setChatConversationId] = React.useState<string>();
  const [chatContext, setChatContext] = React.useState<{ accountId: string; messageId: string }>();
  const chatEpoch = React.useRef(0);
  const [chatEntry, setChatEntry] = React.useState(0);
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
    if (next !== 'chat') chatEpoch.current += 1;
    screenRef.current = next;
    setInvalidLink(false);
    setScreen(next);
  }, []);
  const navigateScreen = (next: Screen): void => {
    if (next === 'chat') {
      chatEpoch.current += 1; setChatEntry(chatEpoch.current);
      setChatConversationId(undefined); setChatContext(undefined);
    }
    applyScreen(next);
    history.pushState({ screen: next }, '', next === 'activity' ? '/activity' : next === 'chat' ? '/chat' : '/');
  };
  const openChat = (context?: { accountId: string; messageId: string }): void => {
    navigateScreen('chat');
    setChatContext(context);
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
      const match = /^\/(activity|chat)\/([^/]+)$/.exec(path);
      if (match && match[2] !== undefined) {
        let id: string;
        try { id = decodeURIComponent(match[2]); }
        catch {
          applyScreen('inbox'); setInvalidLink(true); return;
        }
        if (match[1] === 'activity') { openActivity({ id }, false); return; }
        chatEpoch.current += 1; setChatEntry(chatEpoch.current);
        setChatConversationId(id); setChatContext(undefined); applyScreen('chat'); return;
      }
      if (path === '/chat') {
        chatEpoch.current += 1; setChatEntry(chatEpoch.current);
        setChatConversationId(undefined); setChatContext(undefined); applyScreen('chat'); return;
      }
      if (path === '/activity') { applyScreen('activity'); return; }
      const state: unknown = history.state;
      const saved: unknown = path === '/' && typeof state === 'object' && state !== null && 'screen' in state ? state.screen : undefined;
      const nonDetailScreens: readonly Screen[] = ['inbox', 'activity', 'drafts', 'sent', 'more', 'settings', 'account', 'pending-sends', 'compose', 'chat'];
      if (typeof saved === 'string' && nonDetailScreens.includes(saved as Screen)) {
        if (saved === 'chat') {
          chatEpoch.current += 1; setChatEntry(chatEpoch.current);
          setChatConversationId(undefined); setChatContext(undefined);
        }
        applyScreen(saved as Screen);
      }
      else applyScreen(initial && path === '/' ? initialScreen : 'inbox');
    };
    applyRoute(true);
    const onPopState = (): void => { applyRoute(); };
    addEventListener('popstate', onPopState);
    return () => {
      removeEventListener('popstate', onPopState);
      activityDetailEpoch.current += 1; requestedActivityId.current = undefined;
      chatEpoch.current += 1; messageEpoch.current += 1;
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
  const content = screen === 'chat' ? <ChatSurface key={chatEntry} accounts={data.accounts}
    {...(chatConversationId ? { conversationId: chatConversationId } : {})}
    {...(chatContext ? { initialContext: chatContext } : {})}
    onConversationOpened={id => {
      if (screenRef.current !== 'chat' || chatEpoch.current !== chatEntry || chatConversationId === id) return;
      setChatConversationId(id); setChatContext(undefined);
      history.pushState({ screen: 'chat' }, '', `/chat/${encodeURIComponent(id)}`);
    }} /> : screen === 'activity-detail' ? activityDetailContent : screen === 'activity' ? activityContent
    : screen === 'drafts' ? sendingContent(<Drafts drafts={drafts} onOpen={draft => {
      setEditingDraft(draft); navigateScreen('compose');
      if (onRefreshDraft) void onRefreshDraft(draft.id).catch((error: unknown) => { if (!(error instanceof SessionExpiredError)) toast.danger('Could not refresh the saved draft. Local input is preserved.'); });
    }} />, drafts.some(draft => ['editing', 'ready', 'failed', 'sending'].includes(draft.state)))
    : screen === 'sent' ? sendingContent(<Sent drafts={drafts} />, drafts.some(draft => draft.state === 'sent'))
    : screen === 'more' ? <More onChat={() => { navigateScreen('chat'); }} ownerEmail={ownerEmail}
      onSettings={() => { navigateScreen('settings'); }} onAccount={() => { navigateScreen('account'); }}
      onPendingSends={() => { navigateScreen('pending-sends'); }} onSent={() => { navigateScreen('sent'); }} />
    : screen === 'pending-sends' ? sendingContent(onRefreshSendRequests ? <PendingSendReview requests={sendRequests} drafts={pendingDrafts} onRefresh={onRefreshSendRequests} /> : <StatePanel title="Pending sending review is unavailable." />, sendRequests.length > 0 || pendingDrafts.length > 0)
    : screen === 'settings' ? <Settings mailboxes={settingsMailboxes} onBack={() => { navigateScreen('more'); }}
      {...(onStartMailboxConnection ? { onStartConnection: onStartMailboxConnection } : {})}
      {...(onCompleteMailboxConnection ? { onCompleteConnection: onCompleteMailboxConnection } : {})}
      {...(pendingMailboxConnection ? { pendingConnection: pendingMailboxConnection } : {})}
      {...(settingsNotice ? { statusNotice: settingsNotice } : {})}
      {...(managerSettings ? { managerSettings } : {})} {...(managerMutations ? { managerMutations } : {})} online={online} />
    : screen === 'account' ? <AccountScreen ownerEmail={ownerEmail} onBack={() => { navigateScreen('more'); }}
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
  return <main className="min-h-dvh overflow-x-hidden bg-background [@media(min-width:700px)]:grid [@media(min-width:700px)]:grid-cols-[220px_minmax(0,1fr)]">
    <p className="sr-only" aria-live="polite">Viewing {screen}</p>
    <Rail screen={screen} ownerEmail={ownerEmail} online={online} onScreen={navigateScreen} />
    <section className={cn('min-w-0 bg-background pb-24 [@media(min-width:700px)]:pb-0', inboxDestination && '[@media(min-width:700px)]:grid [@media(min-width:700px)]:grid-cols-[385px_minmax(0,1fr)]')} aria-label="Desktop mailbox">
      {invalidLink ? <AppPage><PageContainer measure="reading"><StatePanel title="This link is invalid." /><Button type="button" onClick={() => { navigateScreen('inbox'); }}>Back to Inbox</Button></PageContainer></AppPage> : inboxDestination ? <>
        <div className={cn('min-w-0 [@media(min-width:700px)]:block', screen === 'message' && 'hidden')}>
          <Inbox data={data} state={initialState} selectedId={selected?.id} onOpen={openMessage} onRetry={onInboxRetry} onAccountChange={switchAccount} onLoadMore={onLoadMore} />
        </div>
        <div className={cn('min-w-0 [@media(min-width:700px)]:block', screen === 'inbox' && 'hidden')}>
          {selected ? <Reader onDiscuss={message => { openChat({ accountId: message.accountId, messageId: message.id }); }} message={selected} onBack={() => { navigateScreen('inbox'); }} onAttachment={attachment} onOpenActivity={openActivity} contextualActivity={contextualActivity} error={detailError} {...(replyToMessage ? { onReply: replyToMessage } : {})} onRetry={() => { openMessage(selected); }} /> : <StatePanel title="No message selected." />}
        </div>
      </> : content}
    </section>
    <nav className="fixed right-0 bottom-0 left-0 z-10 grid h-[calc(66px+env(safe-area-inset-bottom))] grid-cols-4 items-stretch border-t border-border bg-background px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] [@media(min-width:700px)]:hidden" aria-label="Mobile primary">{destinations.filter(({ id }) => id !== 'sent').map(({ id, label, icon }) => <NavigationItem key={id} active={destinationActive(screen, id)} icon={icon} className="h-full min-h-11 flex-col justify-center gap-0.5 px-1 py-1 text-xs [&_svg]:size-5" onClick={() => { navigateScreen(id); }}>{label}</NavigationItem>)}</nav>
    <Button className="fixed right-4 bottom-[calc(74px+env(safe-area-inset-bottom))] z-20 rounded-full shadow-sm [@media(min-width:700px)]:hidden" size="icon" type="button" aria-label="Compose" onClick={() => { navigateScreen('compose'); }}><Plus aria-hidden="true" /></Button>
  </main>;
}
