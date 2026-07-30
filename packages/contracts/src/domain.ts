import { z } from 'zod';

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

export const plannedActionSchema = z.strictObject({
  kind: actionKindSchema,
  target: targetSchema,
  reason: z.string().min(1).max(2_000),
}).superRefine((action, context) => {
  if (action.kind === 'move' && !action.target.destinationFolderId) {
    context.addIssue({ code: 'custom', path: ['target', 'destinationFolderId'], message: 'move requires destinationFolderId' });
  }
  if (action.kind.startsWith('draft_') && !action.target.draftId) {
    context.addIssue({ code: 'custom', path: ['target', 'draftId'], message: 'draft action requires draftId' });
  }
  if (!action.kind.startsWith('draft_') && !action.target.messageId) {
    context.addIssue({ code: 'custom', path: ['target', 'messageId'], message: 'mailbox action requires messageId' });
  }
});

export const agentDecisionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('question'), rationale: z.string().min(1), question: z.string().min(1).max(4_000) }),
  z.strictObject({ state: z.literal('actionable'), rationale: z.string().min(1), actions: z.array(plannedActionSchema).min(1).max(5) }),
  z.strictObject({ state: z.literal('no_action'), rationale: z.string().min(1) }),
  z.strictObject({ state: z.literal('failed'), rationale: z.string().min(1), errorCode: z.string().min(1) }),
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
  recipients: z.array(z.strictObject({ kind: z.enum(['to', 'cc', 'bcc']), address: z.email() })).max(100),
  subject: z.string().max(998),
  body: z.string().max(2_000_000),
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
