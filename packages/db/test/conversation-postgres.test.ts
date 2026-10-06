import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ConversationCursorError, type ScopeAuth } from '@hypermail/contracts';
import { ConversationStore, createPostgresClient, PostgresMailboxMemoryEventStore, type ConversationAppendResult, type ConversationClaim, type OwnerMemorySource, type OwnerSourceCursor } from '../src/index.js';
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
        expect(aSources.map((source) => source.id)).toEqual([ownerA.message.id, accepted(appends.find((result) => result.kind === 'accepted') as ConversationAppendResult).message.id].map(id => `conversation_message:${id}`));
        expect(aSources.every((source) => source.scope === 'mailbox' && source.accountId === accountA && source.conversationId === a.id)).toBe(true);
        expect(await first.ownerSources({ userId, accountId: accountB }, ownerCutoff)).toEqual([expect.objectContaining({
          id: `conversation_message:${ownerB.message.id}`, scope: 'mailbox', accountId: accountB, conversationId: b.id, activityId: null, content: 'Private B instruction',
        })]);

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

  it.skipIf(!databaseUrl)('paginates exact timestamps and colliding canonical UUIDs without mixing owners or source scopes', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async (sql) => {
      const userId = await seedOwner(sql); const otherId = await seedOwner(sql);
      const accountId = await seedBox(sql, userId); const secondBox = await seedBox(sql, userId); const foreignBox = await seedBox(sql, otherId);
      const client = createPostgresClient(databaseUrl ?? ''); const store = new ConversationStore(client);
      const cutoff = new Date('2026-01-02T00:00:00Z');
      const timestamp = '2026-01-01T00:00:00.000001Z'; const collisionId = randomUUID();
      try {
        const global = await store.create({ userId, accountIds: [accountId, secondBox] }, { scope: 'global' });
        const local = await store.create({ userId, accountIds: [accountId, secondBox] }, { scope: 'mailbox', accountId: secondBox });
        const foreign = await store.create({ userId: otherId, accountIds: [foreignBox] }, { scope: 'global' });
        if (!global || !local || !foreign) throw new Error('Expected fixture conversations.');
        const ids: string[] = [];
        for (let sequence = 1; sequence <= 102; sequence++) {
          const id = sequence === 1 ? collisionId : randomUUID(); ids.push(`conversation_message:${id}`);
          const createdAt = sequence <= 100 ? timestamp : sequence === 101 ? '2026-01-01T00:00:00.000002Z' : '2026-01-01T00:00:00.000999Z';
          await sql`insert into app.agent_conversation_messages(id,conversation_id,user_id,sequence,role,content,request_id,request_digest,created_at)
            values(${id},${global.id},${userId},${sequence},'user',${`General preference ${String(sequence)}`},${randomUUID()},${'a'.repeat(64)},${createdAt}::text::timestamptz)`;
        }
        for (const conversation of [local, foreign]) await sql`insert into app.agent_conversation_messages(conversation_id,user_id,sequence,role,content,request_id,request_digest,created_at)
          values(${conversation.id},${conversation.userId},1,'user',${conversation.id === local.id ? 'Second mailbox preference' : 'Foreign preference'},${randomUUID()},${'a'.repeat(64)},${timestamp}::text::timestamptz)`;
        const messageId = randomUUID(), activityId = randomUUID(), decisionId = randomUUID(), runId = randomUUID(), assignmentId = randomUUID(), grantId = randomUUID(), proposalId = randomUUID();
        await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,subject,preview,received_at)
          values(${messageId},${accountId},${messageId},'{"address":"sender@example.test"}','[]','Never a preference','Received email is not owner input',now())`;
        await sql`insert into app.activities(id,account_id,message_id,state) values(${activityId},${accountId},${messageId},'waiting_question')`;
        await sql`insert into app.agent_activities(id,user_id,account_id,kind,source_message_id,correlation_id)
          values(${activityId},${userId},${accountId},'arrival',${messageId},${`arrival:${activityId}`})`;
        await sql`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${userId},${accountId},'mastra',true)`;
        await sql`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at)
          values(${grantId},${userId},${accountId},'mastra',array['mail.archive'],array['automatic'],'active',now())`;
        await sql`insert into app.agent_runs(id,activity_id,user_id,account_id,sequence,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,correlation_id,state,started_at,completed_at,outcome)
          values(${runId},${activityId},${userId},${accountId},1,'mastra',${assignmentId},1,${grantId},1,1,'automatic',${sql.json({ kind: 'arrival', messageId })},${'a'.repeat(64)},${`run:${runId}`},'completed',now(),now(),'action_requests_emitted')`;
        await sql`insert into app.decisions(id,activity_id,user_id,account_id,run_id,schema_version,attempt,state,rationale,model_provider,model_name,input_digest,output)
          values(${decisionId},${activityId},${userId},${accountId},${runId},2,1,'question','ask','fixture','fixture',${'a'.repeat(64)},${sql.json({ schemaVersion: 2, state: 'question', rationale: 'ask', question: 'What tone?' })})`;
        await sql`insert into app.questions(id,activity_id,decision_id,prompt,state,answer,answered_at)
          values(${collisionId},${activityId},${decisionId},'What tone?','answered','Use a calm tone',${timestamp}::text::timestamptz)`;
        const payload = { kind: 'archive', target: { accountId, messageId }, reason: 'fixture', key: 'archive', confidence: 0.6, evidenceIds: [], dependsOn: [] };
        await sql`insert into app.agent_action_proposals(id,user_id,account_id,activity_id,run_id,decision_id,action_key,origin,kind,payload,confidence,threshold,evidence_snapshot,state)
          values(${proposalId},${userId},${accountId},${activityId},${runId},${decisionId},'archive','model','archive',${sql.json(payload)},0.6,0.9,'[]','waiting_review')`;
        await sql`insert into app.agent_action_reviews(id,proposal_id,user_id,account_id,decision,idempotency_key,request_digest,reason,created_at)
          values(${collisionId},${proposalId},${userId},${accountId},'reject',${randomUUID()},${'a'.repeat(64)},'Explain briefly',${timestamp}::text::timestamptz)`;
        const foreignMessageId = randomUUID(), foreignActivityId = randomUUID(), foreignDecisionId = randomUUID();
        await sql`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at)
          values(${foreignMessageId},${foreignBox},${foreignMessageId},'{"address":"sender@example.test"}','[]',now())`;
        await sql`insert into app.activities(id,account_id,message_id,state) values(${foreignActivityId},${foreignBox},${foreignMessageId},'waiting_question')`;
        await sql`insert into app.decisions(id,activity_id,user_id,account_id,schema_version,attempt,state,rationale,model_provider,model_name,input_digest,output)
          values(${foreignDecisionId},${foreignActivityId},${otherId},${foreignBox},1,1,'question','ask','fixture','fixture',${'a'.repeat(64)},'{}')`;
        await sql`insert into app.questions(activity_id,decision_id,prompt,state,answer,answered_at)
          values(${foreignActivityId},${foreignDecisionId},'What tone?','answered','Foreign answer',${timestamp}::text::timestamptz)`;

        const all: OwnerMemorySource[] = [];
        let cursor: OwnerSourceCursor | undefined;
        const pageSizes: number[] = [];
        for (;;) {
          const page = await store.ownerSources({ userId }, cutoff, cursor); pageSizes.push(page.length);
          if (page.length === 0) break;
          all.push(...page); const last = page.at(-1);
          if (!last) throw new Error('Expected a nonempty source page.');
          cursor = { createdAt: last.createdAt, sourceId: last.id };
        }
        expect(pageSizes).toEqual([100, 5, 0]);
        expect(all.map(source => source.id).filter(id => ids.includes(id)).sort()).toEqual([...ids].sort());
        expect(new Set(all.map(source => source.id)).size).toBe(105);
        expect(all.filter(source => source.id.endsWith(collisionId))).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `conversation_message:${collisionId}`, conversationId: global.id, accountId: null, activityId: null }),
          expect.objectContaining({ id: `question_answer:${collisionId}`, activityId, accountId, conversationId: null, content: 'Use a calm tone' }),
          expect.objectContaining({ id: `action_review:${collisionId}`, activityId, accountId, conversationId: null, content: 'Owner review: reject\nOwner explanation: Explain briefly' }),
        ]));
        expect(all.slice(-2).map(source => source.createdAt)).toEqual(['2026-01-01T00:00:00.000002Z', '2026-01-01T00:00:00.000999Z']);
        expect(all.some(source => source.content === 'Foreign preference' || source.content === 'Foreign answer' || source.content === 'Received email is not owner input')).toBe(false);
        const globalFirst = await store.globalOwnerSources(userId, cutoff);
        const lastGlobal = globalFirst.at(-1);
        if (!lastGlobal) throw new Error('Expected global owner sources.');
        const globalNext = await store.globalOwnerSources(userId, cutoff, { createdAt: lastGlobal.createdAt, sourceId: lastGlobal.id });
        expect([...globalFirst, ...globalNext].map(source => source.id).sort()).toEqual([...ids].sort());
        expect([...globalFirst, ...globalNext].every(source => source.scope === 'global' && source.accountId === null)).toBe(true);
        expect((await store.ownerSources({ userId: otherId }, cutoff)).map(source => source.content).sort()).toEqual(['Foreign answer', 'Foreign preference']);
        expect((await store.ownerSources({ userId, accountId: foreignBox }, cutoff)).every(source => source.scope === 'global')).toBe(true);
        expect((await store.ownerSources({ userId, accountId }, cutoff)).some(source => source.content === 'Second mailbox preference')).toBe(false);
        expect(await store.ownerSources({ userId }, new Date('2025-12-31T23:59:59Z'))).toEqual([]);
      } finally { await client.close(); }
    });
  }, 60_000);

  it.skipIf(!databaseUrl)('keeps reserved sessions outside transactions and releases them after rejected callbacks', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async () => {
      const client = createPostgresClient(databaseUrl ?? '');
      try {
        for (let attempt = 0; attempt < 12; attempt++) {
          await expect(client.withSession(async session => {
            const before = (await session.query('select pg_backend_pid() as pid,txid_current_if_assigned() as transaction_id')).rows[0];
            expect(before?.['transaction_id']).toBeNull();
            await session.query('create temporary table session_probe(value integer)');
            await session.query('insert into session_probe values(1)');
            const after = (await session.query('select pg_backend_pid() as pid,txid_current_if_assigned() as transaction_id,(select sum(value)::integer from session_probe) as value')).rows[0];
            expect(after).toEqual({ pid: before?.['pid'], transaction_id: null, value: 1 });
            await session.query('drop table session_probe');
            throw new Error('Rejected session callback');
          })).rejects.toThrow('Rejected session callback');
        }
        expect(await client.withSession(async session => (await session.query('select 42 as answer')).rows[0]?.['answer'])).toBe(42);
      } finally { await client.close(); }
    });
  }, 30_000);
});
