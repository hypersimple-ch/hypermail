import { z } from 'zod';
import { agentDraftFieldsSchema, draftFieldsSchema, recipientProblem } from './draft-fields.js';

export const idSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const activityStateSchema = z.enum(['new', 'waiting_question', 'failed', 'handled', 'acknowledged']);
export const questionStateSchema = z.enum(['open', 'answered', 'cancelled']);
export const jobStateSchema = z.enum(['pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled']);
export const decisionStateSchema = z.enum(['pending', 'question', 'actionable', 'no_action', 'failed']);
export const actionKindSchema = z.enum([
  'archive',
  'recoverable_trash',
  'move',
  'mark_read',
  'mark_unread',
  'draft_create',
  'draft_edit',
]);
export const actionStateSchema = z.enum(['planned', 'executing', 'succeeded', 'failed', 'unverifiable', 'incorrect']);
export const draftStateSchema = z.enum(['editing', 'ready', 'sending', 'sent', 'failed', 'discarded']);
export const notificationStateSchema = z.enum(['pending', 'delivering', 'delivered', 'failed', 'suppressed']);
export const healthStateSchema = z.enum(['healthy', 'degraded', 'failed', 'paused']);

export const activitySchema = z.strictObject({
  id: idSchema,
  accountId: idSchema,
  messageId: idSchema,
  state: activityStateSchema,
  version: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const questionSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  decisionId: idSchema,
  state: questionStateSchema,
  prompt: z.string().min(1).max(4_000),
  answer: z.string().min(1).max(8_000).nullable(),
  answeredAt: isoDateTimeSchema.nullable(),
});

export const jobSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  idempotencyKey: z.string().min(16).max(200),
  state: jobStateSchema,
  attempt: z.number().int().nonnegative(),
  availableAt: isoDateTimeSchema,
});

const targetSchema = z.strictObject({
  accountId: idSchema,
  messageId: idSchema.optional(),
  draftId: idSchema.optional(),
  destinationFolderId: idSchema.optional(),
});

const messageTargetSchema = z.strictObject({ accountId: idSchema, messageId: idSchema });
const moveTargetSchema = messageTargetSchema.extend({ destinationFolderId: idSchema });
const draftTargetSchema = z.strictObject({ accountId: idSchema, draftId: idSchema });
export const actionKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const actionConfidenceSchema = z.number().min(0).max(1);
const actionReasonSchema = z.string().min(1).max(2_000).refine((reason) => reason.trim().length > 0, 'A reason is required.');
const plannedActionFields = {
  key: actionKeySchema,
  confidence: actionConfidenceSchema,
  reason: actionReasonSchema,
  evidenceIds: z.array(z.string().min(1).max(200)).max(20),
  dependsOn: z.array(actionKeySchema).max(4),
};

/** Model proposals contain inline content, never an invented new draft identity. */
export const plannedActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...plannedActionFields, kind: z.literal('archive'), target: messageTargetSchema }),
  z.strictObject({ ...plannedActionFields, kind: z.literal('recoverable_trash'), target: messageTargetSchema }),
  z.strictObject({ ...plannedActionFields, kind: z.literal('move'), target: moveTargetSchema }),
  z.strictObject({ ...plannedActionFields, kind: z.literal('draft_create'), target: messageTargetSchema, draft: agentDraftFieldsSchema }),
  z.strictObject({ ...plannedActionFields, kind: z.literal('draft_edit'), target: draftTargetSchema, expectedVersion: z.number().int().positive(), draft: agentDraftFieldsSchema }),
]);
export type PlannedAction = z.infer<typeof plannedActionSchema>;

/** Owner corrections have no fabricated model confidence or model evidence. */
export const ownerActionCorrectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('archive'), target: messageTargetSchema, reason: actionReasonSchema }),
  z.strictObject({ kind: z.literal('recoverable_trash'), target: messageTargetSchema, reason: actionReasonSchema }),
  z.strictObject({ kind: z.literal('move'), target: moveTargetSchema, reason: actionReasonSchema }),
  z.strictObject({ kind: z.literal('draft_create'), target: messageTargetSchema, reason: actionReasonSchema, draft: draftFieldsSchema }),
  z.strictObject({ kind: z.literal('draft_edit'), target: draftTargetSchema, reason: actionReasonSchema, expectedVersion: z.number().int().positive(), draft: draftFieldsSchema }),
]).superRefine((action, context) => {
  if (action.kind !== 'draft_create' && action.kind !== 'draft_edit') return;
  const problem = recipientProblem(action.draft.recipients);
  if (problem) context.addIssue({ code: 'custom', path: ['draft', 'recipients'], message: problem });
});
export type OwnerActionCorrection = z.infer<typeof ownerActionCorrectionSchema>;

export const actionPlanSchema = z.array(plannedActionSchema).min(1).max(5).superRefine((actions, context) => {
  const byKey = new Map<string, PlannedAction>();
  const classifiedMessages = new Set<string>();
  for (const [index, action] of actions.entries()) {
    if (byKey.has(action.key)) context.addIssue({ code: 'custom', path: [index, 'key'], message: 'Action keys must be unique.' });
    byKey.set(action.key, action);
    if (action.kind === 'archive' || action.kind === 'move' || action.kind === 'recoverable_trash') {
      const identity = `${action.target.accountId}:${action.target.messageId}`;
      if (classifiedMessages.has(identity)) context.addIssue({ code: 'custom', path: [index, 'target'], message: 'A message may have only one classification action.' });
      classifiedMessages.add(identity);
    }
  }
  for (const [index, action] of actions.entries()) {
    const seen = new Set<string>();
    for (const [dependencyIndex, key] of action.dependsOn.entries()) {
      if (key === action.key || !byKey.has(key) || seen.has(key)) {
        context.addIssue({ code: 'custom', path: [index, 'dependsOn', dependencyIndex], message: 'Dependencies must be distinct existing other action keys.' });
      }
      seen.add(key);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if (actions.some((action) => hasCycle(action.key))) context.addIssue({ code: 'custom', message: 'Action dependencies must be acyclic.' });
});

/** Version one is historical only and must never be parsed as an executable plan. */
export const agentDecisionSchema = z.discriminatedUnion('state', [
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal('question'), rationale: z.string().min(1), question: z.string().min(1).max(4_000) }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal('actionable'), rationale: z.string().min(1), actions: actionPlanSchema }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal('no_action'), rationale: z.string().min(1) }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal('failed'), rationale: z.string().min(1), errorCode: z.string().min(1) }),
]);

export const actionSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  decisionId: idSchema,
  kind: actionKindSchema,
  state: actionStateSchema,
  idempotencyKey: z.string().min(16).max(200),
  target: targetSchema,
});

export const draftSchema = z.strictObject({
  id: idSchema,
  accountId: idSchema,
  state: draftStateSchema,
  version: z.number().int().positive(),
  createdBy: z.enum(['user', 'agent']),
  recipients: draftFieldsSchema.shape.recipients,
  subject: draftFieldsSchema.shape.subject,
  body: draftFieldsSchema.shape.body,
});

export const logicalNotificationSchema = z.strictObject({
  id: idSchema,
  activityId: idSchema,
  state: notificationStateSchema,
  senderLabel: z.string().min(1).max(200),
  subject: z.string().max(998),
  statusLabel: z.string().min(1).max(100),
});

export const accountHealthSchema = z.strictObject({
  accountId: idSchema,
  state: healthStateSchema,
  reasonCode: z.string().min(1).max(100).nullable(),
  detail: z.string().max(2_000).nullable(),
  updatedAt: isoDateTimeSchema,
});

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL']),
    message: z.string().min(1).max(500),
    correlationId: z.string().min(8).max(100),
    retryable: z.boolean(),
  }),
});

export type ActivityState = z.infer<typeof activityStateSchema>;
export type QuestionState = z.infer<typeof questionStateSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type ActionState = z.infer<typeof actionStateSchema>;
export type DraftState = z.infer<typeof draftStateSchema>;
export type NotificationState = z.infer<typeof notificationStateSchema>;
export type HealthState = z.infer<typeof healthStateSchema>;
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
