import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ConversationCursorError, type ScopeAuth } from '@hypermail/contracts';
import { ConversationStore, createPostgresClient, PostgresMailboxMemoryEventStore, type ConversationAppendResult, type ConversationClaim } from '../src/index.js';
import { withPostgresSchemas } from '../../../apps/worker/test/postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
async function seedOwner(sql: Sql) {
  const userId = randomUUID();
  await sql`insert into app.users(id,email,password_hash) values(${userId},${`${userId}@example.test`},'hash')`;
  return userId;
}
async function seedBox(sql: Sql, userId: string) {
  const accountId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state)
      values(${accountId},${userId},'microsoft',${accountId},${`${accountId}@example.test`},'ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${userId},${accountId})`;
  });
  return accountId;
}
function accepted(result: ConversationAppendResult) {
  if (result.kind !== 'accepted') throw new Error('Expected an accepted owner message.');
  return result;
}
function claimed(result: ConversationClaim | null) {
  if (!result) throw new Error('Expected a conversation lease.');
  return result;
}
// Only manipulate wall-clock fixture fields in the destructive, advisory-locked disposable schema.
async function advanceTurnClock(sql: Sql, turnId: string, expiredLease = false) {
  await sql.begin(async (tx) => {
    await tx`alter table app.agent_conversation_turns disable trigger conversation_turn_guard`;
    if (expiredLease) await tx`update app.agent_conversation_turns set claim_expires_at=now()-interval '1 second' where id=${turnId}`;
    else await tx`update app.agent_conversation_turns set available_at=now()-interval '1 second' where id=${turnId}`;
    await tx`set constraints all immediate`;
    await tx`alter table app.agent_conversation_turns enable trigger conversation_turn_guard`;
  });
}

describe('Durable conversations PostgreSQL', () => {
  it.skipIf(!databaseUrl)('fences concurrent writes, reclaims leases, retries only the original source, and isolates memory scopes', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async (sql) => {
      const userId = await seedOwner(sql); const otherId = await seedOwner(sql);
      const accountA = await seedBox(sql, userId); const accountB = await seedBox(sql, userId); const otherBox = await seedBox(sql, otherId);
      const scope: ScopeAuth = { userId, accountIds: [accountA, accountB] };
      const other: ScopeAuth = { userId: otherId, accountIds: [otherBox] };
      const firstClient = createPostgresClient(databaseUrl ?? ''); const secondClient = createPostgresClient(databaseUrl ?? '');
      const first = new ConversationStore(firstClient); const second = new ConversationStore(secondClient);
      try {
        const a = await first.create(scope, { scope: 'mailbox', accountId: accountA });
        const b = await first.create(scope, { scope: 'mailbox', accountId: accountB });
        const global = await first.create(scope, { scope: 'global' });
        if (!a || !b || !global) throw new Error('Expected owned conversations.');
        expect(await first.create(scope, { scope: 'mailbox', accountId: otherBox })).toBeNull();
        expect(await first.create(scope, { scope: 'mailbox', accountId: accountA, contextMessageId: randomUUID() })).toBeNull();
        const contextB = randomUUID();
        await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,preview,received_at)
          values(${contextB},${accountB},${contextB},${sql.json({ address: 'sender@example.test' })},${sql.json([])},'context','preview',now())`;
        expect(await first.create(scope, { scope: 'mailbox', accountId: accountA, contextMessageId: contextB })).toBeNull();
        expect(await first.create(scope, { scope: 'mailbox', accountId: accountB, contextMessageId: contextB })).toMatchObject({ scope: 'mailbox', accountId: accountB, contextMessageId: contextB });
        expect(await first.messages(other, a.id)).toBeNull();
        expect(await first.append(other, a.id, { requestId: randomUUID(), expectedVersion: 1, content: 'forbidden' })).toEqual({ kind: 'not_found' });
        await expect(first.create(scope, { scope: 'global', contextMessageId: randomUUID() } as never)).rejects.toThrow();

        const request = { requestId: randomUUID(), expectedVersion: 1, content: '  Private A instruction  ' };
        const duplicates = await Promise.all([first.append(scope, a.id, request), second.append(scope, a.id, request)]);
        const ownerA = accepted(duplicates[0]);
        expect(duplicates.map((result) => accepted(result).message.id)).toEqual([ownerA.message.id, ownerA.message.id]);
        expect(duplicates.filter((result) => accepted(result).replayed)).toHaveLength(1);
        expect(ownerA.message.content).toBe(request.content);
        expect(await first.append(scope, a.id, { ...request, content: 'different' })).toEqual({ kind: 'conflict', currentVersion: 2 });
        expect(await first.append(scope, b.id, request)).toEqual({ kind: 'conflict', currentVersion: 1 });
        const appends = await Promise.all([
          first.append(scope, a.id, { requestId: randomUUID(), expectedVersion: 2, content: 'next A' }),
          second.append(scope, a.id, { requestId: randomUUID(), expectedVersion: 2, content: 'other next A' }),
        ]);
        expect(appends.filter((result) => result.kind === 'accepted')).toHaveLength(1);
        expect(appends.filter((result) => result.kind === 'conflict')).toHaveLength(1);
        const ownerB = accepted(await first.append(scope, b.id, { requestId: randomUUID(), expectedVersion: 1, content: 'Private B instruction' }));

        const claims = await Promise.all([first.claim(ownerA.turn.id, userId), second.claim(ownerA.turn.id, userId)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const oldClaim = claimed(claims.find(Boolean) ?? null);
        expect(await first.claim(ownerB.turn.id, otherId)).toBeNull();
        expect((await first.recentMessages(oldClaim)).map((message) => message.id)).toEqual([ownerA.message.id]);
        await advanceTurnClock(sql, ownerA.turn.id, true);
        const newClaim = claimed(await second.claim(ownerA.turn.id, userId));
        expect(newClaim.turn.attempt).toBe(2);
        expect(await first.renew(oldClaim)).toBe(false);
        expect(await first.complete(oldClaim, 'stale reply')).toBe(false);
        expect(await first.fail(oldClaim, { code: 'MODEL_TEMPORARY', temporary: true })).toBe(false);
        expect(await second.complete(newClaim, 'A unique assistant reply')).toBe(true);
        expect(await first.complete(newClaim, 'duplicate reply')).toBe(false);
        expect(await sql`select content from app.agent_conversation_messages where reply_to=${ownerA.message.id}`).toEqual([{ content: 'A unique assistant reply' }]);
        const ownerCutoff = new Date(Date.now() + 1000);
        const aSources = await first.ownerSources({ userId, accountId: accountA }, ownerCutoff);
        expect(aSources.map((source) => source.id)).toEqual([ownerA.message.id, accepted(appends.find((result) => result.kind === 'accepted') as ConversationAppendResult).message.id]);
        expect(aSources.every((source) => source.scope === 'mailbox')).toBe(true);
        expect(await first.ownerSources({ userId, accountId: accountB }, ownerCutoff)).toEqual([{ id: ownerB.message.id, scope: 'mailbox', content: 'Private B instruction', createdAt: ownerB.message.createdAt }]);

        let retryClaim = claimed(await first.claim(ownerB.turn.id, userId));
        for (let index = 0; index < 4; index++) {
          expect(await first.fail(retryClaim, { code: 'MEMORY_UNAVAILABLE', temporary: true, memoryUnavailable: true })).toBe(true);
          expect(await sql`select state,model_failure_count from app.agent_conversation_turns where id=${ownerB.turn.id}`).toEqual([{ state: 'pending', model_failure_count: 0 }]);
          await advanceTurnClock(sql, ownerB.turn.id);
          retryClaim = claimed(await first.claim(ownerB.turn.id, userId));
        }
        for (let index = 0; index < 3; index++) {
          expect(await first.fail(retryClaim, { code: 'MODEL_TEMPORARY', temporary: true })).toBe(true);
          const [turn] = await sql`select state,model_failure_count,extract(epoch from available_at-updated_at)::float as delay from app.agent_conversation_turns where id=${ownerB.turn.id}`;
          expect(turn?.['state']).toBe(index === 2 ? 'failed' : 'pending');
          expect(turn?.['model_failure_count']).toBe(index + 1);
          expect(turn?.['delay']).toBeCloseTo([5, 30, 120][index] as number, 0);
          if (index < 2) { await advanceTurnClock(sql, ownerB.turn.id); retryClaim = claimed(await first.claim(ownerB.turn.id, userId)); }
        }
        const [failedBefore] = await sql<{ available_at: Date }[]>`select available_at from app.agent_conversation_turns where id=${ownerB.turn.id}`;
        if (!failedBefore) throw new Error('Missing failed conversation turn');
        expect(await first.retry(scope, b.id, ownerB.turn.id, retryClaim.turn.attempt - 1)).toEqual({ kind: 'conflict', currentAttempt: retryClaim.turn.attempt });
        expect(await first.retry(other, b.id, ownerB.turn.id, retryClaim.turn.attempt)).toEqual({ kind: 'not_found' });
        expect(await first.retry(scope, b.id, ownerB.turn.id, retryClaim.turn.attempt)).toMatchObject({ kind: 'queued', turn: { userMessageId: ownerB.message.id } });
        expect(await sql`select available_at,model_failure_count from app.agent_conversation_turns where id=${ownerB.turn.id}`).toEqual([{ available_at: failedBefore.available_at, model_failure_count: 0 }]);
        expect(await sql`select count(*)::integer as count from app.mailbox_memory_events where source_id=${ownerB.message.id}`).toEqual([{ count: 1 }]);
        expect(await sql`select count(*)::integer as count from app.agent_conversation_messages where conversation_id=${b.id} and role='user'`).toEqual([{ count: 1 }]);
        expect(await first.claim(ownerB.turn.id, userId)).toBeNull();
        await advanceTurnClock(sql, ownerB.turn.id);
        const permanentClaim = claimed(await first.claim(ownerB.turn.id, userId));
        expect(await first.fail(permanentClaim, { code: 'INVALID_MODEL_REPLY', temporary: false })).toBe(true);
        expect(await sql`select state,model_failure_count from app.agent_conversation_turns where id=${ownerB.turn.id}`).toEqual([{ state: 'failed', model_failure_count: 1 }]);
        expect((await first.readyTurnIds()).some((turn) => turn.turnId === ownerB.turn.id)).toBe(false);

        let version = global.version; const globalIds: string[] = [];
        for (let index = 0; index < 101; index++) {
          const result = accepted(await first.append(scope, global.id, { requestId: randomUUID(), expectedVersion: version, content: `Global instruction ${String(index)}` }));
          version = result.conversation.version; globalIds.push(result.message.id);
        }
        const globalFirst = globalIds[0] as string;
        expect(await sql`select account_id,content_payload->>'scope' as scope from app.mailbox_memory_events where source_id=${globalFirst} order by account_id`)
          .toEqual([accountA, accountB].sort().map((account_id) => ({ account_id, scope: 'global' })));
        const accountC = await seedBox(sql, userId);
        expect(await first.hasPendingOwnerContext({ userId, accountId: accountC }, new Date())).toBe(true);
        expect(await first.backfillGlobalMessages()).toBe(100);
        expect(await sql`select count(*)::integer as count from app.mailbox_memory_events where account_id=${accountC}`).toEqual([{ count: 100 }]);
        expect(await first.backfillGlobalMessages()).toBe(1);
        expect(await first.backfillGlobalMessages()).toBe(0);
        expect(await sql`select count(*)::integer as count from app.mailbox_memory_events where account_id=${accountC} and source_id in (${ownerA.message.id},${ownerB.message.id})`).toEqual([{ count: 0 }]);
        expect(await sql`select count(*)::integer as count from app.mailbox_memory_events where source_id in (select id from app.agent_conversation_messages where role='assistant')`).toEqual([{ count: 0 }]);
        expect(await sql`select completed_at is not null as completed,last_message_id from app.agent_global_memory_backfills where account_id=${accountC}`)
          .toEqual([{ completed: true, last_message_id: globalIds.at(-1) }]);
        const beforeGlobals = new Date(0);
        expect(await first.hasPendingOwnerContext({ userId, accountId: accountC }, beforeGlobals)).toBe(false);
        const memory = new PostgresMailboxMemoryEventStore(firstClient, { retryBaseDelaySeconds: 5, retryMaximumDelaySeconds: 900, claimLeaseSeconds: 60, schedulerIntervalSeconds: 5 });
        for (;;) {
          const batch = await memory.claim({ workerId: 'conversation-regression', limit: 100 });
          if (batch.length === 0) break;
          for (const event of batch) await memory.complete(event.fence);
        }
        expect(await first.hasPendingOwnerContext({ userId, accountId: accountC }, new Date())).toBe(false);
        const sources = await first.ownerSources({ userId, accountId: accountA }, new Date());
        expect(sources.every((source) => source.content !== 'Private B instruction' && source.content !== 'A unique assistant reply')).toBe(true);
        expect((await first.ownerSources({ userId, accountId: accountC }, new Date())).every((source) => source.scope === 'global')).toBe(true);

        const page = await first.messages(scope, global.id);
        expect(page?.messages.map((message) => message.id)).toEqual(globalIds.slice(0, 50));
        const next = await first.messages(scope, global.id, page?.nextCursor ?? undefined);
        expect(next?.messages.map((message) => message.id)).toEqual(globalIds.slice(50, 100));
        await expect(first.messages(scope, a.id, page?.nextCursor ?? undefined)).rejects.toBeInstanceOf(ConversationCursorError);
        await expect(first.messages(other, global.id, page?.nextCursor ?? undefined)).rejects.toBeInstanceOf(ConversationCursorError);
        await expect(first.list(scope, { scope: 'global', accountId: accountA })).rejects.toBeInstanceOf(ConversationCursorError);
        await expect(first.messages(scope, global.id, '!!!')).rejects.toBeInstanceOf(ConversationCursorError);
        await sql`insert into app.agent_conversations(user_id,scope) select ${userId},'global' from generate_series(1,51)`;
        const conversations = await first.list(scope, { scope: 'global' });
        const following = await first.list(scope, { scope: 'global', cursor: conversations.nextCursor ?? undefined });
        expect(new Set([...conversations.conversations, ...following.conversations].map((conversation) => conversation.id)).size).toBe(52);
        expect(following.conversations).toHaveLength(2);
        await expect(first.list(scope, { scope: 'mailbox', cursor: conversations.nextCursor ?? undefined })).rejects.toBeInstanceOf(ConversationCursorError);
        const accountD = await seedBox(sql, userId);
        await sql`update app.accounts set state='pending' where id=${accountD}`;
        const inactiveScope = { userId, accountIds: [...scope.accountIds, accountD] };
        const inactive = await first.create(inactiveScope, { scope: 'mailbox', accountId: accountD });
        if (!inactive) throw new Error('Expected an owned inactive mailbox conversation.');
        const fullControlContent = '\u0001'.repeat(16_000);
        const inactiveMessage = accepted(await first.append(inactiveScope, inactive.id, { requestId: randomUUID(), expectedVersion: 1, content: fullControlContent }));
        expect(inactiveMessage.message.content).toBe(fullControlContent);
        expect((await first.messages(inactiveScope, inactive.id))?.messages[0]?.content).toBe(fullControlContent);
        const [projected] = await sql`select state,content_payload,octet_length(content_payload::text) as bytes from app.mailbox_memory_events where source_id=${inactiveMessage.message.id}`;
        expect(projected?.['state']).toBe('pending');
        expect(projected?.['bytes']).toBeLessThanOrEqual(65_536);
        expect(projected?.['content_payload']).toMatchObject({ scope: 'mailbox', content: '\u0001'.repeat(8000), contentTruncated: true, contentDigest: createHash('sha256').update(fullControlContent).digest('hex') });
        expect(await first.hasPendingOwnerContext({ userId, accountId: accountD }, new Date())).toBe(true);
        expect((await memory.claim({ workerId: 'inactive-mailbox', limit: 100 })).some((event) => event.event.mailboxId === accountD)).toBe(false);
        await sql`update app.accounts set state='ready' where id=${accountD}`;
        const resumed = (await memory.claim({ workerId: 'reconnected-mailbox', limit: 100 })).find((event) => event.event.sourceId === inactiveMessage.message.id);
        if (!resumed) throw new Error('Expected the persisted owner event after mailbox reconnection.');
        await memory.complete(resumed.fence);
        // Global sources still require their explicit future-mailbox backfill; local delivery is already complete.
        expect(await first.hasPendingOwnerContext({ userId, accountId: accountD }, new Date())).toBe(true);
      } finally { await Promise.all([firstClient.close(), secondClient.close()]); }
    });
  }, 60_000);
});
