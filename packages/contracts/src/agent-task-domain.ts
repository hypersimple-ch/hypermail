import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './domain.js';

const revisionSchema = z.number().int().positive();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest.');
const keySchema = z.string().trim().min(16).max(200);
const instant = (value: string): number => Date.parse(value);
const ordered = (later: string, earlier: string): boolean => instant(later) >= instant(earlier);

/** A Task always has exactly one execution target. `none` is deliberately not part of this vocabulary. */
export const agentTaskManagerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mastra') }),
  z.strictObject({ kind: z.literal('agent_connection'), connectionId: idSchema }),
]);
export const agentTaskStateSchema = z.enum([
  'pending', 'leased', 'waiting_for_answer', 'awaiting_action_verification',
  'completed', 'cancelled', 'obsolete', 'dead_letter',
]);
export const agentTaskPendingReasonSchema = z.enum(['initial', 'retry', 'continuation', 'owner_resumed']);
export const agentTaskErrorCodeSchema = z.enum([
  'MANAGER_UNAVAILABLE', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'LEASE_EXPIRED',
  'DEADLINE_EXCEEDED', 'INVALID_REPORT', 'AUTHORIZATION_REVOKED', 'OWNER_CANCELLED',
  'INTERNAL', 'UNVERIFIABLE',
]);

export const agentTaskResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no_action') }),
  z.strictObject({ kind: z.literal('question'), questionId: idSchema }),
  z.strictObject({ kind: z.literal('action_requests_emitted'), actionIds: z.array(idSchema).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Action IDs must be unique.') }),
]);
export const agentTaskLeaseSchema = z.strictObject({
  generation: revisionSchema,
  tokenDigest: digestSchema,
  claimedBy: z.string().trim().min(1).max(200),
  claimedAt: isoDateTimeSchema,
  heartbeatAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
}).superRefine((lease, ctx) => {
  if (!ordered(lease.heartbeatAt, lease.claimedAt)) ctx.addIssue({ code: 'custom', path: ['heartbeatAt'], message: 'heartbeatAt precedes claim.' });
  if (!ordered(lease.expiresAt, lease.heartbeatAt)) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Lease expiry precedes heartbeat.' });
});

/** Durable transport-neutral unit of work. Runs and delivery attempts are separate immutable records. */
export const agentTaskSchema = z.strictObject({
  id: idSchema, activityId: idSchema, userId: idSchema, mailboxId: idSchema,
  manager: agentTaskManagerSchema,
  managerLifecycleRevision: revisionSchema.nullable(),
  assignmentId: idSchema, assignmentRevision: revisionSchema,
  grantId: idSchema, grantRevision: revisionSchema, safetyRevision: revisionSchema,
  state: agentTaskStateSchema,
  pendingReason: agentTaskPendingReasonSchema.nullable(),
  version: revisionSchema,
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().max(100),
  leaseGeneration: z.number().int().nonnegative(),
  lease: agentTaskLeaseSchema.nullable(),
  currentRunId: idSchema.nullable(),
  result: agentTaskResultSchema.nullable(),
  lastErrorCode: agentTaskErrorCodeSchema.nullable(),
  availableAt: isoDateTimeSchema,
  deadlineAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  obsoleteAt: isoDateTimeSchema.nullable(),
}).superRefine((task, ctx) => {
  const external = task.manager.kind === 'agent_connection';
  if (external !== (task.managerLifecycleRevision !== null)) ctx.addIssue({ code: 'custom', path: ['managerLifecycleRevision'], message: 'Only Agent Connections have lifecycle revisions.' });
  if (!ordered(task.deadlineAt, task.createdAt)) ctx.addIssue({ code: 'custom', path: ['deadlineAt'], message: 'Deadline precedes creation.' });
  if (!ordered(task.updatedAt, task.createdAt)) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Update precedes creation.' });
  if (!ordered(task.deadlineAt, task.availableAt)) ctx.addIssue({ code: 'custom', path: ['availableAt'], message: 'Availability exceeds deadline.' });
  if (task.attemptCount > task.maxAttempts) ctx.addIssue({ code: 'custom', path: ['attemptCount'], message: 'Attempt count exceeds maximum.' });
  const pending = task.state === 'pending';
  if (pending !== (task.pendingReason !== null)) ctx.addIssue({ code: 'custom', path: ['pendingReason'], message: 'Only pending Tasks have a pending reason.' });
  const leased = task.state === 'leased';
  if (leased !== (task.lease !== null) || leased !== (task.currentRunId !== null)) ctx.addIssue({ code: 'custom', path: ['lease'], message: 'Only leased Tasks have an active lease and Run.' });
  if (task.lease && task.lease.generation !== task.leaseGeneration) ctx.addIssue({ code: 'custom', path: ['lease', 'generation'], message: 'Lease generation must fence the Task generation.' });
  if (task.lease && instant(task.lease.expiresAt) > instant(task.deadlineAt)) ctx.addIssue({ code: 'custom', path: ['lease', 'expiresAt'], message: 'Lease cannot exceed Task deadline.' });
  const resultState = ['waiting_for_answer', 'awaiting_action_verification', 'completed'].includes(task.state);
  if (resultState !== (task.result !== null)) ctx.addIssue({ code: 'custom', path: ['result'], message: 'Result is required only for result states.' });
  if (task.state === 'waiting_for_answer' && task.result?.kind !== 'question') ctx.addIssue({ code: 'custom', path: ['result'], message: 'Waiting requires a question.' });
  if (task.state === 'awaiting_action_verification' && task.result?.kind !== 'action_requests_emitted') ctx.addIssue({ code: 'custom', path: ['result'], message: 'Verification wait requires Action IDs.' });
  if (task.state === 'completed' && !['no_action','action_requests_emitted'].includes(task.result?.kind ?? '')) ctx.addIssue({ code: 'custom', path: ['result'], message: 'Completion requires no-action or verified actions.' });
  const completed = ['completed', 'cancelled', 'dead_letter'].includes(task.state);
  if (completed !== (task.completedAt !== null)) ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'Terminal completion timestamp mismatch.' });
  if ((task.state === 'obsolete') !== (task.obsoleteAt !== null)) ctx.addIssue({ code: 'custom', path: ['obsoleteAt'], message: 'Only obsolete Tasks have obsoleteAt.' });
});

const commandBase = { taskId: idSchema, requestId: keySchema, requestDigest: digestSchema, expectedVersion: revisionSchema, occurredAt: isoDateTimeSchema };
export const claimAgentTaskCommandSchema = z.strictObject({ ...commandBase, runId: idSchema, claimedBy: z.string().trim().min(1).max(200), leaseTokenDigest: digestSchema, leaseExpiresAt: isoDateTimeSchema });
export const heartbeatAgentTaskCommandSchema = z.strictObject({ ...commandBase, leaseGeneration: revisionSchema, leaseTokenDigest: digestSchema, leaseExpiresAt: isoDateTimeSchema });
export const reportAgentTaskResultCommandSchema = z.strictObject({ ...commandBase, leaseGeneration: revisionSchema, leaseTokenDigest: digestSchema, result: agentTaskResultSchema });
export const reportAgentTaskFailureCommandSchema = z.strictObject({ ...commandBase, leaseGeneration: revisionSchema, leaseTokenDigest: digestSchema, errorCode: agentTaskErrorCodeSchema });
export const answerAgentTaskQuestionCommandSchema = z.strictObject({ ...commandBase, questionId: idSchema, answerDigest: digestSchema, continuationRunId: idSchema });

export const agentTaskDeliveryAttemptSchema = z.strictObject({
  id: idSchema, taskId: idSchema, number: revisionSchema, leaseGeneration: revisionSchema, runId: idSchema,
  manager: agentTaskManagerSchema, requestId: keySchema, requestDigest: digestSchema,
  startedAt: isoDateTimeSchema, endedAt: isoDateTimeSchema.nullable(), errorCode: agentTaskErrorCodeSchema.nullable(),
}).superRefine((a, ctx) => { if (a.endedAt && !ordered(a.endedAt, a.startedAt)) ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'Attempt end precedes start.' }); });
export const agentTaskReportSchema = z.strictObject({
  id: idSchema, taskId: idSchema, attemptId: idSchema, leaseGeneration: revisionSchema,
  kind: z.enum(['heartbeat', 'result', 'failure', 'answer']), requestId: keySchema, requestDigest: digestSchema,
  accepted: z.boolean(), errorCode: agentTaskErrorCodeSchema.nullable(), occurredAt: isoDateTimeSchema,
});
/** Minimal outbox envelope: identifiers and digests only; no message body, account address, or credentials. */
export const agentTaskOutboxEnvelopeSchema = z.strictObject({
  id: idSchema, taskId: idSchema, activityId: idSchema, mailboxId: idSchema,
  event: z.enum(['task_available', 'task_obsolete', 'question_answered', 'task_terminal']),
  taskVersion: revisionSchema, payloadDigest: digestSchema, correlationId: z.string().trim().min(8).max(200), occurredAt: isoDateTimeSchema,
});
export const agentTaskIdempotencyRecordSchema = z.strictObject({ requestId: keySchema, requestDigest: digestSchema });

export type AgentTask = z.infer<typeof agentTaskSchema>;
export type AgentTaskResult = z.infer<typeof agentTaskResultSchema>;
export type AgentTaskErrorCode = z.infer<typeof agentTaskErrorCodeSchema>;
export type AgentTaskIdempotencyRecord = z.infer<typeof agentTaskIdempotencyRecordSchema>;

export class AgentTaskTransitionError extends Error { constructor(readonly code: 'ILLEGAL_STATE'|'STALE_VERSION'|'STALE_LEASE'|'LEASE_EXPIRED'|'DEADLINE_EXCEEDED'|'ACTION_OWNERSHIP_MISMATCH'|'IDEMPOTENCY_MISMATCH', message: string) { super(message); this.name = 'AgentTaskTransitionError'; } }
const requireVersion = (t: AgentTask, v: number) => { if (t.version !== v) throw new AgentTaskTransitionError('STALE_VERSION', 'Stale Task version.'); };
const requireLease = (t: AgentTask, generation: number, token: string, at: string) => {
  if (t.state !== 'leased' || !t.lease || t.leaseGeneration !== generation || t.lease.tokenDigest !== token) throw new AgentTaskTransitionError('STALE_LEASE', 'Stale lease generation or token.');
  if (instant(at) > instant(t.lease.expiresAt)) throw new AgentTaskTransitionError('LEASE_EXPIRED', 'Lease expired.');
  if (instant(at) > instant(t.deadlineAt)) throw new AgentTaskTransitionError('DEADLINE_EXCEEDED', 'Task deadline exceeded.');
};
export function classifyAgentTaskIdempotency(existing: AgentTaskIdempotencyRecord | undefined, requestId: string, requestDigest: string): 'new'|'replay'|'mismatch' {
  if (!existing) return 'new';
  return existing.requestId === requestId && existing.requestDigest === requestDigest ? 'replay' : 'mismatch';
}
export function claimAgentTask(task: AgentTask, command: z.infer<typeof claimAgentTaskCommandSchema>): AgentTask {
  const t=agentTaskSchema.parse(task), c=claimAgentTaskCommandSchema.parse(command); requireVersion(t,c.expectedVersion);
  if (t.state !== 'pending') throw new AgentTaskTransitionError('ILLEGAL_STATE','Only pending Tasks may be claimed.');
  if (instant(c.occurredAt)<instant(t.availableAt)) throw new AgentTaskTransitionError('ILLEGAL_STATE','Task is not available.');
  if (instant(c.occurredAt)>instant(t.deadlineAt) || instant(c.leaseExpiresAt)>instant(t.deadlineAt)) throw new AgentTaskTransitionError('DEADLINE_EXCEEDED','Claim exceeds deadline.');
  if (instant(c.leaseExpiresAt)<=instant(c.occurredAt)) throw new AgentTaskTransitionError('LEASE_EXPIRED','Lease must expire after claim.');
  if (t.attemptCount >= t.maxAttempts) throw new AgentTaskTransitionError('ILLEGAL_STATE','Maximum attempts reached.');
  const generation=t.leaseGeneration+1;
  return agentTaskSchema.parse({...t,state:'leased',pendingReason:null,version:t.version+1,attemptCount:t.attemptCount+1,leaseGeneration:generation,currentRunId:c.runId,lease:{generation,tokenDigest:c.leaseTokenDigest,claimedBy:c.claimedBy,claimedAt:c.occurredAt,heartbeatAt:c.occurredAt,expiresAt:c.leaseExpiresAt},updatedAt:c.occurredAt,lastErrorCode:null});
}
export function heartbeatAgentTask(task: AgentTask, command: z.infer<typeof heartbeatAgentTaskCommandSchema>): AgentTask {
  const t=agentTaskSchema.parse(task),c=heartbeatAgentTaskCommandSchema.parse(command); requireVersion(t,c.expectedVersion); requireLease(t,c.leaseGeneration,c.leaseTokenDigest,c.occurredAt);
  if (instant(c.leaseExpiresAt)<=instant(c.occurredAt)||instant(c.leaseExpiresAt)>instant(t.deadlineAt)) throw new AgentTaskTransitionError('DEADLINE_EXCEEDED','Invalid bounded lease extension.');
  return agentTaskSchema.parse({...t,version:t.version+1,updatedAt:c.occurredAt,lease:{...agentTaskLeaseSchema.parse(t.lease),heartbeatAt:c.occurredAt,expiresAt:c.leaseExpiresAt}});
}
export function reportAgentTaskResult(task: AgentTask, command: z.infer<typeof reportAgentTaskResultCommandSchema>, ownedActionIds: readonly string[] = []): AgentTask {
  const t=agentTaskSchema.parse(task),c=reportAgentTaskResultCommandSchema.parse(command); requireVersion(t,c.expectedVersion); requireLease(t,c.leaseGeneration,c.leaseTokenDigest,c.occurredAt);
  if (c.result.kind==='action_requests_emitted' && c.result.actionIds.some(id=>!ownedActionIds.includes(id))) throw new AgentTaskTransitionError('ACTION_OWNERSHIP_MISMATCH','Every Action must belong to this Task Run.');
  const state=c.result.kind==='question'?'waiting_for_answer':c.result.kind==='action_requests_emitted'?'awaiting_action_verification':'completed';
  return agentTaskSchema.parse({...t,state,version:t.version+1,lease:null,currentRunId:null,result:c.result,updatedAt:c.occurredAt,completedAt:state==='completed'?c.occurredAt:null});
}

export function completeAgentTaskActionVerification(task: AgentTask, at: string): AgentTask {
 const t=agentTaskSchema.parse(task);
 if(t.state!=='awaiting_action_verification'||t.result?.kind!=='action_requests_emitted') throw new AgentTaskTransitionError('ILLEGAL_STATE','Task is not awaiting Action verification.');
 if(instant(at)>instant(t.deadlineAt)) throw new AgentTaskTransitionError('DEADLINE_EXCEEDED','Verification completed after deadline.');
 return agentTaskSchema.parse({...t,state:'completed',version:t.version+1,updatedAt:at,completedAt:at});
}
export function reportAgentTaskFailure(task: AgentTask, command: z.infer<typeof reportAgentTaskFailureCommandSchema>, availableAt: string): AgentTask {
  const t=agentTaskSchema.parse(task),c=reportAgentTaskFailureCommandSchema.parse(command); requireVersion(t,c.expectedVersion); requireLease(t,c.leaseGeneration,c.leaseTokenDigest,c.occurredAt);
  const terminal=t.attemptCount>=t.maxAttempts || !isRetryableAgentTaskError(c.errorCode) || instant(availableAt)>instant(t.deadlineAt);
  return agentTaskSchema.parse({...t,state:terminal?'dead_letter':'pending',pendingReason:terminal?null:'retry',version:t.version+1,lease:null,currentRunId:null,result:null,lastErrorCode:c.errorCode,availableAt:terminal?t.availableAt:availableAt,updatedAt:c.occurredAt,completedAt:terminal?c.occurredAt:null});
}
export function expireAgentTaskLease(task: AgentTask, at: string, availableAt: string): AgentTask {
  const t=agentTaskSchema.parse(task); if(t.state!=='leased'||!t.lease||instant(at)<=instant(t.lease.expiresAt)) throw new AgentTaskTransitionError('ILLEGAL_STATE','Lease is not expired.');
  const terminal=t.attemptCount>=t.maxAttempts||instant(availableAt)>instant(t.deadlineAt);
  return agentTaskSchema.parse({...t,state:terminal?'dead_letter':'pending',pendingReason:terminal?null:'retry',version:t.version+1,lease:null,currentRunId:null,lastErrorCode:'LEASE_EXPIRED',availableAt:terminal?t.availableAt:availableAt,updatedAt:at,completedAt:terminal?at:null});
}
export function answerAgentTaskQuestion(task: AgentTask, command: z.infer<typeof answerAgentTaskQuestionCommandSchema>): AgentTask {
 const t=agentTaskSchema.parse(task),c=answerAgentTaskQuestionCommandSchema.parse(command); requireVersion(t,c.expectedVersion);
 if(t.state!=='waiting_for_answer'||t.result?.kind!=='question'||t.result.questionId!==c.questionId) throw new AgentTaskTransitionError('ILLEGAL_STATE','Question does not belong to waiting Task.');
 if(instant(c.occurredAt)>instant(t.deadlineAt)) throw new AgentTaskTransitionError('DEADLINE_EXCEEDED','Answer arrived after deadline.');
 return agentTaskSchema.parse({...t,state:'pending',pendingReason:'continuation',version:t.version+1,result:null,availableAt:c.occurredAt,updatedAt:c.occurredAt});
}
export function cancelAgentTask(task: AgentTask, at: string): AgentTask { const t=agentTaskSchema.parse(task); if(['completed','cancelled','obsolete','dead_letter'].includes(t.state)) throw new AgentTaskTransitionError('ILLEGAL_STATE','Task cannot be cancelled.'); return agentTaskSchema.parse({...t,state:'cancelled',pendingReason:null,version:t.version+1,lease:null,currentRunId:null,result:null,lastErrorCode:'OWNER_CANCELLED',updatedAt:at,completedAt:at}); }
export function obsoleteAgentTask(task: AgentTask, at: string): AgentTask { const t=agentTaskSchema.parse(task); if(['completed','cancelled','dead_letter','obsolete'].includes(t.state)) throw new AgentTaskTransitionError('ILLEGAL_STATE','Task cannot be made obsolete.'); return agentTaskSchema.parse({...t,state:'obsolete',pendingReason:null,version:t.version+1,lease:null,currentRunId:null,result:null,obsoleteAt:at,updatedAt:at}); }
/** Reassignment never happens implicitly. An owner explicitly resumes by creating a new pending Task. */
export function resumeObsoleteAgentTask(task: AgentTask, replacement: AgentTask): AgentTask { const old=agentTaskSchema.parse(task), next=agentTaskSchema.parse(replacement); if(old.state!=='obsolete'||next.state!=='pending'||next.pendingReason!=='owner_resumed'||next.id===old.id||next.activityId!==old.activityId||next.userId!==old.userId||next.mailboxId!==old.mailboxId) throw new AgentTaskTransitionError('ILLEGAL_STATE','Invalid explicit owner resume.'); return next; }
export function isRetryableAgentTaskError(code: AgentTaskErrorCode): boolean { return ['MANAGER_UNAVAILABLE','RATE_LIMITED','DEPENDENCY_UNAVAILABLE','LEASE_EXPIRED','INTERNAL'].includes(code); }
export function agentTaskBackoffMs(attempt: number, baseMs=1_000, maximumMs=300_000): number { if(!Number.isInteger(attempt)||attempt<1||baseMs<1||maximumMs<baseMs) throw new RangeError('Invalid backoff parameters.'); return Math.min(maximumMs,baseMs*2**Math.min(attempt-1,30)); }
