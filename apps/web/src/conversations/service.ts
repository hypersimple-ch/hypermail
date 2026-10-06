import { z } from 'zod';
import { conversationCreateSchema, conversationListQuerySchema, conversationPostSchema, conversationRetrySchema } from '@hypermail/contracts';
import type { ConversationStore } from '@hypermail/db';
import { ConversationHttpError, type ConversationAuth, type ConversationMessages } from './contracts.js';

export class ConversationService {
  constructor(private readonly store: Pick<ConversationStore, 'create' | 'get' | 'list' | 'messages' | 'append' | 'retry'>) {}
  async create(auth: ConversationAuth, input: unknown) {
    const parsed = conversationCreateSchema.safeParse(input);
    if (!parsed.success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    const conversation = await this.store.create({ userId: auth.subjectId, accountIds: auth.accountIds }, parsed.data);
    if (!conversation) throw new ConversationHttpError(404, 'NOT_FOUND');
    return { conversation };
  }
  async list(auth: ConversationAuth, query: unknown) {
    const parsed = conversationListQuerySchema.safeParse(query);
    if (!parsed.success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    if (parsed.data.accountId && !auth.accountIds.includes(parsed.data.accountId)) throw new ConversationHttpError(404, 'NOT_FOUND');
    return this.store.list({ userId: auth.subjectId, accountIds: auth.accountIds }, parsed.data);
  }
  async messages(auth: ConversationAuth, id: string, query: unknown): Promise<ConversationMessages> {
    if (!z.uuid().safeParse(id).success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    const parsed = z.strictObject({ cursor: z.string().max(2048).optional() }).safeParse(query);
    if (!parsed.success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    const scope = { userId: auth.subjectId, accountIds: auth.accountIds };
    const conversation = await this.store.get(scope, id);
    if (!conversation) throw new ConversationHttpError(404, 'NOT_FOUND');
    const page = await this.store.messages(scope, id, parsed.data.cursor);
    if (!page) throw new ConversationHttpError(404, 'NOT_FOUND');
    return { ...page, conversation };
  }
  async post(auth: ConversationAuth, id: string, input: unknown) {
    const parsed = conversationPostSchema.safeParse(input);
    if (!z.uuid().safeParse(id).success || !parsed.success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    const result = await this.store.append({ userId: auth.subjectId, accountIds: auth.accountIds }, id, parsed.data);
    if (result.kind === 'not_found') throw new ConversationHttpError(404, 'NOT_FOUND');
    if (result.kind === 'conflict') throw new ConversationHttpError(409, 'CONFLICT', result.currentVersion);
    const { conversation, message, turn, replayed } = result;
    return { conversation, message, turn, replayed };
  }
  async retry(auth: ConversationAuth, id: string, turnId: string, input: unknown) {
    const parsed = conversationRetrySchema.safeParse(input);
    if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(turnId).success || !parsed.success) throw new ConversationHttpError(400, 'BAD_REQUEST');
    const result = await this.store.retry({ userId: auth.subjectId, accountIds: auth.accountIds }, id, turnId, parsed.data.expectedAttempt);
    if (result.kind === 'not_found') throw new ConversationHttpError(404, 'NOT_FOUND');
    if (result.kind === 'conflict') throw new ConversationHttpError(409, 'CONFLICT', undefined, result.currentAttempt);
    return { turn: result.turn };
  }
}
