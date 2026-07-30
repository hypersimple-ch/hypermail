/** Framework-neutral ports for the Agent surface. OM is opaque in milestone one. */
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

export type AgentDashboard = Readonly<{
  actions: readonly AgentAction[];
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
  answerQuestion(scope: AgentScope, questionId: string, answer: string, expectedVersion: number, idempotencyKey: string): Promise<AnswerResult>;
  retryAction(scope: AgentScope, actionId: string, expectedVersion: number): Promise<RetryResult>;
  setAutonomy(scope: AgentScope, target: AutonomyScope, state: AutonomyState, expectedVersion: number): Promise<AutonomyResult>;
}

export class AgentInputError extends Error { constructor(message: string) { super(message); this.name = 'AgentInputError'; } }
export class AgentAuthorizationError extends Error { constructor() { super('Authentication is required.'); this.name = 'AgentAuthorizationError'; } }
export class AgentConflictError extends Error { constructor() { super('Agent state changed; refresh and try again.'); this.name = 'AgentConflictError'; } }
export class AgentBlockedError extends Error { constructor(message: string) { super(message); this.name = 'AgentBlockedError'; } }
export class AgentNotFoundError extends Error { constructor() { super('Agent item not found.'); this.name = 'AgentNotFoundError'; } }
