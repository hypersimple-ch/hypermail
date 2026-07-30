import { createHash, randomUUID } from 'node:crypto';
import type { MailSendProvider } from '@hypermail/send';
import {
  type AgentDraftWriter, type ApprovalClaim, type DraftFields, type DraftRecord, type DraftRepository, type DraftScope, type DraftSourceReader,
  DraftBlockedError, DraftConflictError, DraftInputError, DraftNotFoundError, FreshAuthRequiredError, SendRejectedError,
  recipientProblem,
} from './contracts.js';

const FRESH_AUTH_MS = 5 * 60_000;
const APPROVAL_MS = 10 * 60_000;
const hash = (approvalId: string, confirmation: string): string => createHash('sha256').update(`${approvalId}${confirmation}`).digest('base64url');
const isoNow = (now: () => Date): string => now().toISOString();

/** Draft composition and the explicit user-only send approval orchestration. */
export class DraftService {
  constructor(private readonly repository: DraftRepository, private readonly provider: MailSendProvider, private readonly sourceReader: DraftSourceReader, private readonly now: () => Date = () => new Date(), private readonly ids: () => string = randomUUID) {}

  async createUser(scope: DraftScope, input: { accountId: string } & DraftFields): Promise<DraftRecord> { return this.create(scope, input, 'user'); }
  /** Internal-only port for trusted agent workers; browser routes never call this port. */
  readonly agentDraftWriter: AgentDraftWriter = { createAgent: (scope, input) => this.createAgent(scope, input), editAgent: (scope, draftId, expectedVersion, fields) => this.editAgent(scope, draftId, expectedVersion, fields) };
  private async createAgent(scope: DraftScope, input: { accountId: string } & DraftFields): Promise<DraftRecord> { return this.create(scope, input, 'agent'); }
  private async create(scope: DraftScope, input: { accountId: string } & DraftFields, createdBy: 'user' | 'agent'): Promise<DraftRecord> {
    this.scope(scope); this.fields(input);
    if (!scope.accountIds.includes(input.accountId)) throw new DraftNotFoundError();
    return this.repository.create(scope, { accountId: input.accountId, sourceMessageId: null, createdBy, state: 'editing', recipients: input.recipients, subject: input.subject, body: input.body });
  }
  async replyUser(scope: DraftScope, input: { accountId: string; sourceMessageId: string } & DraftFields): Promise<DraftRecord> {
    this.scope(scope); this.fields(input);
    if (!scope.accountIds.includes(input.accountId)) throw new DraftNotFoundError();
    const source = await this.sourceReader.read(scope, input.accountId, input.sourceMessageId);
    if (!source || source.accountId !== input.accountId) throw new DraftNotFoundError();
    const subject = source.subject.toLowerCase().startsWith('re:') ? source.subject : `Re: ${source.subject}`;
    const quote = `On ${source.sentAt}, ${source.from} wrote:\n${source.body.split('\n').map((line) => `> ${line}`).join('\n')}`;
    return this.repository.create(scope, { accountId: input.accountId, sourceMessageId: source.id, createdBy: 'user', state: 'editing', recipients: input.recipients, subject, body: input.body ? `${input.body}\n\n${quote}` : quote });
  }
  async editUser(scope: DraftScope, draftId: string, expectedVersion: number, fields: DraftFields): Promise<DraftRecord> { return this.edit(scope, draftId, expectedVersion, fields, 'user'); }
  private async editAgent(scope: DraftScope, draftId: string, expectedVersion: number, fields: DraftFields): Promise<DraftRecord> { return this.edit(scope, draftId, expectedVersion, fields, 'agent'); }
  private async edit(scope: DraftScope, draftId: string, expectedVersion: number, fields: DraftFields, editor: 'user' | 'agent'): Promise<DraftRecord> {
    this.scope(scope); this.version(expectedVersion); this.fields(fields);
    return this.unwrap(await this.repository.edit(scope, draftId, expectedVersion, fields, editor));
  }
  async detail(scope: DraftScope, draftId: string): Promise<DraftRecord> { this.scope(scope); const draft = await this.repository.get(scope, draftId); if (!draft) throw new DraftNotFoundError(); return draft; }
  async history(scope: DraftScope, draftId: string) { this.scope(scope); const history = await this.repository.history(scope, draftId); if (!history) throw new DraftNotFoundError(); return history; }
  async beginApproval(scope: DraftScope, draftId: string, expectedVersion: number, confirmation: string): Promise<{ approvalId: string; expiresAt: string }> {
    this.scope(scope); this.version(expectedVersion); this.fresh(scope);
    const id = this.ids(); const expiresAt = new Date(this.now().getTime() + APPROVAL_MS).toISOString();
    const result = await this.repository.createApproval(scope, draftId, expectedVersion, hash(id, confirmation), expiresAt, `send:${id}:${draftId}:${String(expectedVersion)}`);
    if (result.kind === 'created') return { approvalId: result.approval.id, expiresAt };
    if (result.kind === 'conflict') throw new DraftConflictError();
    if (result.kind === 'blocked') throw new DraftBlockedError(result.reason);
    throw new DraftNotFoundError();
  }
  /** Claims in a short DB transaction, then performs provider I/O after the transaction commits. */
  async confirmSend(scope: DraftScope, approvalId: string, confirmation: string): Promise<DraftRecord> {
    this.scope(scope); this.fresh(scope);
    const claim = await this.repository.claimApproval(scope, approvalId, hash(approvalId, confirmation), isoNow(this.now));
    if (claim.kind !== 'claimed') throw claim.kind === 'not_found' ? new DraftNotFoundError() : new SendRejectedError(claim.reason);
    return this.deliver(scope, claim.claim);
  }
  private async deliver(scope: DraftScope, claim: ApprovalClaim): Promise<DraftRecord> {
    let result: Awaited<ReturnType<MailSendProvider['send']>>;
    try {
      result = await this.provider.send({ approvalId: claim.approval.id, accountId: claim.draft.accountId, draftId: claim.draft.id, draftVersion: claim.draft.version, idempotencyKey: claim.approval.idempotencyKey, recipients: claim.draft.recipients, subject: claim.draft.subject, body: claim.draft.body });
    } catch {
      // Failure is recorded after provider I/O; the failed state remains editable and preserves content.
      return this.repository.completeSend(scope, claim, 'failed');
    }
    return this.repository.completeSend(scope, claim, 'sent', result.providerMessageId);
  }
  private fields(fields: DraftFields): void { const problem = recipientProblem(fields.recipients); if (problem) throw new DraftInputError(problem); }
  private scope(scope: DraftScope): void { if (!scope.subjectId || scope.accountIds.length === 0) throw new DraftInputError('An authenticated account scope is required.'); }
  private version(version: number): void { if (!Number.isInteger(version) || version < 1) throw new DraftInputError('A positive expected version is required.'); }
  private fresh(scope: DraftScope): void { const at = scope.freshAuthAt ? Date.parse(scope.freshAuthAt) : Number.NaN; if (!Number.isFinite(at) || this.now().getTime() - at > FRESH_AUTH_MS || at > this.now().getTime() + 60_000) throw new FreshAuthRequiredError(); }
  private unwrap(result: Awaited<ReturnType<DraftRepository['edit']>>): DraftRecord { if (result.kind === 'updated') return result.draft; if (result.kind === 'conflict') throw new DraftConflictError(); if (result.kind === 'blocked') throw new DraftBlockedError(result.reason); throw new DraftNotFoundError(); }
}

export const draftBrowserScenarios = ['Compose validates To recipients before autosave.', 'Autosave sends the displayed version and shows a conflict without overwriting newer content.', 'Reply previews quoted original context.', 'Only an explicit, recent-auth, same-origin confirmation may send.'] as const;
