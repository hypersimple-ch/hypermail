/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  AgentWorkStore, PostgresMailboxMemoryEventStore, createPostgresClient,
} from '@hypermail/db';
import {
  TriageService, activityThreadId, userResourceId, type DecisionPersistence, type MailboxMemory,
  type SourceHistory, type TriageInput,
} from '@hypermail/agent';
import { PostgresDraftRepository, type DraftScope } from '../../web/src/drafts/index.js';
import { PostgresAgentRepository } from '../../web/src/agent/index.js';
import { PostgresIngestionStore, type SqlClient as IngestionSqlClient } from '../src/postgres-store.js';
import {
  MailboxCurrentEmailRetainer, MailboxMemoryEventDeliveryWorker,
  PostgresMailboxMemoryMessageHydrator,
} from '../src/mailbox-memory-delivery.js';
import { mailboxBankId } from '../src/hindsight-memory.js';
import { permanentlyDeleteMailboxMemory } from '../src/mailbox-memory-deletion.js';
import { withPostgresSchemas } from './postgres-test.js';

const databaseUrl = process.env.DATABASE_URL;
const timing = { retryBaseDelaySeconds: 1, retryMaximumDelaySeconds: 2, claimLeaseSeconds: 10, schedulerIntervalSeconds: 1 };
const at = (minute: number) => `2025-09-01T12:${String(minute).padStart(2, '0')}:00.000Z`;

const ingestionClient = (sql: Sql): IngestionSqlClient => ({
  query: async <Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) =>
    ({ rows: [...await sql.unsafe<Row[]>(statement, [...values] as never[])] }),
  transaction: <T>(operation: (client: IngestionSqlClient) => Promise<T>) => sql.begin((tx) => operation(ingestionClient(tx))),
});

class FakeHindsight implements MailboxMemory {
  readonly calls: string[] = [];
  readonly documents = new Map<string, Map<string, string>>();
  readonly files = new Map<string, string[]>();
  readonly deleted = new Set<string>();
  unavailable = true;

  private bank(scope: { userId: string; mailboxId: string }): string { return mailboxBankId(scope); }
  async retain(input: Parameters<MailboxMemory['retain']>[0]): Promise<void> {
    const bank = this.bank(input.scope); this.calls.push(`retain:${bank}:${input.eventId}`);
    if (this.unavailable) { this.unavailable = false; throw new Error('bounded fake Hindsight outage'); }
    const documents = this.documents.get(bank) ?? new Map<string, string>();
    documents.set(input.eventId, input.text); this.documents.set(bank, documents); this.deleted.delete(bank);
  }
  async recall(input: Parameters<MailboxMemory['recall']>[0]): ReturnType<MailboxMemory['recall']> {
    const bank = this.bank(input.scope); this.calls.push(`recall:${bank}`);
    return { entries: [...(this.documents.get(bank)?.values() ?? [])].map((text) => ({ text })) };
  }
  async retainFile(input: Parameters<MailboxMemory['retainFile']>[0]): Promise<void> {
    const bank = this.bank(input.scope); this.calls.push(`file:${bank}:${input.filename}:${String(input.file.size)}`);
    this.files.set(bank, [...(this.files.get(bank) ?? []), input.filename]);
  }
  async deleteMailbox(scope: Parameters<MailboxMemory['deleteMailbox']>[0]): Promise<void> {
    const bank = this.bank(scope); this.calls.push(`delete:${bank}`); this.documents.delete(bank); this.files.delete(bank); this.deleted.add(bank);
  }
  readiness(): Promise<{ version: string }> { return Promise.resolve({ version: 'fake-0.9.1' }); }
}

async function seedOwners(sql: Sql) {
  const user = randomUUID(); const otherUser = randomUUID();
  const primary = randomUUID(); const sibling = randomUUID(); const lookalike = randomUUID();
  await sql.begin(async (tx) => {
    for (const [id, email] of [[user, `owner-${user}@example.test`], [otherUser, `owner-${otherUser}@example.test`]] as const)
      await tx`insert into app.users(id,email,password_hash) values(${id},${email},'hash')`;
    for (const [owner, account, email] of [
      [user, primary, 'primary@example.test'], [user, sibling, 'same-looking@example.test'],
      [otherUser, lookalike, 'same-looking@example.test'],
    ] as const) {
      await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state,baseline_completed_at)
        values(${account},${owner},'gmail',${`provider-${account}`},${email},'ready',${at(0)})`;
      await tx`insert into app.user_accounts(user_id,account_id) values(${owner},${account})`;
    }
  });
  return { user, otherUser, primary, sibling, lookalike };
}

// One serial test is deliberate: it proves transaction and restart boundaries against one migrated schema.
describe('hardened Mailbox memory lifecycle PostgreSQL acceptance', () => {
  it.skipIf(!databaseUrl)('isolates banks and converges through arrival, learning, recovery, reconnect, and deletion', async () => {
    await withPostgresSchemas(databaseUrl ?? '', async (sql) => {
      const ids = await seedOwners(sql);
      const database = createPostgresClient(databaseUrl ?? '');
      const eventStore = new PostgresMailboxMemoryEventStore(database, timing);
      const ingestion = new PostgresIngestionStore(ingestionClient(sql));
      const memory = new FakeHindsight();
      const attachmentBytes = Uint8Array.from([37, 80, 68, 70]);
      const providerMessages = new Map([
        [`${ids.user}:primary@example.test`, { id: 'provider-primary', account: 'primary@example.test', subject: 'Invoice', body: 'Primary private text', bodyFormat: 'text' as const }],
        [`${ids.user}:same-looking@example.test`, { id: 'provider-lookalike', account: 'same-looking@example.test', subject: 'Same', body: 'Identical-looking body', bodyFormat: 'text' as const }],
        [`${ids.otherUser}:same-looking@example.test`, { id: 'provider-lookalike', account: 'same-looking@example.test', subject: 'Same', body: 'Identical-looking body', bodyFormat: 'text' as const }],
      ]);
      const providerCalls: string[] = [];
      const clients = { clientForUser: (userId: string) => ({
        initialize: () => { providerCalls.push(`initialize:${userId}`); return Promise.resolve(); },
        readMessage: (account: string, providerId: string) => {
          providerCalls.push(`read:${userId}:${account}:${providerId}`);
          const message = providerMessages.get(`${userId}:${account}`); return message ? Promise.resolve(message) : Promise.reject(new Error('missing'));
        },
        openAttachment: (_account: string, _message: string, attachment: string) => {
          providerCalls.push(`attachment:${userId}:${attachment}`);
          return Promise.resolve({ metadata: { id: attachment, name: attachment }, contentDisposition: 'attachment' as const,
            stream: Readable.from([attachmentBytes]), cleanup: () => Promise.resolve(), cancel: () => Promise.resolve() });
        },
      }) };
      const worker = () => new MailboxMemoryEventDeliveryWorker(eventStore,
        new PostgresMailboxMemoryMessageHydrator(database), clients,
        new MailboxCurrentEmailRetainer(memory, { tempDirectory: '/private/hypermail-test', maxBytes: 1024 }),
        `acceptance-${randomUUID()}`, timing);
      const drain = async (delivery = worker()) => {
        for (let pass = 0; pass < 30; pass++) {
          const pending = (await sql<{count:number}[]>`select count(*)::integer count from app.mailbox_memory_events where state='pending' and available_at<=clock_timestamp()`)[0]?.count ?? 0;
          if (pending === 0) break;
          await delivery.runOnce();
        }
      };

      try {
        const observedAt = new Date(at(1));
        const primaryArrival = { accountId: ids.primary, observedAt, message: { id: 'provider-primary', account: 'primary@example.test',
          subject: 'Invoice', receivedAt: observedAt.toISOString(), attachments: [
            { id: 'supported-pdf', name: 'invoice.pdf', contentType: 'application/pdf', size: attachmentBytes.byteLength },
            { id: 'unsupported-bin', name: 'payload.bin', contentType: 'application/octet-stream', size: 3 },
          ] } };
        await ingestion.recordArrival(primaryArrival); await ingestion.recordArrival(primaryArrival);
        for (const accountId of [ids.sibling, ids.lookalike])
          await ingestion.recordArrival({ accountId, observedAt, message: { id: 'provider-lookalike', account: 'same-looking@example.test', subject: 'Same', receivedAt: observedAt.toISOString() } });
        expect(await sql`select account_id,count(*)::integer count from app.mailbox_memory_events group by account_id order by account_id`)
          .toEqual([ids.primary, ids.sibling, ids.lookalike].sort().map((account_id) => ({ account_id, count: 1 })));

        // The first real delivery sees an outage and is durably deferred. Other banks can progress.
        await worker().runOnce();
        expect(await sql`select count(*)::integer count from app.mailbox_memory_events where state='pending' and attempt_count=1 and last_error_code='MAILBOX_MEMORY_DEPENDENCY_UNAVAILABLE'`)
          .toEqual([{ count: 1 }]);
        await drain();
        await sql.unsafe('select pg_sleep(1.1)');
        await drain(worker()); // a new worker/retainer is the process-restart boundary

        const primaryBank = mailboxBankId({ userId: ids.user, mailboxId: ids.primary });
        const siblingBank = mailboxBankId({ userId: ids.user, mailboxId: ids.sibling });
        const lookalikeBank = mailboxBankId({ userId: ids.otherUser, mailboxId: ids.lookalike });
        const banks = [primaryBank, siblingBank, lookalikeBank];
        expect(new Set(banks).size).toBe(3);
        expect(banks.every((bank) => !bank.includes('@') && /^hm-mailbox-v1-[0-9a-f]{48}$/.test(bank))).toBe(true);
        expect([...memory.documents.keys()].sort()).toEqual([...banks].sort());
        const primaryDocuments = memory.documents.get(primaryBank); const siblingDocuments = memory.documents.get(siblingBank);
        const lookalikeDocuments = memory.documents.get(lookalikeBank);
        expect([...primaryDocuments?.values() ?? []].join(' ')).toContain('Primary private text');
        expect([...siblingDocuments?.values() ?? []].join(' ')).not.toContain('Primary private text');
        expect([...lookalikeDocuments?.values() ?? []].join(' ')).not.toContain('Primary private text');
        expect(memory.files.get(primaryBank)).toEqual(['invoice.pdf']);
        expect(providerCalls.filter((call) => call.includes('unsupported-bin'))).toEqual([]);
        const unsupported = (await sql<{id:string}[]>`select id from app.attachments where provider_attachment_id='unsupported-bin'`)[0];
        if (!unsupported) throw new Error('unsupported attachment projection missing');
        expect(await sql`select result_metadata from app.mailbox_memory_events where account_id=${ids.primary}`)
          .toEqual([{ result_metadata: { attachmentsRetained: 1, attachmentsSkipped: [{ sourceId: unsupported.id, reason: 'unsupported' }] } }]);

        // Triage uses the same exact bank. Retain and recall both precede the bounded model seam.
        const triageOrder = memory.calls;
        const sourceAppends: Parameters<SourceHistory['append']>[0][] = [];
        const persistence: DecisionPersistence = {
          claimQuestion: () => Promise.resolve('claimed'),
          persistOutcome: (outcome) => Promise.resolve(outcome.decision.decision),
        };
        const modelCalls: string[] = [];
        const sourceHistory: SourceHistory = { append: (input) => { sourceAppends.push(input); return Promise.resolve(); } };
        const triage = new TriageService({ model: { generate: (input) => { modelCalls.push(`model:${input.userResourceId}`); triageOrder.push('model'); return Promise.resolve({ state: 'no_action', rationale: 'accepted' }); } },
          persistence, mailboxMemory: memory, sourceHistory, modelProvider: 'fake', modelName: 'bounded' });
        const triageInput: TriageInput = { activityId: randomUUID(), userId: ids.user, accountId: ids.primary, attempt: 1,
          email: { messageId: randomUUID(), from: 'sender@example.test', subject: 'Question', receivedAt: at(2), bodyText: 'Current body', attachments: [] },
          globalConstraints: 'Do not mutate without authorization.' };
        const orderStart = triageOrder.length;
        await triage.triage(triageInput);
        expect(triageOrder.slice(orderStart).map((call) => call.split(':')[0])).toEqual(['retain', 'recall', 'model']);
        expect(modelCalls).toEqual([`model:${userResourceId(ids.user)}`]);
        const answer = 'Always keep invoices for this customer.'; const questionId = randomUUID(); const questionDecisionId = randomUUID();
        const primaryActivity = (await sql<{id:string;version:number}[]>`select a.id,a.version from app.activities a join app.messages m on m.id=a.message_id
          where m.account_id=${ids.primary} and m.provider_message_id='provider-primary'`)[0];
        if (!primaryActivity) throw new Error('canonical primary activity missing before question');
        const questionActivityId = primaryActivity.id;
        await sql`update app.activities set state='waiting_question' where id=${questionActivityId}`;
        await sql`insert into app.decisions(id,activity_id,attempt,state,rationale,model_provider,model_name,input_digest,output)
          values(${questionDecisionId},${questionActivityId},1,'question','Need owner input','fake','bounded','digest','{}'::jsonb)`;
        await sql`insert into app.questions(id,activity_id,decision_id,prompt,state) values(${questionId},${questionActivityId},${questionDecisionId},'How should invoices be handled?','open')`;
        const agentRepository = new PostgresAgentRepository(ingestionClient(sql));
        await expect(agentRepository.answerQuestion({ subjectId: ids.user, accountIds: [ids.primary] }, questionId, answer, primaryActivity.version, 'acceptance-answer'))
          .resolves.toMatchObject({ kind: 'answered', question: { state: 'answered', version: primaryActivity.version + 1 } });
        await triage.rememberUserInstruction({ userId: ids.user, activityId: questionActivityId, instruction: answer });
        expect(sourceAppends).toEqual([{ resourceId: userResourceId(ids.user), threadId: activityThreadId(ids.user, questionActivityId),
          text: JSON.stringify({ userInstruction: answer }) }]);
        expect(await sql`select kind,state from app.mailbox_memory_events where source_id=${questionId}`)
          .toEqual([{ kind: 'question_answered', state: 'pending' }]);
        await drain(worker());
        expect(await sql`select kind,state from app.mailbox_memory_events where source_id=${questionId}`)
          .toEqual([{ kind: 'question_answered', state: 'completed' }]);
        expect([...memory.documents.get(primaryBank)?.values() ?? []].join(' ')).toContain(answer);

        // Real draft repository: agent create/edit is not learnable; the User correction is.
        const drafts = new PostgresDraftRepository(database);
        const draftScope: DraftScope = { subjectId: ids.user, accountIds: [ids.primary] };
        const created = await drafts.create(draftScope, { accountId: ids.primary, sourceMessageId: null, createdBy: 'agent', state: 'editing',
          recipients: [{ kind: 'to', address: 'customer@example.test' }], subject: 'Agent proposal', body: 'Unconfirmed v1', bodyFormat: 'markdown' });
        await drafts.edit(draftScope, created.id, 1, { recipients: created.recipients, subject: created.subject, body: 'Unconfirmed v2', bodyFormat: 'markdown' }, 'agent');
        expect(await sql`select kind from app.mailbox_memory_events where source_id=${created.id}`).toEqual([]);
        await drafts.edit(draftScope, created.id, 2, { recipients: created.recipients, subject: 'User correction', body: 'Confirmed wording', bodyFormat: 'markdown' }, 'user');
        expect(await sql`select kind from app.mailbox_memory_events where source_id=${created.id}`).toEqual([{ kind: 'draft_corrected' }]);

        // A disabled Mailbox defers without external I/O, then reconnect delivers the same event.
        await sql`update app.accounts set state='disabled' where id=${ids.primary}`;
        const callsBeforeDisabled = memory.calls.length; await worker().runOnce();
        expect(memory.calls).toHaveLength(callsBeforeDisabled);
        expect(await sql`select state,last_error_code from app.mailbox_memory_events where source_id=${created.id}`)
          .toEqual([{ state: 'pending', last_error_code: null }]);
        await sql`update app.accounts set state='ready' where id=${ids.primary}`;
        await sql.unsafe('select pg_sleep(1.1)');
        await drain(worker());

        // Real action repository emits learning only after provider readback verification.
        const assignmentId = randomUUID(); const grantId = randomUUID();
        await sql`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignmentId},${ids.user},${ids.primary},'mastra',false)`;
        await sql`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at)
          values(${grantId},${ids.user},${ids.primary},'mastra',array['mail.mark_read']::text[],array['interactive']::text[],'active',${at(3)})`;
        const work = new AgentWorkStore(database);
        const canonicalPrimaryMessage = (await sql<{id:string}[]>`select id from app.messages where account_id=${ids.primary} and provider_message_id='provider-primary'`)[0];
        if (!canonicalPrimaryMessage) throw new Error('canonical primary message missing');
        const canonicalPrimaryMessageId = canonicalPrimaryMessage.id;
        const activityId = randomUUID(); const runId = randomUUID(); const actionId = randomUUID();
        await work.createActivity({ id: activityId, userId: ids.user, mailboxId: ids.primary, kind: 'interactive_request', sourceMessageId: null,
          correlationId: `activity-${activityId}`, causationId: null, state: 'open', revision: 1, createdAt: at(3), updatedAt: at(3) });
        await work.createRun({ id: runId, activityId, userId: ids.user, mailboxId: ids.primary, sequence: 1, manager: { kind: 'mastra' }, managerLifecycleRevision: null,
          assignmentId, assignmentRevision: 1, grantId, grantRevision: 1, safetyRevision: 1, mode: 'interactive', trigger: { kind: 'interactive_request', requestId: randomUUID() },
          inputDigest: 'a'.repeat(64), correlationId: `run-${runId}`, causationId: activityId, state: 'created', outcome: null, errorCode: null, createdAt: at(3), startedAt: null, completedAt: null });
        await work.startRun(ids.user, ids.primary, runId, at(3));
        await work.completeRun(ids.user, ids.primary, runId, 'action_requests_emitted', at(4));
        await work.authorizeAction({ id: actionId, activityId, runId, userId: ids.user, mailboxId: ids.primary, correlationId: `action-${actionId}`, causationId: runId,
          manager: { kind: 'mastra' }, managerLifecycleRevision: null, mode: 'interactive', assignmentId, assignmentRevision: 1, grantId, grantRevision: 1, safetyRevision: 1,
          kind: 'mark_read', target: { messageId: canonicalPrimaryMessageId }, authorizationRevision: 1, idempotencyKey: `action-${actionId}`, attempt: 1,
          retryOfActionId: null, state: 'authorized', errorCode: null, authorizedAt: at(4), startedAt: null, providerReportedAt: null, completedAt: null, verification: null });
        await work.startAction(ids.user, ids.primary, actionId, at(4)); await work.reportAction(ids.user, ids.primary, actionId, at(5));
        await work.verifyAction(ids.user, ids.primary, actionId, { actionId, mailboxId: ids.primary, verifier: 'hypermail_provider_readback',
          providerMutationId: 'mutation-1', evidenceDigest: 'b'.repeat(64), observedAt: at(6) },
        { id: randomUUID(), activityId, userId: ids.user, mailboxId: ids.primary, sequence: 1, correlationId: `verified-${actionId}`, causationId: actionId,
          occurredAt: at(6), detail: { type: 'action_verified', runId, actionId } });
        expect(await sql`select kind from app.mailbox_memory_events where source_id=${actionId}`).toEqual([{ kind: 'mailbox_action_verified' }]);
        await drain(worker());

        // Deletion cancels both replayable states, keeps completed canonical history, and cannot refill.
        const pendingId = randomUUID(); const processingId = randomUUID();
        for (const [id, kind] of [[processingId, 'deletion_processing'], [pendingId, 'deletion_pending']] as const)
          await eventStore.enqueue({ id, userId: ids.user, mailboxId: ids.primary, sourceType: 'operator_test', sourceId: id, kind, occurredAt: at(7), contentPayload: { secret: kind } });
        await eventStore.claim({ workerId: 'stopped-worker', limit: 1 });
        expect((await sql<{state:string}[]>`select state from app.mailbox_memory_events where id in (${pendingId},${processingId}) order by state`).map(({ state }) => state))
          .toEqual(['pending', 'processing']);
        const completedBefore = await sql`select id,state,content_digest,result_metadata,completed_at from app.mailbox_memory_events where account_id=${ids.primary} and state='completed' order by id`;
        const retainsBeforeDelete = memory.calls.filter((call) => call.startsWith('retain:')).length;
        await permanentlyDeleteMailboxMemory({ database, memory, userId: ids.user, mailboxId: ids.primary, workerStopped: true });
        expect(memory.deleted).toContain(primaryBank);
        expect(await sql`select id,state,content_payload,last_error_code from app.mailbox_memory_events where id in (${pendingId},${processingId}) order by id`)
          .toEqual([pendingId, processingId].sort().map((id) => ({ id, state: 'cancelled', content_payload: null, last_error_code: 'OWNER_MEMORY_DELETION' })));
        expect(await sql`select id,state,content_digest,result_metadata,completed_at from app.mailbox_memory_events where account_id=${ids.primary} and state='completed' order by id`).toEqual(completedBefore);
        await worker().runOnce();
        expect(memory.calls.filter((call) => call.startsWith('retain:'))).toHaveLength(retainsBeforeDelete);
        expect(memory.documents.has(primaryBank)).toBe(false);
        expect(memory.documents.has(siblingBank)).toBe(true);
        expect(memory.documents.has(lookalikeBank)).toBe(true);
      } finally { await database.close(); }
    });
  }, 60_000);
});
