import type { Conversation, ConversationMessagePage } from '@hypermail/contracts';
export type ConversationAuth = Readonly<{ subjectId: string; accountIds: readonly string[] }>;
export type ConversationMessages = ConversationMessagePage & { conversation: Conversation };
export class ConversationHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly currentVersion?: number, readonly currentAttempt?: number) { super(code); this.name = 'ConversationHttpError'; }
}
