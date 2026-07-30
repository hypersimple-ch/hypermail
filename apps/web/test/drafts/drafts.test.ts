import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApprovedSend, MailSendProvider } from '@hypermail/send';
import { type ApprovalClaim, type DraftRecord, type DraftScope, type DraftSource, type DraftSourceReader, DraftConflictError, DraftInputError, DraftService, InMemoryDraftRepository, createDraftRoutes } from '../../src/drafts/index.js';

const account = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000020';
const scope = { subjectId: '00000000-0000-4000-8000-000000000010', accountIds: [account], freshAuthAt: '2025-01-01T00:00:00.000Z' } as const;
const fields = { recipients: [{ kind: 'to' as const, address: 'person@example.com' }], subject: 'Hello', body: 'Body' };
const clock = () => new Date('2025-01-01T00:01:00.000Z');
const source: DraftSource = { id: sourceId, accountId: account, from: 'sender@example.com', sentAt: '2024-12-31T00:00:00.000Z', subject: 'Question', body: 'Original\ntext' };
class SourceReader implements DraftSourceReader {
  constructor(private readonly sources: readonly DraftSource[] = [source]) {}
  read(readerScope: DraftScope, accountId: string, id: string) { return Promise.resolve(this.sources.find((item) => item.id === id && item.accountId === accountId && readerScope.accountIds.includes(accountId)) ?? null); }
}
class Provider implements MailSendProvider { calls: ApprovedSend[] = []; fail = false; send(message: ApprovedSend) { this.calls.push(message); return this.fail ? Promise.reject(new Error('provider unavailable')) : Promise.resolve({ providerMessageId: 'message-1' }); } }
const service = (provider = new Provider(), sourceReader = new SourceReader()) => {
  let sequence = 99;
  return new DraftService(new InMemoryDraftRepository(), provider, sourceReader, clock, () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`);
};
class CompletionFailingRepository extends InMemoryDraftRepository {
  readonly outcomes: Array<'sent' | 'failed'> = [];
  override async completeSend(completionScope: DraftScope, claim: ApprovalClaim, outcome: 'sent' | 'failed'): Promise<DraftRecord> {
    this.outcomes.push(outcome);
    if (outcome === 'sent') throw new Error('completion unavailable');
    return super.completeSend(completionScope, claim, outcome);
  }
}

describe('draft composition and isolated send boundary', () => {
  it('uses authoritative, account-scoped context for user replies and exposes agent edits only through its internal port', async () => {
    const draftService = service();
    const draft = await draftService.replyUser(scope, { ...fields, accountId: account, sourceMessageId: sourceId });
    expect(draft).toMatchObject({ createdBy: 'user', sourceMessageId: sourceId, subject: 'Re: Question', version: 1 });
    expect(draft.body).toContain('> Original\n> text');
    const edited = await draftService.agentDraftWriter.editAgent(scope, draft.id, 1, { ...fields, body: 'Agent revision' });
    expect(edited.version).toBe(2);
    expect((await draftService.history(scope, draft.id)).map((revision) => revision.editor)).toEqual(['user', 'agent']);
    await expect(draftService.agentDraftWriter.editAgent(scope, draft.id, 1, fields)).rejects.toBeInstanceOf(DraftConflictError);
  });
  it('rejects invalid recipients and isolates account-scoped drafts', async () => {
    const draftService = service();
    await expect(draftService.createUser(scope, { ...fields, recipients: [{ kind: 'cc', address: 'person@example.com' }], accountId: account })).rejects.toBeInstanceOf(DraftInputError);
    await expect(draftService.createUser(scope, { ...fields, accountId: other })).rejects.toThrow('not found');
  });
  it('forces browser attribution to user and rejects forged actor fields', async () => {
    const routes = createDraftRoutes(service(), { expectedOrigin: 'https://mail.example.test' });
    const body = { ...fields, accountId: account };
    expect((await routes.create({ method: 'POST', auth: scope, origin: 'https://evil.test', body })).status).toBe(403);
    expect((await routes.create({ method: 'POST', auth: null, origin: 'https://mail.example.test', body })).status).toBe(401);
    expect((await routes.create({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: { ...body, createdBy: 'agent' } })).status).toBe(400);
    const created = await routes.create({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body });
    expect((created.body['draft'] as DraftRecord).createdBy).toBe('user');
    const id = (created.body['draft'] as DraftRecord).id;
    expect((await routes.save({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: { ...fields, expectedVersion: 1, editor: 'agent' } }, id)).status).toBe(400);
    const stale = { ...scope, freshAuthAt: '2024-12-31T23:00:00.000Z' };
    expect((await routes.beginApproval({ method: 'POST', auth: stale, origin: 'https://mail.example.test', body: { expectedVersion: 1, confirmation: 'a'.repeat(16) } }, id)).status).toBe(401);
  });
  it('does not quote client content and rejects unavailable or cross-account source messages', async () => {
    const routes = createDraftRoutes(service(), { expectedOrigin: 'https://mail.example.test' });
    const injected = { ...fields, accountId: account, sourceMessageId: sourceId, sourceMessage: { from: 'attacker@example.com', body: 'untrusted' } };
    expect((await routes.reply({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: injected })).status).toBe(400);
    const reply = await routes.reply({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: { ...fields, accountId: account, sourceMessageId: sourceId } });
    expect((reply.body['draft'] as DraftRecord).body).toContain('sender@example.com');
    const crossAccountReader = new SourceReader([{ ...source, accountId: other }]);
    const crossRoutes = createDraftRoutes(service(new Provider(), crossAccountReader), { expectedOrigin: 'https://mail.example.test' });
    expect((await crossRoutes.reply({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: { ...fields, accountId: account, sourceMessageId: sourceId } })).status).toBe(404);
  });
  it('rereads stale drafts, rejects replay, and deduplicates double-click sends with immutable approval key', async () => {
    const provider = new Provider(); const draftService = service(provider); const draft = await draftService.createUser(scope, { ...fields, accountId: account });
    const confirmation = 'c'.repeat(16); const approval = await draftService.beginApproval(scope, draft.id, 1, confirmation);
    await draftService.editUser(scope, draft.id, 1, { ...fields, body: 'newer' });
    await expect(draftService.confirmSend(scope, approval.approvalId, confirmation)).rejects.toThrow('stale');
    const fresh = await draftService.beginApproval(scope, draft.id, 2, confirmation);
    const [first, second] = await Promise.allSettled([draftService.confirmSend(scope, fresh.approvalId, confirmation), draftService.confirmSend(scope, fresh.approvalId, confirmation)]);
    expect(first.status === 'fulfilled' || second.status === 'fulfilled').toBe(true); expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.idempotencyKey).toBe(`send:${fresh.approvalId}:${draft.id}:2`);
    await expect(draftService.confirmSend(scope, fresh.approvalId, confirmation)).rejects.toThrow('already used');
  });
  it('binds reused confirmation text to each approval so distinct drafts can be sent', async () => {
    const provider = new Provider(); let sequence = 100;
    const draftService = new DraftService(new InMemoryDraftRepository(), provider, new SourceReader(), clock, () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`);
    const first = await draftService.createUser(scope, { ...fields, accountId: account });
    const second = await draftService.createUser(scope, { ...fields, accountId: account });
    const confirmation = 'r'.repeat(16);
    const firstApproval = await draftService.beginApproval(scope, first.id, 1, confirmation);
    const secondApproval = await draftService.beginApproval(scope, second.id, 1, confirmation);
    await Promise.all([draftService.confirmSend(scope, firstApproval.approvalId, confirmation), draftService.confirmSend(scope, secondApproval.approvalId, confirmation)]);
    expect(provider.calls).toHaveLength(2);
  });
  it('records provider failure as failed while preserving editable content', async () => {
    const provider = new Provider(); provider.fail = true; const draftService = service(provider); const draft = await draftService.createUser(scope, { ...fields, accountId: account });
    const approval = await draftService.beginApproval(scope, draft.id, 1, 'x'.repeat(16)); const result = await draftService.confirmSend(scope, approval.approvalId, 'x'.repeat(16));
    expect(result).toMatchObject({ state: 'failed', body: 'Body', version: 2 });
    await expect(draftService.editUser(scope, draft.id, 2, { ...fields, body: 'retry body' })).resolves.toMatchObject({ state: 'editing', body: 'retry body', version: 3 });
  });
  it('does not recast a successful provider response as provider failure when completion fails', async () => {
    const provider = new Provider(); const repository = new CompletionFailingRepository();
    const draftService = new DraftService(repository, provider, new SourceReader(), clock, () => '00000000-0000-4000-8000-000000000099');
    const draft = await draftService.createUser(scope, { ...fields, accountId: account });
    const approval = await draftService.beginApproval(scope, draft.id, 1, 'y'.repeat(16));
    await expect(draftService.confirmSend(scope, approval.approvalId, 'y'.repeat(16))).rejects.toThrow('completion unavailable');
    expect(provider.calls).toHaveLength(1); expect(repository.outcomes).toEqual(['sent']);
  });
  it('keeps agent and policy packages structurally unable to use the provider boundary', async () => {
    const root = resolve(process.cwd());
    const sources = await Promise.all(['packages/agent', 'packages/policy'].map((directory) => readFile(resolve(root, directory, 'package.json'), 'utf8')));
    expect(sources.join('\n')).not.toContain('@hypermail/send');
    const sendSource = await readFile(resolve(root, 'packages/send/src/index.ts'), 'utf8');
    expect(sendSource).not.toMatch(/from ['"]@hypermail\/(agent|policy)['"]/);
  });
});
