import { MailboxMemoryUnavailableError, type ConversationModel, type MailboxMemory } from '@hypermail/agent';
import { conversationReplySchema, conversationRespondJobSchema } from '@hypermail/contracts';
import type { ConversationStore } from '@hypermail/db';

type ConsumerStore = Pick<ConversationStore, 'claim' | 'recentMessages' | 'renew' | 'complete' | 'fail'>;
export interface ConversationContextMessage { messageId: string; sender: string; subject: string; body: string }
export type ConversationContextReader = (userId: string, accountId: string, messageId: string) => Promise<ConversationContextMessage>;
export interface ConversationOwnerInputs {
  prepare(input: { userId: string; accountId: string; acceptedBefore: Date; conversationId?: string }): Promise<void>;
  prepareGlobal(input: { userId: string; acceptedBefore: Date; conversationId?: string }): Promise<void>;
}

/** Claims commit before any memory, provider or model I/O; this consumer owns no mutation ports. */
export class DeliverConversationConsumer {
  constructor(private readonly store: ConsumerStore, private readonly model: ConversationModel,
    private readonly ownerInputs: ConversationOwnerInputs, private readonly memory: Pick<MailboxMemory, 'recall'> | undefined,
    private readonly readContext: ConversationContextReader) {}

  async consume(raw: unknown): Promise<void> {
    const payload = conversationRespondJobSchema.safeParse(raw);
    if (!payload.success) throw new Error('QUEUE_PAYLOAD_INVALID');
    const claim = await this.store.claim(payload.data.turnId, payload.data.userId);
    if (!claim) return;
    const abort = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lost = Promise.withResolvers<never>();
    const lose = (): void => {
      abort.abort(); lost.reject(new Error('CONVERSATION_LEASE_LOST'));
    };
    const schedule = (): void => {
      timer = setTimeout(() => {
        void this.store.renew(claim).then((renewed) => {
          if (!active) return;
          if (!renewed) lose(); else schedule();
        }, () => { if (active) lose(); });
      }, 30_000);
      timer.unref();
    };
    const phase: { stage: 'memory' | 'context' | 'model' | 'persistence' } = { stage: 'memory' };
    try {
      if (!await this.store.renew(claim)) return;
      schedule();
      const result = await Promise.race([lost.promise, (async () => {
        const conversation = claim.conversation;
        const messages = await this.store.recentMessages(claim, 20);
        let mailboxMemoryContext = '';
        let contextMessage: ConversationContextMessage | undefined;
        if (conversation.scope === 'mailbox') {
          if (!conversation.accountId) throw new Error('CONVERSATION_SCOPE_INVALID');
          if (!this.memory) throw new MailboxMemoryUnavailableError();
          await this.ownerInputs.prepare({ userId: conversation.userId, accountId: conversation.accountId,
            acceptedBefore: new Date(claim.claimedAt), conversationId: conversation.id });
          const recalled = await this.memory.recall({ scope: { userId: conversation.userId, mailboxId: conversation.accountId },
            query: claim.userMessage.content, maxTokens: 1_024 });
          const entries: string[] = [];
          let serializedLength = 2;
          for (const entry of recalled.entries) {
            if (entries.length === 20) break;
            const serialized = JSON.stringify(entry);
            const nextLength = serializedLength + serialized.length + (entries.length === 0 ? 0 : 1);
            if (nextLength > 8_000) break;
            entries.push(serialized);
            serializedLength = nextLength;
          }
          mailboxMemoryContext = `[${entries.join(',')}]`;
          if (conversation.contextMessageId) {
            phase.stage = 'context';
            contextMessage = await this.readContext(conversation.userId, conversation.accountId, conversation.contextMessageId);
            if (contextMessage.messageId !== conversation.contextMessageId) throw new Error('CONVERSATION_CONTEXT_INVALID');
          }
        } else {
          await this.ownerInputs.prepareGlobal({ userId: conversation.userId, acceptedBefore: new Date(claim.claimedAt), conversationId: conversation.id });
        }
        if (abort.signal.aborted) throw new Error('CONVERSATION_LEASE_LOST');
        phase.stage = 'model';
        const output = await this.model.generate({ conversation, messages, mailboxMemoryContext,
          ...(contextMessage ? { contextMessage } : {}), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]) });
        const reply = conversationReplySchema.safeParse(output);
        if (!reply.success) throw new Error('CONVERSATION_REPLY_INVALID');
        return reply.data.reply;
      })()]);
      phase.stage = 'persistence';
      if (!abort.signal.aborted && await this.store.renew(claim)) await this.store.complete(claim, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (phase.stage === 'persistence') throw error;
      if (phase.stage === 'memory' || error instanceof MailboxMemoryUnavailableError) {
        await this.store.fail(claim, { code: 'MAILBOX_MEMORY_UNAVAILABLE', temporary: true, memoryUnavailable: true });
      } else {
        const invalid = error instanceof Error && (error.message === 'CONVERSATION_REPLY_INVALID' || error.message === 'CONVERSATION_CONTEXT_INVALID');
        const status = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
        const unsupported = error instanceof Error && ['CODEX_CLI_UNSUPPORTED_TOOLS', 'CODEX_CLI_UNSUPPORTED_PROMPT'].includes(error.message);
        const permanent = invalid || unsupported || status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
        await this.store.fail(claim, { code: invalid && error instanceof Error ? error.message : phase.stage === 'context' ? 'CONVERSATION_CONTEXT_UNAVAILABLE'
          : permanent ? 'CONVERSATION_MODEL_REJECTED' : 'CONVERSATION_MODEL_UNAVAILABLE', temporary: !permanent });
      }
    } finally {
      active = false;
      abort.abort();
      clearTimeout(timer);
    }
  }
}

/** Replays only durable eligible turns, including expired leases, after global fan-out recovery. */
export class DurableConversationRecovery {
  constructor(private readonly store: Pick<ConversationStore, 'backfillGlobalMessages' | 'readyTurnIds'>,
    private readonly dispatcher: { enqueue(turnId: string, userId: string): Promise<void> }, private readonly batchSize = 100) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new RangeError('conversation recovery batch must be 1–1000');
  }
  async tick(): Promise<void> {
    await this.store.backfillGlobalMessages(this.batchSize);
    for (const turn of await this.store.readyTurnIds(this.batchSize)) await this.dispatcher.enqueue(turn.turnId, turn.userId);
  }
}
