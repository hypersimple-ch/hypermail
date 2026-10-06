/* eslint-disable @typescript-eslint/require-await */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { DecisionModel, ConversationModel } from '@hypermail/agent';
import type { AgentProposal } from '../../web/src/agent/contracts.js';
import type { ManagerSettingsView } from '../../web/src/agent-connections/contracts.js';
import type { DraftRecord } from '../../web/src/drafts/contracts.js';
import type { Conversation, ConversationMessage } from '@hypermail/contracts';
import { createWebRuntimeFromEnvironment, type WebRuntime } from '../../web/src/runtime.js';
import { createWebServer } from '../../web/src/server.js';
import { composeWorkerRuntime } from '../src/production.js';
import { parseWorkerEnvironment, type WorkerRuntime } from '../src/runtime.js';
import { withPostgresSchemas } from './postgres-test.js';
import { ControlledHypermail, ControlledMemory, ControlledSmtp, close, listen, unusedPort } from './full-acceptance-fixtures.js';

const databaseUrl = process.env['FULL_ACCEPTANCE_DATABASE_URL'];
// Never read DATABASE_URL: the schema-reset harness must not touch a developer/deployed database.
function requireDisposableDatabase(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || !/^\/hypermail_acceptance_[a-f0-9]{32}$/.test(parsed.pathname)
    || !parsed.port || parsed.port === '5432' || process.env['FULL_ACCEPTANCE_ISOLATED'] !== parsed.pathname.slice(1)) {
    throw new Error('Run infra/acceptance/full-runtime.sh; only its unique loopback disposable database is allowed');
  }
}
async function eventually(label: string, predicate: () => Promise<boolean>, timeoutMs = 90_000, diagnostic?: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Real pg-boss polling and lease schedulers run on the platform clock; fake timers cannot drive PostgreSQL jobs.
  while (Date.now() < deadline) { if (await predicate()) return; await delay(250); }
  throw new Error(`Acceptance deadline: ${label}${diagnostic ? `; durable state ${JSON.stringify(await diagnostic())}` : ''}`);
}

describe('isolated full application acceptance', () => {
  it.skipIf(!databaseUrl)('uses HTTP auth/activation, real pg-boss triage/policy, scoped conversations, send ambiguity and SMTP reset across worker restart', async () => {
    if (!databaseUrl) throw new Error('Disposable acceptance database required');
    requireDisposableDatabase(databaseUrl);
    await withPostgresSchemas(databaseUrl, async sql => {
      const provider = new ControlledHypermail(), smtp = new ControlledSmtp(), memory = new ControlledMemory();
      const attachmentDirectory = await mkdtemp(join(homedir(), '.hypermail-acceptance-'));
      let web: WebRuntime | undefined, server: Server | undefined, worker: WorkerRuntime | undefined;
      try {
        const providerPort = await listen(provider.server), smtpPort = await listen(smtp.server);
        const webPort = await unusedPort(), healthPort = await unusedPort();
        const origin = `http://127.0.0.1:${String(webPort)}`, endpoint = `http://127.0.0.1:${String(providerPort)}/mcp`;
        const ownerEmail = 'owner@example.test', password = 'acceptance-only-long-password-1';
        const common: NodeJS.ProcessEnv = {
          NODE_ENV: 'development', DATABASE_URL: databaseUrl, APP_ORIGIN: origin,
          AUTH_SECRET: 'acceptance-auth-secret-'.repeat(3), OAUTH_TOKEN_HASH_KEY: 'acceptance-oauth-key-'.repeat(3),
          HYPERMAIL_URL: endpoint, HYPERMAIL_KEY: 'acceptance-private-key', HYPERMAIL_PROTOCOL_VERSION: 'acceptance',
          VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'acceptance-public-key', VAPID_PRIVATE_KEY: 'acceptance-private-key',
          PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'acceptance-encryption-key-'.repeat(3), ATTACHMENT_TEMP_DIRECTORY: attachmentDirectory,
          RECOVERY_SMTP_HOST: '127.0.0.1', RECOVERY_SMTP_PORT: String(smtpPort), RECOVERY_SMTP_SECURE: 'false', RECOVERY_FROM: 'recovery@example.test',
        };
        let cookie = '';
        async function request<T>(path: string, body?: object, status = 200): Promise<T> {
          const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json', 'x-api-version': 'v1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
          // Do not print recovery mail, passwords, or request bodies on failures.
          if (response.status !== status) {
            const payload: unknown = await response.json().catch(() => undefined);
            const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'UNAVAILABLE';
            throw new Error(`${body ? 'POST' : 'GET'} ${path}: expected ${String(status)}, received ${String(response.status)}, error code ${code}`);
          }
          const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0] ?? '';
          return await response.json() as T;
        }
        async function startWeb(): Promise<void> { web = createWebRuntimeFromEnvironment(common); server = createWebServer(undefined, web); await listen(server, webPort); }
        async function stopWeb(): Promise<void> { if (server) await close(server); if (web) await web.close(); server = undefined; web = undefined; }
        await startWeb();
        await request('/api/v1/auth/bootstrap', { email: ownerEmail, password }, 201);
        const session = await request<{ userId: string }>('/api/v1/session');
        await stopWeb();
        common['HYPERMAIL_TENANT_ROUTES'] = JSON.stringify({ [session.userId]: { endpoint, key: 'acceptance-private-key', protocolVersion: 'acceptance' } });
        await startWeb();
        const accounts: string[] = [];
        for (const email of ['a@example.test', 'b@example.test']) {
          const result = await request<{ account: { id: string } }>('/api/v1/mailboxes', { provider: 'imap', email, config: { host: 'controlled.invalid', user: email, password: '  secret avec espaces  ' } }, 201);
          accounts.push(result.account.id);
          const settings = await request<{ settings: ManagerSettingsView }>('/api/v1/agent-connections');
          const mailbox = settings.settings.mailboxes.find(item => item.mailboxId === result.account.id);
          if (!mailbox) throw new Error('Onboarded mailbox missing from settings');
          await request(`/api/v1/mailboxes/${result.account.id}/assistant/activate`, { confirmed: true, expectedAssignmentRevision: mailbox.assignment.revision, expectedGrantRevision: mailbox.grant?.revision ?? null });
        }
        const [accountA, accountB] = accounts; if (!accountA || !accountB) throw new Error('Missing acceptance accounts');
        const onboarding = provider.calls.filter(call => call.name === 'add_account');
        expect(onboarding.map(call => {
          const config = call.args['config'];
          if (!config || typeof config !== 'object' || !('password' in config)) throw new Error('Missing onboarding credential');
          return config.password;
        })).toEqual(['  secret avec espaces  ', '  secret avec espaces  ']);
        const triageInputs: Parameters<DecisionModel['generate']>[0][] = [];
        const chatInputs: Parameters<ConversationModel['generate']>[0][] = [];
        let rejectConversation = true;
        const decisionModel: DecisionModel = { async generate(input) {
          triageInputs.push(input);
          const target = { accountId: input.accountId, messageId: input.email.messageId };
          if (input.email.subject === 'mixed') {
            const folder = input.availableFolders.find(item => item.displayName === 'destination'); if (!folder) throw new Error('Controlled destination missing');
            return { schemaVersion: 2, state: 'actionable', rationale: 'Independent reply and classification.', actions: [
              { key: 'reply', kind: 'draft_create', target, draft: { recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Prepared reply', body: 'Prepared once', bodyFormat: 'markdown' }, confidence: 0.60, reason: 'Reply at the threshold.', evidenceIds: [`mail:${input.email.messageId}`], dependsOn: [] },
              { key: 'classify', kind: 'move', target: { ...target, destinationFolderId: folder.id }, confidence: 0.5999, reason: 'Classification requires owner review.', evidenceIds: [], dependsOn: [] },
              { key: 'review_reply', kind: 'draft_create', target, draft: { recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Review reply', body: 'Approved once', bodyFormat: 'markdown' }, confidence: 0.4, reason: 'Owner must approve this reply.', evidenceIds: [], dependsOn: [] },
              { key: 'declined_reply', kind: 'draft_create', target, draft: { recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Declined reply', body: 'Never create this draft', bodyFormat: 'markdown' }, confidence: 0.3, reason: 'Owner may reject this reply.', evidenceIds: [], dependsOn: [] },
            ] };
          }
          if (!input.mailboxMemoryContext.includes('LOCAL_ARCHIVE_CORRECTION')) {
            const destination = input.availableFolders.find(item => item.displayName === 'destination');
            if (!destination) throw new Error('Controlled destination missing');
            return { schemaVersion: 2, state: 'actionable', rationale: 'No local archive correction in this mailbox.', actions: [{ key: 'move', kind: 'move', target: { ...target, destinationFolderId: destination.id }, confidence: 0.9, reason: 'Keep the independent mailbox classification.', evidenceIds: [], dependsOn: [] }] };
          }
          return { schemaVersion: 2, state: 'actionable', rationale: 'Scoped instruction applies.', actions: [{ key: 'archive', kind: 'archive', target, confidence: 0.9, reason: 'Relevant owner context, when present, was considered.', evidenceIds: [], dependsOn: [] }] };
        } };
        const conversationModel: ConversationModel = { async generate(input) {
          chatInputs.push(input);
          if (input.messages.some(message => message.content === 'retry-fixture') && rejectConversation) throw Object.assign(new Error('Controlled permanent model refusal'), { statusCode: 400 });
          return { reply: 'Read-only discussion. No mail was sent or changed.' };
        } };
        const workerEnvironment = parseWorkerEnvironment({ ...common, HINDSIGHT_URL: origin, HINDSIGHT_EXPECTED_VERSION: '0.10.2', MODEL_PROVIDER: 'codex-cli', MODEL_NAME: 'default', AGENT_GLOBAL_CONSTRAINTS: 'Never send email automatically.', HEALTH_PORT: String(healthPort), POLL_INTERVAL_SECONDS: '30', MAILBOX_MEMORY_SCHEDULER_INTERVAL_SECONDS: '1' });
        async function startWorker(): Promise<void> {
          worker = composeWorkerRuntime(workerEnvironment, { createDecisionModel: () => decisionModel, createConversationModel: () => conversationModel, createSourceHistory: () => memory, createMailboxMemory: () => memory, createNotificationTransport: () => ({ send: async () => ({ ok: true }) }), holderId: () => `acceptance:${randomUUID()}` });
          await worker.start();
          expect(worker.dependencyState).toMatchObject({ database: true, queue: true, hypermail: true, hindsight: true, policy: true });
        }
        async function stopWorker(): Promise<void> { await worker?.shutdown(); worker = undefined; }
        await startWorker();
        await eventually('initial baselines', async () => (await sql`select id from app.accounts where baseline_completed_at is not null`).length === 2);
        const providerMessageId = provider.arrive('a@example.test', 'mixed');
        await eventually('mixed triage proposals', async () => (await sql`select id from app.agent_action_proposals`).length === 4);
        const activityRows = await sql<{ id: string; message_id: string }[]>`select a.id,a.message_id from app.activities a join app.messages m on m.id=a.message_id where m.provider_message_id=${providerMessageId}`;
        const activity = activityRows[0]; if (!activity) throw new Error('Arrival Activity missing');
        await eventually('threshold draft verified', async () => {
          const actions = await sql<{ state: string; code: string | null }[]>`select state,coalesce(to_jsonb(a)->>'error_code',to_jsonb(a)->>'last_error_code') code from app.agent_authorized_actions a where kind='draft_create'`;
          if (actions.some(action => ['failed','blocked','unverifiable'].includes(action.state))) throw new Error(`Threshold draft terminal state: ${JSON.stringify(actions)}`);
          const proposals = await sql<{ state: string; code: string | null }[]>`select state,error_code code from app.agent_action_proposals where kind='draft_create'`;
          if (proposals.some(proposal => proposal.state === 'blocked')) throw new Error(`Threshold draft proposal blocked: ${JSON.stringify(proposals)}`);
          return actions.filter(action => action.state === 'verified').length === 1;
        }, 20_000, async () => ({
          proposals: await sql`select state,kind,confidence,error_code,to_jsonb(p)->>'action_id' action_id from app.agent_action_proposals p`,
          actions: await sql`select state,kind,coalesce(to_jsonb(a)->>'last_error_code',to_jsonb(a)->>'error_code') error_code from app.agent_authorized_actions a`,
          jobs: await sql`select to_jsonb(j)->>'name' name,to_jsonb(j)->>'state' state,to_jsonb(j)->'output'->>'code' code,to_jsonb(j)->'output'->>'constraint' constraint_name,to_jsonb(j)->'output'->>'message' message from pgboss.job j where to_jsonb(j)->>'name' in ('policy.execute','agent.execute')`,
        }));
        const listing = await request<{ proposals: AgentProposal[] }>(`/api/v1/agent/proposals?activityId=${activity.id}`);
        const low = listing.proposals.find(item => item.kind === 'move'); if (!low) throw new Error('Missing review proposal');
        expect(low).toMatchObject({ state: 'waiting_review', confidence: 0.5999, threshold: 0.60 });
        expect(provider.count('move_email')).toBe(0); expect(provider.count('draft_email')).toBe(1); expect(provider.count('send_email')).toBe(0);
        const correction = { expectedRevision: low.revision, idempotencyKey: randomUUID(), decision: 'correct', reason: 'LOCAL_ARCHIVE_CORRECTION', correction: { kind: 'archive', target: { accountId: accountA, messageId: activity.message_id }, reason: 'Archive instead in this mailbox.' } };
        const corrected = await request(`/api/v1/agent/proposals/${low.id}/review`, correction);
        expect(await request(`/api/v1/agent/proposals/${low.id}/review`, correction)).toEqual(corrected);
        await eventually('corrected classification verified', async () => (await sql`select id from app.agent_authorized_actions where kind='archive' and state='verified'`).length === 1);
        expect(provider.mails.get(providerMessageId)?.folder).toBe('archive'); expect(provider.count('archive_email')).toBe(1); expect(provider.count('draft_email')).toBe(1);
        await eventually('review memory retained', async () => [...memory.retained.values()].some(row => row.mailboxId === accountA && row.text.includes('LOCAL_ARCHIVE_CORRECTION')));
        const approveProposal = listing.proposals.find(item => 'key' in item.payload && item.payload.key === 'review_reply'), rejectProposal = listing.proposals.find(item => 'key' in item.payload && item.payload.key === 'declined_reply');
        if (!approveProposal || !rejectProposal) throw new Error('Missing independent review proposals');
        const approvalInput = { expectedRevision: approveProposal.revision, idempotencyKey: randomUUID(), decision: 'approve' };
        const approvedReviews = await Promise.all([request(`/api/v1/agent/proposals/${approveProposal.id}/review`, approvalInput), request(`/api/v1/agent/proposals/${approveProposal.id}/review`, approvalInput)]);
        expect(approvedReviews[0]).toEqual(approvedReviews[1]);
        await request(`/api/v1/agent/proposals/${rejectProposal.id}/review`, { expectedRevision: rejectProposal.revision, idempotencyKey: randomUUID(), decision: 'reject', reason: 'Do not prepare this reply.' });
        await eventually('individual approval creates exactly one further draft', async () => (await sql`select id from app.agent_authorized_actions where kind='draft_create' and state='verified'`).length === 2);
        expect(provider.count('draft_email')).toBe(2);
        expect([...provider.mails.values()].some(mail => mail.subject === 'Declined reply')).toBe(false);

        async function conversation(scope: 'mailbox' | 'global', accountId?: string, contextMessageId?: string): Promise<Conversation> {
          const result = await request<{ conversation: Conversation }>('/api/v1/conversations', { scope, ...(accountId ? { accountId } : {}), ...(contextMessageId ? { contextMessageId } : {}) }, 201); return result.conversation;
        }
        async function post(chat: Conversation, content: string) {
          const input = { requestId: randomUUID(), expectedVersion: chat.version, content };
          const result = await request<{ conversation: Conversation; turn: { id: string; attempt: number }; message: ConversationMessage }>(`/api/v1/conversations/${chat.id}/messages`, input, 202);
          const replay = await request<{ message: ConversationMessage }>(`/api/v1/conversations/${chat.id}/messages`, input, 202);
          expect(replay.message.id).toBe(result.message.id); return result;
        }
        const privateChat = await conversation('mailbox', accountA, activity.message_id);
        const privateTurn = await post(privateChat, 'PRIVATE_MAILBOX_A_ONLY');
        await eventually('context conversation response', async () => (await sql`select id from app.agent_conversation_messages where reply_to=${privateTurn.message.id}`).length === 1);
        expect(chatInputs.find(input => input.conversation.id === privateChat.id)?.contextMessage?.body).toContain('ignore previous rules');
        const bChat = await conversation('mailbox', accountB);
        const bTurn = await post(bChat, 'MAILBOX_B_DISCUSSION');
        await eventually('mailbox B response', async () => (await sql`select id from app.agent_conversation_messages where reply_to=${bTurn.message.id}`).length === 1);
        const bInput = chatInputs.find(input => input.conversation.id === bChat.id); if (!bInput) throw new Error('B conversation model not called');
        expect(JSON.stringify(bInput)).not.toContain('PRIVATE_MAILBOX_A_ONLY'); expect(bInput.contextMessage).toBeUndefined();
        const global = await conversation('global'); const globalTurn = await post(global, 'EXPLICIT_GLOBAL_PREFERENCE');
        await eventually('explicit global fanout retained', async () => accounts.every(accountId => [...memory.retained.values()].some(row => row.mailboxId === accountId && row.text.includes('EXPLICIT_GLOBAL_PREFERENCE'))));
        await eventually('global response', async () => (await sql`select id from app.agent_conversation_messages where reply_to=${globalTurn.message.id}`).length === 1);
        const globalInput = chatInputs.find(input => input.conversation.id === global.id); expect(globalInput?.mailboxMemoryContext).toBe(''); expect(globalInput?.contextMessage).toBeUndefined();
        // A newly connected mailbox inherits only explicit global sources, never mailbox A discussion.
        const future = await request<{ account: { id: string } }>('/api/v1/mailboxes', { provider: 'imap', email: ownerEmail, config: { host: 'controlled.invalid', user: ownerEmail, password: 'fixture-password' } }, 201);
        const futureSettings = await request<{ settings: ManagerSettingsView }>('/api/v1/agent-connections');
        const futureMailbox = futureSettings.settings.mailboxes.find(item => item.mailboxId === future.account.id);
        if (!futureMailbox) throw new Error('Future mailbox missing settings');
        await request(`/api/v1/mailboxes/${future.account.id}/assistant/activate`, { confirmed: true, expectedAssignmentRevision: futureMailbox.assignment.revision, expectedGrantRevision: futureMailbox.grant?.revision ?? null });
        await eventually('future mailbox global backfill retained', async () => [...memory.retained.values()].some(row => row.mailboxId === future.account.id && row.text.includes('EXPLICIT_GLOBAL_PREFERENCE')));
        expect([...memory.retained.values()].filter(row => row.mailboxId === future.account.id).some(row => row.text.includes('PRIVATE_MAILBOX_A_ONLY'))).toBe(false);
        const failingChat = await conversation('mailbox', accountA); const failed = await post(failingChat, 'retry-fixture');
        await eventually('visible failed conversation turn', async () => (await sql`select id from app.agent_conversation_turns where id=${failed.turn.id} and state='failed'`).length === 1);
        const failedRows = await sql<{ attempt: number }[]>`select attempt from app.agent_conversation_turns where id=${failed.turn.id}`;
        await stopWorker();
        rejectConversation = false;
        await request(`/api/v1/conversations/${failingChat.id}/turns/${failed.turn.id}/retry`, { expectedAttempt: failedRows[0]?.attempt }, 202);
        await startWorker();
        await eventually('restart recovers retry without duplicate response', async () => (await sql`select id from app.agent_conversation_messages where reply_to=${failed.message.id}`).length === 1);
        expect(await sql`select id from app.agent_conversation_messages where request_id=${failed.message.requestId}`).toHaveLength(1);
        const afterA = provider.arrive('a@example.test', 'after-correction'), afterB = provider.arrive('b@example.test', 'after-correction');
        await eventually('next arrival consumes scoped owner memory', async () => triageInputs.filter(input => input.email.subject === 'after-correction').length === 2);
        const nextA = triageInputs.find(input => input.email.subject === 'after-correction' && input.accountId === accountA), nextB = triageInputs.find(input => input.email.subject === 'after-correction' && input.accountId === accountB);
        expect(nextA?.mailboxMemoryContext).toContain('LOCAL_ARCHIVE_CORRECTION'); expect(nextA?.mailboxMemoryContext).toContain('PRIVATE_MAILBOX_A_ONLY');
        expect(nextB?.mailboxMemoryContext).not.toContain('LOCAL_ARCHIVE_CORRECTION'); expect(nextB?.mailboxMemoryContext).not.toContain('PRIVATE_MAILBOX_A_ONLY'); expect(nextB?.mailboxMemoryContext).toContain('EXPLICIT_GLOBAL_PREFERENCE');
        await eventually('scoped owner correction changes next verified mutation', async () => (await sql`select id from app.agent_authorized_actions where kind in ('archive','move') and state='verified'`).length === 3);
        expect(provider.mails.get(afterA)?.folder).toBe('archive'); expect(provider.mails.get(afterB)?.folder).toBe('destination');
        expect(provider.count('send_email')).toBe(0);

        await request('/api/v1/auth/reauthenticate', { password });
        const draft = (await request<{ draft: DraftRecord }>('/api/v1/drafts', { accountId: accountA, recipients: [{ kind: 'to', address: 'recipient@example.test' }], subject: 'Explicit owner-approved send', body: 'This body is approved by the owner.', bodyFormat: 'markdown' })).draft;
        const confirmation = randomUUID();
        const approval = (await request<{ approval: { approvalId: string; snapshot: DraftRecord } }>(`/api/v1/drafts/${draft.id}/approval`, { expectedVersion: draft.version, confirmation })).approval;
        const confirms = await Promise.all([1, 2].map(() => fetch(`${origin}/api/v1/drafts/approvals/${approval.approvalId}/send`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation }) })));
        expect(confirms.some(response => response.status === 200)).toBe(true); expect(confirms.every(response => [200, 409].includes(response.status))).toBe(true); expect(provider.count('send_email')).toBe(1);
        const sendingRows = await sql<{ version: number; state: string }[]>`select version,state from app.drafts where id=${draft.id}`;
        expect(sendingRows[0]?.state).toBe('sending');
        await request(`/api/v1/drafts/${draft.id}/reconcile`, { approvalId: approval.approvalId, expectedVersion: sendingRows[0]?.version });
        expect(provider.count('send_email')).toBe(1);
        const submissions = await sql<{ state: string; provider_reference_type: string }[]>`select state,provider_reference_type from app.approved_send_submissions where approval_id=${approval.approvalId}`;
        expect(submissions[0]).toMatchObject({ state: 'unknown', provider_reference_type: 'none' });
        await stopWeb(); await startWeb();
        const currentDraft = (await sql<{ version: number }[]>`select version from app.drafts where id=${draft.id}`)[0];
        await request(`/api/v1/drafts/${draft.id}/reconcile`, { approvalId: approval.approvalId, expectedVersion: currentDraft?.version });
        expect(provider.count('send_email')).toBe(1);

        const priorCookie = cookie;
        const unknownRecovery = await request('/api/v1/auth/recovery', { email: 'unknown@example.test' }, 202);
        const knownRecovery = await request('/api/v1/auth/recovery', { email: ownerEmail }, 202);
        expect(unknownRecovery).toEqual(knownRecovery);
        await eventually('real SMTP recovery delivery', async () => smtp.messages.length === 1);
        // Quoted-printable line folding is the wire encoding; keep token and raw body out of output.
        const recoveryBody = (smtp.messages[0] ?? '').replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
        const link = /https?:\/\/[^\s<>"]+#token=[A-Za-z0-9_-]+/.exec(recoveryBody)?.[0];
        if (!link) throw new Error('SMTP delivery contains no usable canonical fragment link');
        const recoveryUrl = new URL(link); expect(recoveryUrl.origin).toBe(origin); const token = new URLSearchParams(recoveryUrl.hash.slice(1)).get('token'); if (!token) throw new Error('Recovery fragment missing');
        const newPassword = 'acceptance-only-reset-password-2';
        await request('/api/v1/auth/reset', { token, password: newPassword });
        await request('/api/v1/auth/reset', { token, password: newPassword }, 400);
        const revoked = await fetch(`${origin}/api/v1/session`, { headers: { cookie: priorCookie } }); expect(revoked.status).toBe(401);
        await request('/api/v1/auth/login', { email: ownerEmail, password: newPassword });
        expect(smtp.messages).toHaveLength(1);
        // Providers without RFC Message-ID still exclude the authentic origin/token hash after token use.
        const recoveryArrivalId = provider.arrive(ownerEmail, 'recovery-exclusion', recoveryBody);
        await eventually('received recovery mail excluded before model and memory', async () => (await sql`
          select j.id from app.agent_jobs j join app.activities a on a.id=j.activity_id
          join app.messages m on m.id=a.message_id
          where m.provider_message_id=${recoveryArrivalId} and m.account_id=${future.account.id}
          and j.state='succeeded' and j.unavailable_reason='RECOVERY_MAIL_EXCLUDED'`).length === 1);
        const recoveryMessage = (await sql<{ id: string }[]>`
          select id from app.messages where provider_message_id=${recoveryArrivalId} and account_id=${future.account.id}`)[0];
        if (!recoveryMessage) throw new Error('Excluded recovery mail has no owner projection');
        await eventually('recovery email outbox completes without retention', async () => (await sql`
          select id from app.mailbox_memory_events where source_id=${recoveryMessage.id}
          and account_id=${future.account.id} and kind='email_received' and state='completed'`).length === 1);
        const readableRecovery = await request<{ message: { body: string } }>(`/api/v1/messages/${recoveryMessage.id}`);
        expect(readableRecovery.message.body.includes(token)).toBe(true);
        expect(triageInputs.some(input => input.email.subject === 'recovery-exclusion')).toBe(false);
        expect(JSON.stringify([...memory.retained.values(), ...triageInputs, ...chatInputs]).includes(token)).toBe(false);
        if (process.env['FULL_ACCEPTANCE_BACKUP_DRILL'] === '1') {
          await stopWorker();
          await stopWeb();
          const sourceContainer = process.env['FULL_ACCEPTANCE_DATABASE_CONTAINER'];
          if (!sourceContainer) throw new Error('Acceptance launcher must own the backup source container');
          const sourceUrl = new URL(databaseUrl); sourceUrl.hostname = sourceContainer; sourceUrl.port = '5432';
          const result = await promisify(execFile)('bash', ['infra/backup/test/drill.sh'], {
            env: { ...process.env, DRILL_APPLICATION_SOURCE_CONTAINER: sourceContainer,
              DRILL_APPLICATION_SOURCE_DATABASE: sourceUrl.pathname.slice(1), DRILL_APPLICATION_SOURCE_URL: sourceUrl.toString(),
              DRILL_APPLICATION_QUIESCED: '1' }, timeout: 120_000,
          });
          expect(result.stdout).toContain('application_state=verified');
          console.info(result.stdout.trim());
          console.info('Provider/Hindsight state remains a synthetic offline fixture; native memory recall is not claimed.');
        }
        console.info('Full isolated runtime acceptance passed: real HTTP/SQL/queue/policy/SMTP; native model, Hindsight restore, live providers and Android remain separate release gates.');
      } finally {
        // Cleanup remains independent even if an earlier shutdown fails.
        await Promise.allSettled([worker?.shutdown(), server ? close(server) : undefined]);
        await web?.close().catch(() => undefined);
        await Promise.allSettled([provider.server.listening ? close(provider.server) : undefined, smtp.server.listening ? smtp.stop() : undefined]);
        await rm(attachmentDirectory, { recursive: true, force: true });
      }
    });
  }, 420_000);
});
