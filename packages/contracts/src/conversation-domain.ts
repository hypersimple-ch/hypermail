import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './domain.js';

export class ConversationCursorError extends Error {
  constructor() { super('Invalid conversation cursor.'); this.name = 'ConversationCursorError'; }
}
export const conversationContentSchema = z.string().max(16_000).refine((value) => value.trim().length > 0, 'Content must not be blank.');
export const conversationScopeSchema = z.enum(['mailbox', 'global']);
export const conversationCreateSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('mailbox'), accountId: idSchema, contextMessageId: idSchema.optional() }),
  z.strictObject({ scope: z.literal('global') }),
]);
export const conversationRetrySchema = z.strictObject({ expectedAttempt: z.number().int().nonnegative() });
export const conversationPostSchema = z.strictObject({ requestId: idSchema, expectedVersion: z.number().int().positive(), content: conversationContentSchema });
export const conversationReplySchema = z.strictObject({ reply: conversationContentSchema });
export const conversationSchema = z.strictObject({
  id: idSchema, userId: idSchema, scope: conversationScopeSchema, accountId: idSchema.nullable(), contextMessageId: idSchema.nullable(),
  version: z.number().int().positive(), createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema,
}).refine((value) => value.scope === 'mailbox' ? value.accountId !== null : value.accountId === null && value.contextMessageId === null, 'Conversation scope mismatch.');
export const conversationTurnSchema = z.strictObject({
  id: idSchema, userMessageId: idSchema, state: z.enum(['pending', 'running', 'completed', 'failed']), attempt: z.number().int().nonnegative(),
  availableAt: isoDateTimeSchema, errorCode: z.string().nullable(), claimExpiresAt: isoDateTimeSchema.nullable(),
}).refine((turn) => (turn.state === 'running') === (turn.claimExpiresAt !== null), 'Only a running turn has a lease expiry.');
export const conversationMessageSchema = z.strictObject({
  id: idSchema, conversationId: idSchema, sequence: z.number().int().positive(), role: z.enum(['user', 'assistant']), content: conversationContentSchema,
  requestId: idSchema.nullable(), replyTo: idSchema.nullable(), createdAt: isoDateTimeSchema, turn: conversationTurnSchema.nullable(),
});
export const conversationPageSchema = z.strictObject({ conversations: z.array(conversationSchema), nextCursor: z.string().nullable() });
export const conversationMessagePageSchema = z.strictObject({ messages: z.array(conversationMessageSchema), nextCursor: z.string().nullable() });
export const conversationListQuerySchema = z.strictObject({ scope: conversationScopeSchema, accountId: idSchema.optional(), cursor: z.string().max(2048).optional() })
  .refine((value) => value.scope !== 'global' || value.accountId === undefined, 'Global scope cannot select a mailbox.');
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;
export type MessagePost = z.infer<typeof conversationPostSchema>;
export type ConversationPage = { conversations: readonly Conversation[]; nextCursor: string | null };
export type ConversationMessagePage = { messages: readonly ConversationMessage[]; nextCursor: string | null };
export type ScopeAuth = { userId: string; accountIds: readonly string[] };
