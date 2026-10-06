import { describe, expect, it, vi } from 'vitest';
import type { ApprovedSend, MailSendProvider } from '@hypermail/send';
import { type ApprovalClaim, type DraftRecord, type DraftScope, type DraftSource, type DraftSourceReader, DraftConflictError, DraftInputError, DraftService, InMemoryDraftRepository, createDraftRoutes } from '../../src/drafts/index.js';

const account = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000020';
const scope = { subjectId: '00000000-0000-4000-8000-000000000010', accountIds: [account], freshAuthAt: '2025-01-01T00:00:00.000Z' } as const;
const fields = { recipients: [{ kind: 'to' as const, address: 'person@example.com' }], subject: 'Hello', body: 'Body', bodyFormat: 'markdown' as const };
const clock = () => new Date('2025-01-01T00:01:00.000Z');
const source: DraftSource = { id: sourceId, accountId: account, from: 'sender@example.com', sentAt: '2024-12-31T00:00:00.000Z', subject: 'Question', body: 'Original\ntext' };
class SourceReader implements DraftSourceReader {
  constructor(private readonly sources: readonly DraftSource[] = [source]) {}
  read(readerScope: DraftScope, accountId: string, id: string) { return Promise.resolve(this.sources.find((item) => item.id === id && item.accountId === accountId && readerScope.accountIds.includes(accountId)) ?? null); }
}
class Provider implements MailSendProvider { calls:ApprovedSend[]=[];fail=false;submit(message:ApprovedSend){this.calls.push(message);return Promise.resolve(this.fail?{state:'rejected' as const,reasonCode:'PROVIDER_REJECTED'}:{state:'reported' as const,reference:{kind:'native_id' as const,value:'message-1'}});}status(){return Promise.resolve({state:'verified' as const,providerMessageId:'message-1',observedAt:'2025-01-01T00:01:00.000Z',evidence:{source:'hypermail_readback'}});} }
const service = (provider: MailSendProvider = new Provider(), sourceReader = new SourceReader()) => {
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
  it('requires an explicit browser body format and preserves HTML through revision and send', async () => {
    const provider = new Provider(); const draftService = service(provider);
    const routes = createDraftRoutes(draftService, { expectedOrigin: 'https://mail.example.test' });
    const omitted = await routes.create({ method: 'POST', auth: scope, origin: 'https://mail.example.test', body: { recipients: fields.recipients, subject: fields.subject, body: fields.body, accountId: account } });
    expect(omitted.status).toBe(400);
    const draft = await draftService.createUser(scope, { ...fields, accountId: account, body: '<p>Rich body</p>', bodyFormat: 'html' });
    expect(draft.bodyFormat).toBe('html');
    expect((await draftService.history(scope, draft.id))[0]?.snapshot.bodyFormat).toBe('html');
    const approval = await draftService.beginApproval(scope, draft.id, 1, 'h'.repeat(16));
    await draftService.confirmSend(scope, approval.approvalId, 'h'.repeat(16));
    expect(provider.calls[0]).toMatchObject({ body: '<p>Rich body</p>', bodyFormat: 'html' });
  });
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
  it('sanitizes rich HTML before durable persistence and provider approval', async () => {
    const draftService = service();
    const body = '<p onclick="steal()"><span style="font-size: 18px; color: red; background-image: url(javascript:bad)">Safe</span><script>bad()</script><a href="javascript:bad">link</a></p>';
    const draft = await draftService.createUser(scope, { ...fields, accountId: account, body, bodyFormat: 'html' });
    expect(draft.body).toContain('font-size:18px');
    expect(draft.body).toContain('Safe');
    expect(draft.body).toContain('link');
    for (const unsafe of ['onclick', '<script', 'bad()', '<a', 'javascript:', 'color:', 'background-image']) expect(draft.body).not.toContain(unsafe);
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
  it('keeps ambiguous sends noneditable and reconciles without another submission',async()=>{
    const submit=vi.fn<MailSendProvider['submit']>().mockResolvedValue({state:'unknown',reasonCode:'PROVIDER_SUBMISSION_AMBIGUOUS'});
    const status=vi.fn<MailSendProvider['status']>().mockResolvedValue({state:'unknown',reasonCode:'PROVIDER_SENT_ID_UNVERIFIABLE'});
    const draftService=service({submit,status});const draft=await draftService.createUser(scope,{...fields,accountId:account});
    const approval=await draftService.beginApproval(scope,draft.id,1,'z'.repeat(16));
    expect((await draftService.confirmSend(scope,approval.approvalId,'z'.repeat(16))).state).toBe('sending');
    await expect(draftService.editUser(scope,draft.id,1,fields)).rejects.toThrow('editable');
    await draftService.reconcile(scope,draft.id,approval.approvalId,1);
    expect(submit).toHaveBeenCalledOnce();expect(status).toHaveBeenCalledTimes(2);
  });

});
