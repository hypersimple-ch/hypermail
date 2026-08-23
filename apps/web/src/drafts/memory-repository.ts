/* eslint-disable @typescript-eslint/require-await -- synchronous reference repository satisfies asynchronous port. */
import type { ApprovalClaim, ApprovalMutation, ClaimMutation, DraftActor, DraftFields, DraftMutation, DraftRecord, DraftRepository, DraftRevision, DraftScope, SendApproval } from './contracts.js';

const cloneFields = (draft: DraftFields): DraftFields => ({ recipients: draft.recipients.map((recipient) => ({ ...recipient })), subject: draft.subject, body: draft.body, bodyFormat: draft.bodyFormat });
const cloneDraft = (draft: DraftRecord): DraftRecord => ({ ...draft, ...cloneFields(draft) });
const visible = (scope: DraftScope, draft: DraftRecord | undefined): draft is DraftRecord => Boolean(draft && scope.accountIds.includes(draft.accountId));

/** Reference implementation with atomic synchronous claim semantics for tests/adapters. */
export class InMemoryDraftRepository implements DraftRepository {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly revisions = new Map<string, DraftRevision[]>();
  private readonly approvals = new Map<string, SendApproval>();
  private readonly confirmationHashes = new Set<string>();
  private readonly consumed = new Set<string>();
  private sequence = 0;
  constructor(seed: readonly DraftRecord[] = []) { for (const draft of seed) { this.drafts.set(draft.id, cloneDraft(draft)); this.revisions.set(draft.id, [{ draftId: draft.id, version: draft.version, editor: draft.createdBy, snapshot: cloneFields(draft), createdAt: draft.createdAt }]); } }
  async create(scope: DraftScope, input: Omit<DraftRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<DraftRecord> {
    const now = new Date().toISOString(); const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`; const draft: DraftRecord = { ...input, id, version: 1, createdAt: now, updatedAt: now, ...cloneFields(input) };
    this.drafts.set(draft.id, draft); this.revisions.set(draft.id, [{ draftId: draft.id, version: 1, editor: input.createdBy, snapshot: cloneFields(draft), createdAt: now }]); return cloneDraft(draft);
  }
  async get(scope: DraftScope, id: string): Promise<DraftRecord | null> { const draft = this.drafts.get(id); return visible(scope, draft) ? cloneDraft(draft) : null; }
  async edit(scope: DraftScope, id: string, expected: number, fields: DraftFields, editor: DraftActor): Promise<DraftMutation> {
    const draft = this.drafts.get(id); if (!visible(scope, draft)) return { kind: 'not_found' }; if (draft.version !== expected) return { kind: 'conflict', currentVersion: draft.version }; if (draft.state !== 'editing' && draft.state !== 'failed') return { kind: 'blocked', reason: 'Only editable drafts can be changed.' };
    const next: DraftRecord = { ...draft, ...cloneFields(fields), state: 'editing', version: draft.version + 1, updatedAt: new Date().toISOString() }; this.drafts.set(id, next); this.revisions.get(id)?.push({ draftId: id, version: next.version, editor, snapshot: cloneFields(next), createdAt: next.updatedAt }); return { kind: 'updated', draft: cloneDraft(next) };
  }
  async history(scope: DraftScope, id: string): Promise<readonly DraftRevision[] | null> { const draft = this.drafts.get(id); return visible(scope, draft) ? (this.revisions.get(id) ?? []).map((revision) => ({ ...revision, snapshot: cloneFields(revision.snapshot) })) : null; }
  async createApproval(scope: DraftScope, id: string, expected: number, confirmationHash: string, expiresAt: string, key: string): Promise<ApprovalMutation> {
    const draft = this.drafts.get(id); if (!visible(scope, draft)) return { kind: 'not_found' }; if (draft.version !== expected) return { kind: 'conflict', currentVersion: draft.version }; if (draft.state !== 'editing' && draft.state !== 'failed') return { kind: 'blocked', reason: 'Only editable drafts can be approved.' };
    if (this.confirmationHashes.has(confirmationHash)) throw new Error('Approval confirmation hash must be unique.');
    const approval: SendApproval = { id: key.split(':')[1] ?? key, draftId: id, draftVersion: expected, userId: scope.subjectId, confirmationHash, idempotencyKey: key, expiresAt }; this.approvals.set(approval.id, approval); this.confirmationHashes.add(confirmationHash); return { kind: 'created', approval };
  }
  async claimApproval(scope: DraftScope, id: string, confirmationHash: string, now: string): Promise<ClaimMutation> {
    const approval = this.approvals.get(id); if (!approval) return { kind: 'not_found' }; const draft = this.drafts.get(approval.draftId);
    if (!visible(scope, draft) || approval.userId !== scope.subjectId) return { kind: 'not_found' };
    if (this.consumed.has(id)) return { kind: 'rejected', reason: 'This confirmation was already used.' };
    if (approval.confirmationHash !== confirmationHash || approval.expiresAt <= now || draft.version !== approval.draftVersion || (draft.state !== 'editing' && draft.state !== 'failed')) return { kind: 'rejected', reason: 'This confirmation is stale or invalid.' };
    const snapshot = cloneDraft(draft); this.consumed.add(id); this.drafts.set(draft.id, { ...draft, state: 'sending', updatedAt: now }); return { kind: 'claimed', claim: { approval, draft: snapshot } };
  }
  async completeSend(scope: DraftScope, claim: ApprovalClaim, outcome: 'sent' | 'failed'): Promise<DraftRecord> {
    const draft = this.drafts.get(claim.draft.id); if (!visible(scope, draft) || draft.state !== 'sending') throw new Error('Send completion lost its scoped draft.');
    const next: DraftRecord = { ...draft, state: outcome === 'sent' ? 'sent' : 'failed', version: draft.version + 1, updatedAt: new Date().toISOString() }; this.drafts.set(draft.id, next); return cloneDraft(next);
  }
}
