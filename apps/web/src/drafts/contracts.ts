import { z } from 'zod';

export type DraftActor = 'user' | 'agent';
export type DraftBodyFormat = 'markdown' | 'html';
export type DraftState = 'editing' | 'ready' | 'sending' | 'sent' | 'failed' | 'discarded';
export type DraftScope = Readonly<{ subjectId: string; accountIds: readonly string[]; freshAuthAt?: string }>;
export const recipientSchema = z.strictObject({ kind: z.enum(['to', 'cc', 'bcc']), address: z.email() });
export const draftFieldsSchema = z.strictObject({ recipients: z.array(recipientSchema).max(100), subject: z.string().max(998), body: z.string().max(2_000_000), bodyFormat: z.enum(['markdown', 'html']) });
export const createDraftSchema = draftFieldsSchema.extend({ accountId: z.uuid() }).strict();
export const replyDraftSchema = createDraftSchema.extend({ sourceMessageId: z.uuid() }).strict();
export const editDraftSchema = draftFieldsSchema.extend({ expectedVersion: z.number().int().positive() }).strict();
export const approvalSchema = z.strictObject({ expectedVersion: z.number().int().positive(), confirmation: z.string().min(16).max(500) });

export type Recipient = z.infer<typeof recipientSchema>;
export type DraftFields = z.infer<typeof draftFieldsSchema>;
export type DraftRecord = Readonly<DraftFields & { id: string; accountId: string; sourceMessageId: string | null; createdBy: DraftActor; state: DraftState; version: number; createdAt: string; updatedAt: string }>;
export type DraftRevision = Readonly<{ draftId: string; version: number; editor: DraftActor; snapshot: DraftFields; createdAt: string }>;
export type SendApproval = Readonly<{ id: string; draftId: string; draftVersion: number; userId: string; confirmationHash: string; idempotencyKey: string; expiresAt: string }>;
export type ApprovalClaim = Readonly<{ approval: SendApproval; draft: DraftRecord }>;

export type DraftSource = Readonly<{ id: string; accountId: string; from: string; sentAt: string; subject: string; body: string }>;
/** Server-side reader: implementations must scope both account and source message before returning content. */
export interface DraftSourceReader {
  read(scope: DraftScope, accountId: string, sourceMessageId: string): Promise<DraftSource | null>;
}
/** Internal-only agent write port. Browser routes expose no actor-selecting operations. */
export interface AgentDraftWriter {
  createAgent(scope: DraftScope, input: { accountId: string } & DraftFields): Promise<DraftRecord>;
  editAgent(scope: DraftScope, draftId: string, expectedVersion: number, fields: DraftFields): Promise<DraftRecord>;
}

export interface DraftRepository {
  create(scope: DraftScope, draft: Omit<DraftRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<DraftRecord>;
  get(scope: DraftScope, draftId: string): Promise<DraftRecord | null>;
  edit(scope: DraftScope, draftId: string, expectedVersion: number, fields: DraftFields, editor: DraftActor): Promise<DraftMutation>;
  history(scope: DraftScope, draftId: string): Promise<readonly DraftRevision[] | null>;
  createApproval(scope: DraftScope, draftId: string, expectedVersion: number, confirmationHash: string, expiresAt: string, idempotencyKey: string): Promise<ApprovalMutation>;
  claimApproval(scope: DraftScope, approvalId: string, confirmationHash: string, now: string): Promise<ClaimMutation>;
  completeSend(scope: DraftScope, claim: ApprovalClaim, outcome: 'sent' | 'failed', providerMessageId?: string): Promise<DraftRecord>;
}
export type DraftMutation = Readonly<{ kind: 'updated'; draft: DraftRecord }> | Readonly<{ kind: 'not_found' }> | Readonly<{ kind: 'conflict'; currentVersion: number }> | Readonly<{ kind: 'blocked'; reason: string }>;
export type ApprovalMutation = Readonly<{ kind: 'created'; approval: SendApproval }> | Exclude<DraftMutation, Readonly<{ kind: 'updated'; draft: DraftRecord }>>;
export type ClaimMutation = Readonly<{ kind: 'claimed'; claim: ApprovalClaim }> | Readonly<{ kind: 'not_found' }> | Readonly<{ kind: 'rejected'; reason: string }>;

export class DraftInputError extends Error { constructor(message: string) { super(message); this.name = 'DraftInputError'; } }
export class DraftConflictError extends Error { constructor() { super('Draft changed; refresh and try again.'); this.name = 'DraftConflictError'; } }
export class DraftNotFoundError extends Error { constructor() { super('Draft not found.'); this.name = 'DraftNotFoundError'; } }
export class DraftBlockedError extends Error { constructor(message: string) { super(message); this.name = 'DraftBlockedError'; } }
export class FreshAuthRequiredError extends Error { constructor() { super('Recent authentication is required to send mail.'); this.name = 'FreshAuthRequiredError'; } }
export class SendRejectedError extends Error { constructor(message: string) { super(message); this.name = 'SendRejectedError'; } }

export function recipientProblem(recipients: readonly Recipient[]): string | null {
  if (!recipients.some((recipient) => recipient.kind === 'to')) return 'At least one To recipient is required.';
  const seen = new Set<string>();
  for (const recipient of recipients) { const key = recipient.address.toLowerCase(); if (seen.has(key)) return 'Each recipient address may appear only once.'; seen.add(key); }
  return null;
}
