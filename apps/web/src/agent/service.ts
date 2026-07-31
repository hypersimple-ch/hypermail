import {
  AgentAuthorizationError, AgentBlockedError, AgentConflictError, AgentInputError, AgentNotFoundError,
  type AgentAction, type AgentDashboard, type AgentRepository, type AgentScope, type AutonomyScope, type AutonomyState,
} from './contracts.js';

export class AgentService {
  constructor(private readonly repository: AgentRepository) {}

  async dashboard(scope: AgentScope): Promise<AgentDashboard> {
    if (!scope.subjectId) throw new AgentAuthorizationError();
    if (scope.accountIds.length === 0) return { actions: [], questions: [], alerts: [], autonomy: { global: { state: 'running', version: 1 }, accounts: {} } };
    return this.repository.dashboard(scope);
  }

  async answer(scope: AgentScope, questionId: string, answer: string, expectedVersion: number, idempotencyKey: string) {
    this.assertScope(scope); this.assertVersion(expectedVersion);
    if (!questionId || !idempotencyKey.trim()) throw new AgentInputError('A question and idempotency key are required.');
    const text = answer.trim();
    if (!text) throw new AgentInputError('Enter an answer before resuming.');
    const result = await this.repository.answerQuestion(scope, questionId, text, expectedVersion, idempotencyKey);
    if (result.kind === 'answered' || result.kind === 'duplicate') return result;
    if (result.kind === 'conflict') throw new AgentConflictError();
    throw new AgentNotFoundError();
  }

  async retry(scope: AgentScope, actionId: string, expectedVersion: number): Promise<AgentAction> {
    this.assertScope(scope); this.assertVersion(expectedVersion);
    const dashboard = await this.repository.dashboard(scope);
    const action = dashboard.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new AgentNotFoundError();
    const unanswered = action.questionId && dashboard.questions.find((question) => question.id === action.questionId && question.state === 'open');
    if (unanswered) throw new AgentBlockedError('Answer the open question before retrying this action.');
    const result = await this.repository.retryAction(scope, actionId, expectedVersion);
    if (result.kind === 'queued') return result.action;
    if (result.kind === 'blocked') throw new AgentBlockedError(result.reason);
    if (result.kind === 'conflict') throw new AgentConflictError();
    throw new AgentNotFoundError();
  }

  async setAutonomy(scope: AgentScope, target: AutonomyScope, state: AutonomyState, expectedVersion: number): Promise<AutonomyState> {
    this.assertScope(scope); this.assertVersion(expectedVersion);
    if (target.kind === 'account' && !scope.accountIds.includes(target.accountId)) throw new AgentNotFoundError();
    const result = await this.repository.setAutonomy(scope, target, state, expectedVersion);
    if (result.kind === 'updated') return result.state;
    if (result.kind === 'conflict') throw new AgentConflictError();
    throw new AgentNotFoundError();
  }

  private assertScope(scope: AgentScope): void {
    if (!scope.subjectId || scope.accountIds.length === 0) throw new AgentAuthorizationError();
  }
  private assertVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1) throw new AgentInputError('A positive expected version is required.');
  }
}

/** Browser runners can implement these against a same-origin adapter when a host is available. */
export const agentBrowserScenarios = [
  'At 360px, an authenticated user can open a question, enter an answer, submit once, and see “Answer recorded; work resumed.”',
  'A repeated submission using the same idempotency key reports the existing answer and does not resume work twice.',
  'An account-health, poll-failure, or safety-pause alert remains visible across polling refreshes until its source clears.',
  'A user can pause and resume global or account autonomy with keyboard and touch controls; reversals are links only when explicitly recoverable.',
] as const;
