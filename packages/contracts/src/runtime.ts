import { z } from 'zod';
import { actionKindSchema, idSchema, isoDateTimeSchema } from './domain.js';

export const agentEvaluateJobSchema = z.union([
  z.strictObject({ jobId: idSchema }),
  z.strictObject({ jobId: idSchema, userId: idSchema }),
]);
export type AgentEvaluateJob = z.infer<typeof agentEvaluateJobSchema>;
export const notificationDeliverJobSchema = z.strictObject({ notificationId: idSchema });
export const policyExecuteJobSchema = z.strictObject({ actionId: idSchema });

export const queueJobSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('agent.evaluate'), payload: agentEvaluateJobSchema }),
  z.strictObject({ name: z.literal('notification.deliver'), payload: notificationDeliverJobSchema }),
  z.strictObject({ name: z.literal('policy.execute'), payload: policyExecuteJobSchema }),
]);

export const dependencyStateSchema = z.enum(['ready', 'degraded', 'unavailable', 'disabled']);
export const runtimeHealthSchema = z.strictObject({
  live: z.boolean(),
  ready: z.boolean(),
  checkedAt: isoDateTimeSchema,
  dependencies: z.strictObject({
    database: dependencyStateSchema,
    queue: dependencyStateSchema,
    hypermail: dependencyStateSchema,
    model: dependencyStateSchema,
    scheduler: dependencyStateSchema,
    notifications: dependencyStateSchema,
    approvedSend: dependencyStateSchema,
  }),
});

export const runtimeCapabilitiesSchema = z.strictObject({
  approvedSend: z.enum(['disabled', 'configured']),
  autonomousMutations: z.array(actionKindSchema).refine(
    (values) => !values.some((value) => value.startsWith('draft_')),
    'draft mutations are not mailbox transport capabilities',
  ),
});

/** Minimal cancellation boundary shared by long-running schedulers. */
export interface RuntimeStopSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
  onAbort(listener: () => void): () => void;
}

export function approvedSendCapability(environment: {
  readonly APPROVED_SEND_URL?: string;
  readonly APPROVED_SEND_TOKEN?: string;
}): 'disabled' | 'configured' {
  return environment.APPROVED_SEND_URL && environment.APPROVED_SEND_TOKEN ? 'configured' : 'disabled';
}
