import { MailboxMemoryUnavailableError, userResourceId, type SourceHistory } from '@hypermail/agent';
import type { ConversationStore } from '@hypermail/db';

/** Rebuild only attributable owner sources; opaque legacy observations are never read. */
export class MailboxOwnerMemoryInputs {
  constructor(private readonly store: Pick<ConversationStore, 'hasPendingOwnerContext' | 'ownerSources' | 'globalOwnerSources'>,
    private readonly history: SourceHistory) {}

  async prepare(input: Readonly<{ userId: string; accountId: string; acceptedBefore: Date }>): Promise<void> {
    try {
      const scope = { userId: input.userId, accountId: input.accountId };
      if (await this.store.hasPendingOwnerContext(scope, input.acceptedBefore)) throw new MailboxMemoryUnavailableError();
      const sources = await this.store.ownerSources(scope, input.acceptedBefore, 20);
      const resourceId = userResourceId(input.userId, { scope: 'mailbox', accountId: input.accountId });
      for (const source of sources) {
        await this.history.append({ resourceId, threadId: `${resourceId}:owner-source:${source.id}`,
          text: JSON.stringify({ sourceId: source.id, provenance: 'user', scope: source.scope,
            content: source.content, createdAt: source.createdAt }) });
      }
    } catch {
      // SQL, delivery and Mastra failures all block generation without spending model retries.
      throw new MailboxMemoryUnavailableError();
    }
  }

  async prepareGlobal(input: Readonly<{ userId: string; acceptedBefore: Date }>): Promise<void> {
    try {
      const sources = await this.store.globalOwnerSources(input.userId, input.acceptedBefore, 20);
      const resourceId = userResourceId(input.userId, { scope: 'global' });
      for (const source of sources) {
        await this.history.append({ resourceId, threadId: `${resourceId}:owner-source:${source.id}`,
          text: JSON.stringify({ sourceId: source.id, provenance: 'user', scope: source.scope,
            content: source.content, createdAt: source.createdAt }) });
      }
    } catch {
      throw new MailboxMemoryUnavailableError();
    }
  }
}
