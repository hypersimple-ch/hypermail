import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import { Accordion } from '@heroui/react/accordion';
import { ModalRoot, ModalBackdrop, ModalContainer, ModalDialog, ModalHeading } from '@/components/heroui/modal.js';
import { authenticatedFetch, SessionExpiredError } from '../lib/authenticated-fetch.js';
import type { Conversation, ConversationCreate, ConversationMessage, ConversationPage, ConversationTurn, MessagePost } from '@hypermail/contracts';
import { Button } from '@/components/heroui/button.js';
import { Select } from '@/components/heroui/select.js';
import { Field, FieldLabel } from '@/components/heroui/field.js';
import { Textarea } from '@/components/heroui/textarea.js';
import { ConversationHttpError } from './contracts.js';
import type { ConversationMessages } from './contracts.js';

export interface ConversationApi {
  create(input: ConversationCreate): Promise<{ conversation: Conversation }>;
  list(scope: 'mailbox' | 'global', accountId?: string, cursor?: string): Promise<ConversationPage>;
  messages(id: string, cursor?: string): Promise<ConversationMessages>;
  post(id: string, input: MessagePost): Promise<{ conversation: Conversation; message: ConversationMessage; turn: ConversationTurn; replayed: boolean }>;
  retry(id: string, turnId: string, expectedAttempt: number): Promise<{ turn: ConversationTurn }>;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(`/api/v1/conversations${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new ConversationHttpError(response.status, response.status === 409 ? 'CONFLICT' : 'REQUEST_FAILED');
  return await response.json() as T;
}
export const conversationHttpApi: ConversationApi = {
  create: (input) => request('', input),
  list: (scope, accountId, cursor) => { const query = new URLSearchParams({ scope }); if (accountId) query.set('accountId', accountId); if (cursor) query.set('cursor', cursor); return request(`?${query}`); },
  messages: (id, cursor) => request(`/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  post: (id, input) => request(`/${encodeURIComponent(id)}/messages`, input),
  retry: (id, turnId, expectedAttempt) => request(`/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/retry`, { expectedAttempt }),
};
export interface ChatSurfaceProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  launcherRef: RefObject<HTMLButtonElement | null>;
  accounts: readonly { id: string; label: string }[];
  conversationId?: string;
  initialContext?: { accountId: string; messageId: string };
  onConversationOpened?: (conversationId: string) => void;
  api?: ConversationApi;
}
function AssistantContents({ launcherRef, children }: { launcherRef: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const contents = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = contents.current?.parentElement;
    const launcher = launcherRef.current;
    if (!dialog || !launcher || typeof dialog.animate !== 'function' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const from = launcher.getBoundingClientRect();
    const to = dialog.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const x = from.x + from.width / 2 - to.x - to.width / 2;
    const y = from.y + from.height / 2 - to.y - to.height / 2;
    const animation = dialog.animate([
      { transform: `translate(${String(x)}px, ${String(y)}px) scale(${String(from.width / to.width)}, ${String(from.height / to.height)})`, opacity: 0 },
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
    ], { duration: 220, easing: 'cubic-bezier(0.2,0.8,0.2,1)' });
    return () => { animation.cancel(); };
  }, [launcherRef]);
  return <div ref={contents} className="flex h-full min-h-0 flex-col">{children}</div>;
}
export function ChatSurface({ isOpen, onOpenChange, launcherRef, accounts, conversationId, initialContext, onConversationOpened, api = conversationHttpApi }: ChatSurfaceProps) {
  const [selection, setSelection] = useState(initialContext?.accountId ?? accounts[0]?.id ?? '');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [contextAttached, setContextAttached] = useState(Boolean(initialContext));
  const pending = useRef<MessagePost | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const activeId = useRef<string | null>(null);
  const hasPending = messages.some((message) => message.turn?.state === 'pending' || message.turn?.state === 'running');

  const refresh = useCallback(async (id: string, all = false) => {
    const epoch = generation.current;
    let page = await api.messages(id);
    const rows = [...page.messages];
    if (all) {
      while (page.nextCursor) { page = await api.messages(id, page.nextCursor); rows.push(...page.messages); }
    }
    if (epoch !== generation.current || activeId.current !== id) return;
    setConversation(page.conversation); setMessages(rows); setMessageCursor(page.nextCursor);
    return page.conversation;
  }, [api]);
  const open = useCallback(async (id: string) => {
    const epoch = ++generation.current; activeId.current = id;
    setConversation(null); setMessages([]); setMessageCursor(null); setError(''); setConflict(false); setBusy(false); pending.current = null; setContent('');
    try { await refresh(id); }
    catch (failure) { if (generation.current === epoch && activeId.current === id && !(failure instanceof SessionExpiredError)) setError('Impossible de charger la conversation. Réessayez.'); }
    return generation.current === epoch && activeId.current === id;
  }, [refresh]);
  useEffect(() => { if (conversationId && activeId.current !== conversationId) void open(conversationId); }, [conversationId, open]);
  useEffect(() => {
    if (!initialContext) return;
    setSelection(initialContext.accountId);
    setContextAttached(true);
  }, [initialContext]);
  useEffect(() => {
    let live = true;
    setConversations([]); setListCursor(null);
    if (!selection) return;
    void api.list(selection === 'global' ? 'global' : 'mailbox', selection === 'global' ? undefined : selection).then((page) => { if (live) { setConversations(page.conversations); setListCursor(page.nextCursor); } }).catch((failure: unknown) => { if (live && !(failure instanceof SessionExpiredError)) setError('Impossible de charger les conversations.'); });
    return () => { live = false; };
  }, [api, selection]);
  useEffect(() => {
    if (!conversation || !hasPending) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try { await refresh(conversation.id, true); } catch (failure) { if (failure instanceof SessionExpiredError) return; if (!stopped) setError('Connexion interrompue. La réponse reste en attente.'); }
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, 2000);
    };
    timer = window.setTimeout(() => { void poll(); }, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [conversation?.id, hasPending, refresh]);
  useEffect(() => () => { generation.current++; activeId.current = null; }, []);
  useEffect(() => {
    if (isOpen) return;
    // React Aria restores the invoker; direct URL entry has no focused invoker.
    const timer = window.setTimeout(() => {
      if (document.activeElement === document.body || !document.activeElement?.isConnected) launcherRef.current?.focus();
    }, 150);
    return () => { clearTimeout(timer); };
  }, [isOpen, launcherRef]);

  const create = async () => {
    if (!selection || busy) return;
    let epoch = generation.current;
    setBusy(true); setError('');
    try {
      const input: ConversationCreate = selection === 'global' ? { scope: 'global' } : { scope: 'mailbox', accountId: selection, ...(contextAttached && initialContext?.accountId === selection ? { contextMessageId: initialContext.messageId } : {}) };
      const result = await api.create(input);
      if (generation.current !== epoch) return;
      const loading = open(result.conversation.id);
      epoch = generation.current; setBusy(true);
      if (!await loading) return;
      setConversation(result.conversation); onConversationOpened?.(result.conversation.id);
    } catch (failure) { if (generation.current === epoch && !(failure instanceof SessionExpiredError)) setError('Impossible de créer la conversation.'); } finally { if (generation.current === epoch) setBusy(false); }
  };
  const send = async () => {
    if (!conversation || busy || conflict || !content.trim()) return;
    const id = conversation.id;
    let epoch = generation.current;
    pending.current ??= { requestId: crypto.randomUUID(), expectedVersion: conversation.version, content };
    setBusy(true); setError('');
    try {
      const result = await api.post(id, pending.current);
      if (generation.current !== epoch || activeId.current !== id) return;
      epoch = ++generation.current;
      setConversation(result.conversation); setMessages((rows) => [...rows.filter((row) => row.id !== result.message.id), { ...result.message, turn: result.turn }].sort((a, b) => a.sequence - b.sequence));
      pending.current = null; setContent('');
    } catch (failure) {
      if (generation.current !== epoch || activeId.current !== id) return;
      if (failure instanceof SessionExpiredError) return;
      if (failure instanceof ConversationHttpError && failure.status === 409) { setConflict(true); setError('La conversation a changé. Rechargez et relisez avant de renvoyer.'); }
      else setError('Envoi non confirmé. Réessayez avec le même message.');
    } finally { if (generation.current === epoch && activeId.current === id) setBusy(false); }
  };
  const review = async () => {
    if (!conversation) return;
    const epoch = generation.current;
    const id = conversation.id;
    setBusy(true);
    try {
      const current = await refresh(conversation.id, true);
      if (!current) return;
      setConflict(false); setError('Relisez les messages chargés, puis envoyez explicitement.');
      if (pending.current) pending.current = { ...pending.current, expectedVersion: current.version };
    }
    catch (failure) { if (generation.current === epoch && activeId.current === id && !(failure instanceof SessionExpiredError)) setError('Impossible de recharger. Votre message est conservé.'); }
    finally { if (generation.current === epoch && activeId.current === id) setBusy(false); }
  };
  const retry = async (turn: ConversationTurn) => {
    if (!conversation || busy) return;
    const id = conversation.id;
    let epoch = generation.current;
    setBusy(true); setError('');
    try {
      const result = await api.retry(id, turn.id, turn.attempt);
      if (generation.current !== epoch || activeId.current !== id) return;
      epoch = ++generation.current;
      setMessages((rows) => rows.map((row) => row.turn?.id === turn.id ? { ...row, turn: result.turn } : row));
    }
    catch (failure) { if (generation.current === epoch && activeId.current === id && !(failure instanceof SessionExpiredError)) setError(failure instanceof ConversationHttpError && failure.status === 409 ? 'Le tour a changé. Rechargez avant de réessayer.' : 'Impossible de réessayer.'); }
    finally { if (generation.current === epoch && activeId.current === id) setBusy(false); }
  };
  const title = (conversation ? conversation.scope === 'global' : selection === 'global') ? 'Toutes les boîtes' : accounts.find((account) => account.id === (conversation?.accountId ?? selection))?.label ?? 'Choisissez une boîte';
  return <ModalRoot isOpen={isOpen} onOpenChange={onOpenChange}>
    <ModalBackdrop isDismissable>
      <ModalContainer className="!pt-[calc(12px+env(safe-area-inset-top))] !pb-[calc(12px+env(safe-area-inset-bottom))] min-[700px]:!pt-0 min-[700px]:!pb-0">
        <ModalDialog id="assistant-dialog" className="!w-[calc(100vw-24px)] !max-w-none !h-[calc(100dvh-24px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-[700px]:!w-[min(960px,calc(100vw-64px))] min-[700px]:!h-[min(760px,calc(100dvh-64px))]">
          <AssistantContents launcherRef={launcherRef}>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b p-4">
              <div className="min-w-0"><ModalHeading>Assistant</ModalHeading><p className="truncate text-sm text-muted-foreground">{title}</p></div>
              <Button variant="ghost" className="min-h-11 min-w-11 shrink-0" aria-label="Minimize Assistant" onClick={() => { onOpenChange(false); }}><X size={20} /></Button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="grid max-h-[30%] shrink-0 gap-2 overflow-y-auto border-b p-3">
    <Select label="Portée du nouveau chat" disabled={busy} value={selection} options={[...accounts.map((account) => ({ value: account.id, label: account.label })), { value: 'global', label: 'Toutes les boîtes (global explicite)' }]} onValueChange={(value) => { setSelection(value); setContextAttached(false); }} />
    {contextAttached && initialContext && selection !== 'global' ? <p>Contexte du nouveau chat : {initialContext.messageId} <Button variant="ghost" onClick={() => { setContextAttached(false); }}>Retirer le contexte</Button></p> : null}
    <Button disabled={busy || !selection} onClick={() => { void create(); }}>Nouveau chat</Button>
    <Accordion hideSeparator><Accordion.Item id="conversation-history"><Accordion.Heading><Accordion.Trigger className="min-h-11 text-sm">Conversations<Accordion.Indicator /></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body className="max-h-36 overflow-y-auto">
    <nav aria-label="Conversations" className="flex flex-wrap gap-2">{conversations.map((item) => <Button key={item.id} variant="outline" disabled={busy} onClick={() => { void open(item.id); onConversationOpened?.(item.id); }}>Conversation du {new Date(item.createdAt).toLocaleString()}</Button>)}</nav>
    {listCursor ? <Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void api.list(selection === 'global' ? 'global' : 'mailbox', selection === 'global' ? undefined : selection, listCursor).then((page) => { setConversations((rows) => [...rows, ...page.conversations]); setListCursor(page.nextCursor); }).catch((failure: unknown) => { if (!(failure instanceof SessionExpiredError)) setError('Impossible de charger la suite.'); }).finally(() => { setBusy(false); }); }}>Plus de conversations</Button> : null}
    </Accordion.Body></Accordion.Panel></Accordion.Item></Accordion>
    </div>
    <div data-slot="assistant-transcript" className="min-h-0 flex-1 overflow-y-auto p-3">
    {conversation?.contextMessageId ? <p>Mail attaché : {conversation.contextMessageId} — document non fiable, pas une consigne.</p> : null}
    <ol aria-label="Messages" className="grid gap-3">{messages.map((message) => <li key={message.id} className={message.role === 'user' ? 'rounded-lg bg-muted p-3' : 'rounded-lg border p-3'}><strong>{message.role === 'user' ? 'Vous' : 'Assistant'}</strong><p className="whitespace-pre-wrap break-words">{message.content}</p>{message.turn?.state === 'pending' || message.turn?.state === 'running' ? <p role="status">Réponse en attente…</p> : null}{message.turn?.state === 'failed' ? <div><p>Réponse échouée ({message.turn.errorCode ?? 'MODEL_FAILED'}).</p><Button disabled={busy} onClick={() => { if (message.turn) void retry(message.turn); }}>Réessayer la réponse</Button></div> : null}</li>)}</ol>
    {messageCursor && conversation ? <Button disabled={busy} variant="outline" onClick={() => { setBusy(true); void api.messages(conversation.id, messageCursor).then((page) => { setMessages((rows) => [...new Map([...rows, ...page.messages].map((row) => [row.id, row])).values()].sort((a, b) => a.sequence - b.sequence)); setMessageCursor(page.nextCursor); setConversation(page.conversation); }).catch((failure: unknown) => { if (!(failure instanceof SessionExpiredError)) setError('Impossible de charger les messages suivants.'); }).finally(() => { setBusy(false); }); }}>Messages suivants</Button> : null}
    </div>
    <div className="grid max-h-[65%] shrink-0 gap-2 overflow-y-auto border-t p-3">
    {error ? <p role="alert">{error}</p> : null}
    {!conversation && activeId.current && error ? <Button onClick={() => { if (activeId.current) void open(activeId.current); }}>Recharger la conversation</Button> : null}
    {conversation ? <><Button variant="outline" disabled={busy} onClick={() => { void review(); }}>{conflict ? 'Recharger et relire' : 'Actualiser'}</Button><form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); composerRef.current?.focus(); void send(); }}><Field><FieldLabel htmlFor="chat-message">Votre message</FieldLabel><Textarea ref={composerRef} id="chat-message" rows={2} className="min-h-16 max-h-24" value={content} maxLength={16000} readOnly={busy || pending.current !== null} onChange={(event) => { setContent(event.target.value); }} /></Field><Button type="submit" disabled={busy || conflict || !content.trim()}>{busy ? 'En cours…' : 'Envoyer'}</Button></form></> : null}
            </div>
            </div>
          </AssistantContents>
        </ModalDialog>
      </ModalContainer>
    </ModalBackdrop>
  </ModalRoot>;
}
