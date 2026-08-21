import { describe, expect, it } from 'vitest';
import {
  agentActionSchema,
  agentActivitySchema,
  agentRunSchema,
  appendAgentActivityEvent,
  completeAgentRun,
  finishAgentAction,
  recordAgentActionProviderReport,
  startAgentAction,
  startAgentRun,
  transitionAgentActivity,
  validateAgentActionRetry,
  validateAgentRunContinuation,
  verifyAgentAction,
  type AgentAction,
  type AgentActivityEvent,
  type AgentRun,
} from '../src/index.js';

const id = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const userId = id(1);
const mailboxId = id(2);
const activityId = id(3);
const runId = id(4);
const assignmentId = id(5);
const grantId = id(6);
const connectionId = id(7);
const actionId = id(8);
const messageId = id(9);
const t0 = '2026-08-10T12:00:00.000Z';
const t1 = '2026-08-10T12:01:00.000Z';
const t2 = '2026-08-10T12:02:00.000Z';
const digest = 'a'.repeat(64);

const run = (): AgentRun => agentRunSchema.parse({
  id: runId,
  activityId,
  userId,
  mailboxId,
  sequence: 1,
  manager: { kind: 'agent_connection', connectionId },
  managerLifecycleRevision: 9,
  assignmentId,
  assignmentRevision: 4,
  grantId,
  grantRevision: 7,
  safetyRevision: 3,
  mode: 'automatic',
  trigger: { kind: 'arrival', messageId },
  inputDigest: digest,
  correlationId: 'correlation-1',
  causationId: messageId,
  state: 'created',
  outcome: null,
  errorCode: null,
  createdAt: t0,
  startedAt: null,
  completedAt: null,
});

const action = (overrides: Partial<AgentAction> = {}): AgentAction => agentActionSchema.parse({
  id: actionId,
  activityId,
  runId,
  userId,
  mailboxId,
  correlationId: 'correlation-1',
  causationId: runId,
  manager: { kind: 'agent_connection', connectionId },
  managerLifecycleRevision: 9,
  mode: 'automatic',
  assignmentId,
  assignmentRevision: 4,
  grantId,
  grantRevision: 7,
  safetyRevision: 3,
  kind: 'archive',
  target: { messageId },
  authorizationRevision: 7,
  idempotencyKey: 'authorized-action-0001',
  attempt: 1,
  retryOfActionId: null,
  state: 'authorized',
  errorCode: null,
  authorizedAt: t0,
  startedAt: null,
  providerReportedAt: null,
  completedAt: null,
  verification: null,
  ...overrides,
});

describe('Agent Activity aggregate', () => {
  it('supports interactive work without an incoming message and preserves tenant identity', () => {
    const activity = agentActivitySchema.parse({
      id: activityId, userId, mailboxId, kind: 'interactive_request', sourceMessageId: null,
      correlationId: 'correlation-1', causationId: null, state: 'open', revision: 1, createdAt: t0, updatedAt: t0,
    });
    const waiting = transitionAgentActivity(activity, 'waiting_for_answer', t1);
    expect(waiting).toMatchObject({ userId, mailboxId, state: 'waiting_for_answer', revision: 2 });
    expect(activity).toMatchObject({ state: 'open', revision: 1 });
    expect(() => transitionAgentActivity(waiting, 'acknowledged', t2)).toThrow(/Illegal Agent Activity transition/);
  });

  it('requires arrival identity and rejects unknown or backwards temporal data', () => {
    const base = { id: activityId, userId, mailboxId, kind: 'arrival', sourceMessageId: null, correlationId: 'correlation-1', causationId: messageId, state: 'open', revision: 1, createdAt: t1, updatedAt: t0 };
    expect(() => agentActivitySchema.parse(base)).toThrow(/source message/);
    expect(() => agentActivitySchema.parse({ ...base, sourceMessageId: messageId })).toThrow(/updatedAt/);
    expect(() => agentActivitySchema.parse({ ...base, sourceMessageId: messageId, updatedAt: t1, secret: 'no' })).toThrow();
  });
});

describe('immutable Agent Runs', () => {
  it('freezes manager and authorization revisions and uses a bounded lifecycle', () => {
    const initial = run();
    const running = startAgentRun(initial, t1);
    const completed = completeAgentRun(running, 'action_requests_emitted', t2);
    expect(completed).toMatchObject({
      state: 'completed', outcome: 'action_requests_emitted', managerLifecycleRevision: 9,
      assignmentRevision: 4, grantRevision: 7, safetyRevision: 3,
    });
    expect(initial).toMatchObject({ state: 'created', startedAt: null, outcome: null });
    expect(() => startAgentRun(completed, t2)).toThrow(/Illegal Agent Run transition/);
  });

  it('does not admit None/fallback managers or mutation-success Run outcomes', () => {
    expect(() => agentRunSchema.parse({ ...run(), manager: { kind: 'none' }, managerLifecycleRevision: null })).toThrow();
    expect(() => agentRunSchema.parse({ ...run(), outcome: 'succeeded' })).toThrow();
    expect(() => agentRunSchema.parse({ ...run(), managerLifecycleRevision: null })).toThrow(/lifecycle revision/);
  });

  it('models answered questions as new continuation Runs rather than reopening history', () => {
    const prior = completeAgentRun(startAgentRun(run(), t1), 'question_asked', t2);
    const continuation = agentRunSchema.parse({
      ...run(), id: id(15), sequence: 2, mode: 'interactive',
      trigger: { kind: 'question_answer', questionEventId: id(16), priorRunId: prior.id },
      causationId: id(16), createdAt: '2026-08-10T12:03:00.000Z',
    });
    expect(validateAgentRunContinuation(prior, continuation)).toEqual(continuation);
    expect(prior).toMatchObject({ state: 'completed', outcome: 'question_asked' });
    expect(() => validateAgentRunContinuation(prior, { ...continuation, id: prior.id })).toThrow(/new sequential Run/);
  });

  it('requires a failed outcome to carry an error code', () => {
    const running = startAgentRun(run(), t1);
    expect(() => completeAgentRun(running, 'failed', t2)).toThrow(/errorCode/);
    expect(completeAgentRun(running, 'failed', t2, 'MODEL_TIMEOUT').errorCode).toBe('MODEL_TIMEOUT');
  });
});

describe('authorized Agent Actions', () => {
  it('cannot turn connector-reported success into verified success', () => {
    const executing = startAgentAction(action(), t1);
    const awaitingReadback = recordAgentActionProviderReport(executing, t2);
    expect(awaitingReadback).toMatchObject({ state: 'verifying', verification: null, completedAt: null });
    expect(() => agentActionSchema.parse({ ...awaitingReadback, state: 'verified', completedAt: t2 })).toThrow(/readback evidence/);
  });

  it('marks verified only with bound Hypermail provider readback evidence', () => {
    const awaitingReadback = recordAgentActionProviderReport(startAgentAction(action(), t1), t2);
    const proof = {
      actionId, mailboxId, verifier: 'hypermail_provider_readback' as const,
      providerMutationId: 'provider-change-42', evidenceDigest: digest, observedAt: '2026-08-10T12:03:00.000Z',
    };
    expect(verifyAgentAction(awaitingReadback, proof)).toMatchObject({ state: 'verified', verification: proof });
    expect(() => verifyAgentAction(awaitingReadback, { ...proof, mailboxId: id(20) })).toThrow(/identify this Action and Mailbox/);
  });

  it('keeps failed attempts terminal and validates retries as new linked records', () => {
    const failed = finishAgentAction(startAgentAction(action(), t1), 'failed', t2, 'PROVIDER_TIMEOUT');
    expect(() => startAgentAction(failed, t2)).toThrow(/Illegal Agent Action transition/);
    const retry = action({ id: id(10), attempt: 2, retryOfActionId: failed.id, authorizedAt: '2026-08-10T12:03:00.000Z' });
    expect(validateAgentActionRetry(failed, retry)).toEqual(retry);
    expect(() => validateAgentActionRetry(failed, action({ id: id(11), attempt: 2, retryOfActionId: id(12) }))).toThrow(/new authorized attempt/);
  });

  it('rejects non-mutation or unauthorized semantic records', () => {
    expect(() => agentActionSchema.parse({ ...action(), kind: 'mail.read' })).toThrow();
    expect(() => agentActionSchema.parse({ ...action(), state: 'denied' })).toThrow();
  });
});

describe('append-only owner-facing Activity Events', () => {
  const event = (overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent => ({
    id: id(13), activityId, userId, mailboxId, sequence: 1,
    correlationId: 'correlation-1', causationId: messageId, occurredAt: t0,
    detail: { type: 'authorization_denied', runId, reasonCode: 'GRANT_REVOKED' },
    ...overrides,
  });

  it('records denials, reads, questions, no-action, and drift without creating Actions', () => {
    const history = appendAgentActivityEvent([], event());
    const next = appendAgentActivityEvent(history, event({
      id: id(14), sequence: 2, occurredAt: t1,
      detail: { type: 'sensitive_read_summary', runId, capability: 'mail.read', itemCount: 2 },
    }));
    expect(next.map((item) => item.detail.type)).toEqual(['authorization_denied', 'sensitive_read_summary']);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('enforces strict payloads, tenant continuity, monotonic sequence, and chronology', () => {
    const history = appendAgentActivityEvent([], event());
    expect(() => appendAgentActivityEvent(history, event({ id: id(14), sequence: 3, occurredAt: t1 }))).toThrow(/sequence/);
    expect(() => appendAgentActivityEvent(history, event({ id: id(14), sequence: 2, mailboxId: id(20), occurredAt: t1 }))).toThrow(/identity/);
    expect(() => appendAgentActivityEvent(history, event({ id: id(14), sequence: 2, occurredAt: '2026-08-10T11:00:00.000Z' }))).toThrow(/chronology/);
    expect(() => appendAgentActivityEvent([], { ...event(), detail: { type: 'authorization_denied', runId, reasonCode: 'NO', auditSecret: 'no' } } as never)).toThrow();
  });
});
