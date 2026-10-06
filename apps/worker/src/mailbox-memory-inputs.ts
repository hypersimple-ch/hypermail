import { activityThreadId, conversationThreadId, MailboxMemoryUnavailableError, userResourceId, type SourceHistory } from '@hypermail/agent';
import type { ConversationStore, ManagedSqlClient, OwnerSourceCursor } from '@hypermail/db';

type Preparation = Readonly<{ userId: string; acceptedBefore: Date; conversationId?: string }>;

/** Rebuild attributable sources in their original threads, never from legacy observations. */
export class MailboxOwnerMemoryInputs {
  constructor(private readonly store: Pick<ConversationStore, 'hasPendingOwnerContext' | 'ownerSources'>,
    private readonly history: SourceHistory, private readonly database: Pick<ManagedSqlClient, 'withSession'>) {}

  async prepare(input: Preparation & Readonly<{ accountId: string }>): Promise<void> {
    await this.prepareOwner(input, input.accountId);
  }

  async prepareGlobal(input: Preparation): Promise<void> {
    await this.prepareOwner(input);
  }

  private async prepareOwner(input: Preparation, accountId?: string): Promise<void> {
    try {
      await this.database.withSession(async client => {
        // A session lock spans model I/O without keeping a database transaction open.
        const lock = `owner-memory:${input.userId}`;
        await client.query('select pg_advisory_lock(hashtextextended($1::text, 0))', [lock]);
        try {
          if (accountId !== undefined && await this.store.hasPendingOwnerContext({ userId: input.userId, accountId }, input.acceptedBefore)) {
            throw new MailboxMemoryUnavailableError();
          }
          const resourceId = userResourceId(input.userId);
          let cursor: OwnerSourceCursor | undefined;
          for (;;) {
            const sources = await this.store.ownerSources({ userId: input.userId }, input.acceptedBefore, cursor);
            for (const source of sources) {
              const threadId = source.conversationId !== null
                ? conversationThreadId(input.userId, source.conversationId)
                : source.activityId !== null && source.accountId !== null
                  ? activityThreadId(input.userId, source.accountId, source.activityId)
                  : `user:${input.userId}:owner-source:${source.id}:v3`;
              await this.history.append({ resourceId, threadId,
                text: JSON.stringify({ sourceId: source.id, provenance: 'user', scope: source.scope,
                  accountId: source.accountId, content: source.content, createdAt: source.createdAt }) });
              // Observe immediately: later corrections in other threads must be applied later.
              // The native engine skips messages already observed during deterministic replays.
              await this.history.observe({ resourceId, threadId });
            }
            const last = sources.at(-1);
            if (sources.length < 100 || !last) break;
            cursor = { createdAt: last.createdAt, sourceId: last.id };
          }
        } finally {
          await client.query('select pg_advisory_unlock(hashtextextended($1::text, 0))', [lock]);
        }
      });
    } catch {
      // SQL, delivery and observation failures defer generation without spending model retries.
      throw new MailboxMemoryUnavailableError();
    }
  }
}
