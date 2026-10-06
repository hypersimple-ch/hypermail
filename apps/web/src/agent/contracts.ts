import { ownerActionCorrectionSchema, type OwnerActionCorrection, type PlannedAction } from '@hypermail/contracts';
import type { ReviewResult } from '@hypermail/db';
import { z } from 'zod';

/** Framework-neutral owner-scoped Agent presentation. */
export type AgentScope = Readonly<{ subjectId: string; accountIds: readonly string[] }>;
export type AutonomyScope = Readonly<{ kind: 'global' } | { kind: 'account'; accountId: string }>;
export type AutonomyState = 'running' | 'paused';
export type ActionStatus = 'proposed' | 'completed' | 'failed' | 'blocked';

export type AgentAction = Readonly<{
  id: string;
  accountId: string;
  version: number;
  title: string;
  reason: string;
  status: ActionStatus;
  outcome?: string;
  verification?: string;
  recoverable: boolean;
  reversalHref?: string;
  questionId?: string;
}>;

export type AgentQuestion = Readonly<{
  id: string;
  accountId: string;
  version: number;
  prompt: string;
  state: 'open' | 'answered';
}>;

export type AgentAlert = Readonly<{
  id: string;
  kind: 'account_health' | 'poll_failure' | 'safety_pause';
  message: string;
  accountId?: string;
}>;

export type AutonomyStatus = Readonly<{ state: AutonomyState; version: number }>;

export type AgentProposal = Readonly<{
  id: string; activityId: string; accountId: string; runId: string;
  origin: 'model' | 'owner'; kind: string; payload: PlannedAction | OwnerActionCorrection;
  confidence: number | null; threshold: number; revision: number;
  state: 'waiting_review' | 'ready' | 'authorized' | 'rejected' | 'superseded' | 'blocked';
  reason: string; evidenceSnapshot: unknown;
  dependencies: readonly { proposalId: string; state: string; actionState: string | null }[];
  action: { id: string; state: string; errorCode: string | null } | null;
  supersedesProposalId: string | null; createdAt: string;
}>;
export const proposalReviewSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200).refine((key) => key.trim().length > 0),
  decision: z.enum(['approve', 'reject', 'correct']),
  reason: z.string().max(2000).optional(),
  correction: ownerActionCorrectionSchema.optional(),
}).superRefine((input, context) => {
  if ((input.decision === 'correct') !== (input.correction !== undefined))
    context.addIssue({ code: 'custom', path: ['correction'], message: 'Only a correction decision requires a correction.' });
});
export type ProposalReviewRequest = z.infer<typeof proposalReviewSchema> & { proposalId: string };
export type ProposalReviewResult = ReviewResult;
export type ProposalFolder = Readonly<{ id: string; name: string; accountId: string }>;

export type AgentDashboard = Readonly<{
  actions: readonly AgentAction[];
  proposals: readonly AgentProposal[];
  questions: readonly AgentQuestion[];
  alerts: readonly AgentAlert[];
  autonomy: Readonly<{ global: AutonomyStatus; accounts: Readonly<Record<string, AutonomyStatus>> }>;
}>;

export type AnswerResult =
  | Readonly<{ kind: 'answered'; question: AgentQuestion }>
  | Readonly<{ kind: 'duplicate'; question: AgentQuestion }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; currentVersion: number }>;
export type RetryResult =
  | Readonly<{ kind: 'queued'; action: AgentAction }>
  | Readonly<{ kind: 'blocked'; reason: string }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; currentVersion: number }>;
export type AutonomyResult =
  | Readonly<{ kind: 'updated'; state: AutonomyState }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; currentVersion: number }>;

/** All implementations must authorize against scope; these ports never mutate mailbox content. */
export interface AgentRepository {
  dashboard(scope: AgentScope): Promise<AgentDashboard>;
  listProposals(scope: AgentScope, activityId?: string): Promise<readonly AgentProposal[] | null>;
  reviewProposal(scope: AgentScope, proposalId: string, input: z.infer<typeof proposalReviewSchema>): Promise<ProposalReviewResult>;
  listProposalFolders(scope: AgentScope, accountId?: string): Promise<readonly ProposalFolder[] | null>;
  answerQuestion(scope: AgentScope, questionId: string, answer: string, expectedVersion: number, idempotencyKey: string): Promise<AnswerResult>;
  retryAction(scope: AgentScope, actionId: string, expectedVersion: number): Promise<RetryResult>;
  setAutonomy(scope: AgentScope, target: AutonomyScope, state: AutonomyState, expectedVersion: number): Promise<AutonomyResult>;
}

export class AgentInputError extends Error { constructor(message: string) { super(message); this.name = 'AgentInputError'; } }
export class AgentAuthorizationError extends Error { constructor() { super('Authentication is required.'); this.name = 'AgentAuthorizationError'; } }
export class AgentConflictError extends Error { constructor() { super('Agent state changed; refresh and try again.'); this.name = 'AgentConflictError'; } }
export class AgentBlockedError extends Error { constructor(message: string) { super(message); this.name = 'AgentBlockedError'; } }
export class AgentNotFoundError extends Error { constructor() { super('Agent item not found.'); this.name = 'AgentNotFoundError'; } }
export class AgentReviewForbiddenError extends Error { constructor(message: string) { super(message); this.name = 'AgentReviewForbiddenError'; } }
