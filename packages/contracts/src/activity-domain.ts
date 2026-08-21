import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './domain.js';

const positiveRevisionSchema = z.number().int().positive();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest.');
const correlationIdSchema = z.string().trim().min(8).max(200);
const nonEmptyTextSchema = z.string().trim().min(1).max(4_000);

const atOrAfter = (later: string, earlier: string): boolean => Date.parse(later) >= Date.parse(earlier);

/** Owner-facing work item. This intentionally does not replace the legacy message-only Activity contract. */
export const agentActivityKindSchema = z.enum(['arrival', 'interactive_request', 'safety_event', 'external_change']);
export const agentActivityStateSchema = z.enum(['open', 'waiting_for_answer', 'resolved', 'attention_required', 'acknowledged']);
export const agentActivitySchema = z.strictObject({
  id: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  kind: agentActivityKindSchema,
  sourceMessageId: idSchema.nullable(),
  correlationId: correlationIdSchema,
  causationId: idSchema.nullable(),
  state: agentActivityStateSchema,
  revision: positiveRevisionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).superRefine((activity, context) => {
  if (activity.kind === 'arrival' && activity.sourceMessageId === null) {
    context.addIssue({ code: 'custom', path: ['sourceMessageId'], message: 'Arrival Activities require a source message.' });
  }
  if (activity.kind !== 'arrival' && activity.sourceMessageId !== null) {
    context.addIssue({ code: 'custom', path: ['sourceMessageId'], message: 'Only arrival Activities may have a source message.' });
  }
  if (!atOrAfter(activity.updatedAt, activity.createdAt)) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt must not precede createdAt.' });
  }
});

export const agentRunManagerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mastra') }),
  z.strictObject({ kind: z.literal('agent_connection'), connectionId: idSchema }),
  z.strictObject({ kind: z.literal('legacy_mastra'), legacySourceId: z.string().trim().min(1).max(200) }),
]);
export const agentRunStateSchema = z.enum(['created', 'running', 'completed']);
/** Terminal Run results deliberately never claim that a mailbox mutation succeeded. */
export const agentRunOutcomeSchema = z.enum([
  'action_requests_emitted',
  'question_asked',
  'no_action',
  'failed',
  'cancelled',
]);
export const agentRunTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('arrival'), messageId: idSchema }),
  z.strictObject({ kind: z.literal('interactive_request'), requestId: idSchema }),
  z.strictObject({ kind: z.literal('question_answer'), questionEventId: idSchema, priorRunId: idSchema }),
  z.strictObject({ kind: z.literal('retry'), priorRunId: idSchema }),
  z.strictObject({ kind: z.literal('legacy_projection'), legacyRecordId: z.string().trim().min(1).max(200) }),
]);

export const agentRunSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  sequence: positiveRevisionSchema,
  manager: agentRunManagerSchema,
  managerLifecycleRevision: positiveRevisionSchema.nullable(),
  assignmentId: idSchema,
  assignmentRevision: positiveRevisionSchema,
  grantId: idSchema,
  grantRevision: positiveRevisionSchema,
  safetyRevision: positiveRevisionSchema,
  mode: z.enum(['interactive', 'automatic']),
  trigger: agentRunTriggerSchema,
  inputDigest: digestSchema,
  correlationId: correlationIdSchema,
  causationId: idSchema.nullable(),
  state: agentRunStateSchema,
  outcome: agentRunOutcomeSchema.nullable(),
  errorCode: z.string().trim().min(1).max(100).nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
}).superRefine((run, context) => {
  const external = run.manager.kind === 'agent_connection';
  if (external !== (run.managerLifecycleRevision !== null)) {
    context.addIssue({ code: 'custom', path: ['managerLifecycleRevision'], message: 'Only external Managers require a frozen lifecycle revision.' });
  }
  if (run.state === 'created' && (run.startedAt !== null || run.completedAt !== null || run.outcome !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'A created Run cannot have execution or outcome fields.' });
  }
  if (run.state === 'running' && (run.startedAt === null || run.completedAt !== null || run.outcome !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'A running Run requires startedAt and cannot have an outcome.' });
  }
  if (run.state === 'completed' && (run.startedAt === null || run.completedAt === null || run.outcome === null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'A completed Run requires timestamps and a terminal outcome.' });
  }
  if (run.outcome === 'failed' ? run.errorCode === null : run.errorCode !== null) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'errorCode is required only for failed Runs.' });
  }
  if (run.startedAt !== null && !atOrAfter(run.startedAt, run.createdAt)) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt must not precede createdAt.' });
  }
  if (run.completedAt !== null && run.startedAt !== null && !atOrAfter(run.completedAt, run.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'completedAt must not precede startedAt.' });
  }
});

export const agentActionKindSchema = z.enum([
  'archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread', 'draft_create', 'draft_edit', 'send',
]);
export const agentActionStateSchema = z.enum(['authorized', 'executing', 'verifying', 'verified', 'failed', 'unverifiable', 'cancelled']);
export const agentActionTargetSchema = z.strictObject({
  messageId: idSchema.optional(),
  draftId: idSchema.optional(),
  destinationFolderId: idSchema.optional(),
  requestId: idSchema.optional(),
});
export const providerVerificationSchema = z.strictObject({
  actionId: idSchema,
  mailboxId: idSchema,
  verifier: z.literal('hypermail_provider_readback'),
  providerMutationId: z.string().trim().min(1).max(500).optional(),
  evidenceDigest: digestSchema,
  observedAt: isoDateTimeSchema,
});

/** Exists only after authorization; requests, reads, questions, and denials are Activity Events instead. */
export const agentActionSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  runId: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  correlationId: correlationIdSchema,
  causationId: idSchema,
  manager: agentRunManagerSchema,
  managerLifecycleRevision: positiveRevisionSchema.nullable(),
  mode: z.enum(['interactive', 'automatic']),
  assignmentId: idSchema,
  assignmentRevision: positiveRevisionSchema,
  grantId: idSchema,
  grantRevision: positiveRevisionSchema,
  safetyRevision: positiveRevisionSchema,
  kind: agentActionKindSchema,
  target: agentActionTargetSchema,
  authorizationRevision: positiveRevisionSchema,
  idempotencyKey: z.string().trim().min(16).max(200),
  attempt: positiveRevisionSchema,
  retryOfActionId: idSchema.nullable(),
  state: agentActionStateSchema,
  errorCode: z.string().trim().min(1).max(100).nullable(),
  authorizedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  providerReportedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  verification: providerVerificationSchema.nullable(),
}).superRefine((action, context) => {
  const external = action.manager.kind === 'agent_connection';
  if (external !== (action.managerLifecycleRevision !== null)) {
    context.addIssue({ code: 'custom', path: ['managerLifecycleRevision'], message: 'Only external Managers require a frozen lifecycle revision.' });
  }
  const needsMessage = ['archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread'].includes(action.kind);
  const needsDraft = action.kind === 'draft_edit' || action.kind === 'send';
  if (action.kind === 'draft_create' && !action.target.requestId) context.addIssue({ code: 'custom', path: ['target', 'requestId'], message: 'Draft creation requires a request.' });
  if (needsMessage && !action.target.messageId) context.addIssue({ code: 'custom', path: ['target', 'messageId'], message: 'This mutation requires a message.' });
  if (needsDraft && !action.target.draftId) context.addIssue({ code: 'custom', path: ['target', 'draftId'], message: 'This mutation requires a draft.' });
  if (action.kind === 'move' && !action.target.destinationFolderId) context.addIssue({ code: 'custom', path: ['target', 'destinationFolderId'], message: 'Move requires a destination folder.' });
  if (action.attempt === 1 ? action.retryOfActionId !== null : action.retryOfActionId === null) {
    context.addIssue({ code: 'custom', path: ['retryOfActionId'], message: 'Retries must reference the prior immutable Action.' });
  }
  if (action.state === 'authorized' && (action.startedAt !== null || action.providerReportedAt !== null || action.completedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'An authorized Action has not started.' });
  }
  if (action.state === 'executing' && (action.startedAt === null || action.providerReportedAt !== null || action.completedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'An executing Action requires startedAt only.' });
  }
  if (action.state === 'verifying' && (action.startedAt === null || action.providerReportedAt === null || action.completedAt !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'A verifying Action requires the connector report but is not complete.' });
  }
  const terminal = ['verified', 'failed', 'unverifiable', 'cancelled'].includes(action.state);
  if (terminal !== (action.completedAt !== null)) context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Only terminal Actions have completedAt.' });
  if ((action.state === 'verified') !== (action.verification !== null)) context.addIssue({ code: 'custom', path: ['verification'], message: 'Verified Actions require Hypermail provider readback evidence.' });
  if (action.verification && (action.verification.actionId !== action.id || action.verification.mailboxId !== action.mailboxId)) {
    context.addIssue({ code: 'custom', path: ['verification'], message: 'Verification evidence must identify this Action and Mailbox.' });
  }
  if (action.state === 'failed' ? action.errorCode === null : action.errorCode !== null) context.addIssue({ code: 'custom', path: ['errorCode'], message: 'errorCode is required only for failed Actions.' });
  if (action.startedAt && !atOrAfter(action.startedAt, action.authorizedAt)) context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt must not precede authorization.' });
  if (action.providerReportedAt && action.startedAt && !atOrAfter(action.providerReportedAt, action.startedAt)) context.addIssue({ code: 'custom', path: ['providerReportedAt'], message: 'Provider report must not precede execution.' });
  if (action.completedAt && !atOrAfter(action.completedAt, action.startedAt ?? action.authorizedAt)) context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Completion must not precede the Action.' });
});

const eventDetailSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('run_started'), runId: idSchema }),
  z.strictObject({ type: z.literal('run_completed'), runId: idSchema, outcome: agentRunOutcomeSchema.exclude(['failed']) }),
  z.strictObject({ type: z.literal('run_failed'), runId: idSchema, errorCode: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('question_asked'), runId: idSchema, question: nonEmptyTextSchema }),
  z.strictObject({ type: z.literal('question_answered'), runId: idSchema, answerDigest: digestSchema }),
  z.strictObject({ type: z.literal('sensitive_read_summary'), runId: idSchema, capability: z.enum(['mail.read', 'attachment.read']), itemCount: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('authorization_denied'), runId: idSchema, reasonCode: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('action_authorized'), runId: idSchema, actionId: idSchema }),
  z.strictObject({ type: z.literal('action_started'), runId: idSchema, actionId: idSchema }),
  z.strictObject({ type: z.literal('action_provider_reported'), runId: idSchema, actionId: idSchema }),
  z.strictObject({ type: z.literal('action_verified'), runId: idSchema, actionId: idSchema }),
  z.strictObject({ type: z.literal('action_failed'), runId: idSchema, actionId: idSchema, errorCode: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('action_unverifiable'), runId: idSchema, actionId: idSchema, reasonCode: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('no_action'), runId: idSchema, reason: nonEmptyTextSchema }),
  z.strictObject({ type: z.literal('safety_event'), reasonCode: z.string().trim().min(1).max(100), summary: nonEmptyTextSchema }),
  z.strictObject({ type: z.literal('external_drift'), summary: nonEmptyTextSchema }),
  z.strictObject({ type: z.literal('send_approval_requested'), requestId: idSchema, draftId: idSchema, draftVersion: positiveRevisionSchema }),
  z.strictObject({ type: z.literal('send_approval_begun'), requestId: idSchema, approvalId: idSchema }),
  z.strictObject({ type: z.literal('send_rejected'), requestId: idSchema }),
  z.strictObject({ type: z.literal('send_approved'), requestId: idSchema, actionId: idSchema }),
  z.strictObject({ type: z.literal('send_failed'), requestId: idSchema, actionId: idSchema, reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }),
  z.strictObject({ type: z.literal('send_unverifiable'), requestId: idSchema, actionId: idSchema, reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }),
]);

/** Append-only owner-facing history; security audit records intentionally use a separate contract. */
export const agentActivityEventSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  sequence: positiveRevisionSchema,
  correlationId: correlationIdSchema,
  causationId: idSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  detail: eventDetailSchema,
});

export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type AgentRunOutcome = z.infer<typeof agentRunOutcomeSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionState = z.infer<typeof agentActionStateSchema>;
export type ProviderVerification = z.infer<typeof providerVerificationSchema>;
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>;

export class IllegalAgentWorkTransitionError extends Error {
  constructor(machine: string, from: string, to: string) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalAgentWorkTransitionError';
  }
}

const activityTransitions: Readonly<Record<AgentActivityState, readonly AgentActivityState[]>> = {
  open: ['waiting_for_answer', 'resolved', 'attention_required'],
  waiting_for_answer: ['open', 'attention_required'],
  resolved: ['acknowledged'],
  attention_required: ['open', 'resolved', 'acknowledged'],
  acknowledged: [],
};

export function transitionAgentActivity(activity: AgentActivity, to: AgentActivityState, at: string): AgentActivity {
  const current = agentActivitySchema.parse(activity);
  if (!activityTransitions[current.state].includes(to)) throw new IllegalAgentWorkTransitionError('Agent Activity', current.state, to);
  return agentActivitySchema.parse({ ...current, state: to, revision: current.revision + 1, updatedAt: at });
}

export function startAgentRun(run: AgentRun, at: string): AgentRun {
  const current = agentRunSchema.parse(run);
  if (current.state !== 'created') throw new IllegalAgentWorkTransitionError('Agent Run', current.state, 'running');
  return agentRunSchema.parse({ ...current, state: 'running', startedAt: at });
}

export function completeAgentRun(run: AgentRun, outcome: AgentRunOutcome, at: string, errorCode: string | null = null): AgentRun {
  const current = agentRunSchema.parse(run);
  if (current.state !== 'running') throw new IllegalAgentWorkTransitionError('Agent Run', current.state, 'completed');
  return agentRunSchema.parse({ ...current, state: 'completed', outcome, errorCode, completedAt: at });
}

/** Answering a question or retrying creates a new immutable invocation instead of reopening one. */
export function validateAgentRunContinuation(prior: AgentRun, continuation: AgentRun): AgentRun {
  const previous = agentRunSchema.parse(prior);
  const next = agentRunSchema.parse(continuation);
  const isAnsweredQuestion = next.trigger.kind === 'question_answer'
    && previous.outcome === 'question_asked'
    && next.trigger.priorRunId === previous.id;
  const isRetry = next.trigger.kind === 'retry'
    && (previous.outcome === 'failed' || previous.outcome === 'cancelled')
    && next.trigger.priorRunId === previous.id;
  if (previous.state !== 'completed' || next.state !== 'created' || (!isAnsweredQuestion && !isRetry)
    || next.id === previous.id || next.activityId !== previous.activityId || next.userId !== previous.userId
    || next.mailboxId !== previous.mailboxId || next.sequence !== previous.sequence + 1) {
    throw new RangeError('A continuation must be a new sequential Run linked to a compatible terminal Run.');
  }
  return next;
}

export function startAgentAction(action: AgentAction, at: string): AgentAction {
  const current = agentActionSchema.parse(action);
  if (current.state !== 'authorized') throw new IllegalAgentWorkTransitionError('Agent Action', current.state, 'executing');
  return agentActionSchema.parse({ ...current, state: 'executing', startedAt: at });
}

/** Connector-reported success starts verification; it can never produce `verified`. */
export function recordAgentActionProviderReport(action: AgentAction, at: string): AgentAction {
  const current = agentActionSchema.parse(action);
  if (current.state !== 'executing') throw new IllegalAgentWorkTransitionError('Agent Action', current.state, 'verifying');
  return agentActionSchema.parse({ ...current, state: 'verifying', providerReportedAt: at });
}

export function verifyAgentAction(action: AgentAction, proof: ProviderVerification): AgentAction {
  const current = agentActionSchema.parse(action);
  const evidence = providerVerificationSchema.parse(proof);
  if (current.state !== 'verifying') throw new IllegalAgentWorkTransitionError('Agent Action', current.state, 'verified');
  return agentActionSchema.parse({ ...current, state: 'verified', verification: evidence, completedAt: evidence.observedAt });
}

export function finishAgentAction(
  action: AgentAction,
  outcome: 'failed' | 'unverifiable' | 'cancelled',
  at: string,
  errorCode: string | null = null,
): AgentAction {
  const current = agentActionSchema.parse(action);
  const permitted = current.state === 'authorized' || current.state === 'executing' || current.state === 'verifying';
  if (!permitted) throw new IllegalAgentWorkTransitionError('Agent Action', current.state, outcome);
  return agentActionSchema.parse({ ...current, state: outcome, errorCode, completedAt: at });
}

/** Enforce immutable retry history: the caller supplies a new Action whose lineage must match. */
export function validateAgentActionRetry(prior: AgentAction, retry: AgentAction): AgentAction {
  const previous = agentActionSchema.parse(prior);
  const next = agentActionSchema.parse(retry);
  if (!['failed', 'unverifiable'].includes(previous.state)
    || next.id === previous.id
    || next.retryOfActionId !== previous.id
    || next.attempt !== previous.attempt + 1
    || next.activityId !== previous.activityId
    || next.userId !== previous.userId
    || next.mailboxId !== previous.mailboxId
    || next.kind !== previous.kind
    || JSON.stringify(next.target) !== JSON.stringify(previous.target)) {
    throw new RangeError('An Action retry must be a new authorized attempt linked to the prior terminal Action.');
  }
  return next;
}

export function appendAgentActivityEvent(history: readonly AgentActivityEvent[], event: AgentActivityEvent): readonly AgentActivityEvent[] {
  const next = agentActivityEventSchema.parse(event);
  const prior = history.map((item) => agentActivityEventSchema.parse(item));
  const last = prior.at(-1);
  if (prior.some((item) => item.id === next.id)) throw new RangeError('Activity Events are append-only and require unique IDs.');
  if (last && (next.activityId !== last.activityId || next.userId !== last.userId || next.mailboxId !== last.mailboxId
    || next.sequence !== last.sequence + 1 || !atOrAfter(next.occurredAt, last.occurredAt))) {
    throw new RangeError('Activity Event identity, sequence, or chronology is invalid.');
  }
  if (!last && next.sequence !== 1) throw new RangeError('The first Activity Event must have sequence 1.');
  return Object.freeze([...prior, next]);
}
