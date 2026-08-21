import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './domain.js';

/** Stable adapter identifier; Hermes is the first adapter, not a domain special case. */
export const agentAdapterSchema = z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_-]*$/);
export const agentConnectionStateSchema = z.enum(['connected', 'paused', 'disconnected', 'security_revoked']);

export const agentConnectionSchema = z.strictObject({
  id: idSchema,
  userId: idSchema,
  adapter: agentAdapterSchema,
  externalProfileId: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(200),
  state: agentConnectionStateSchema,
  lifecycleRevision: z.number().int().positive(),
  verifiedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const noneManagerSchema = z.strictObject({ kind: z.literal('none') });
const mastraManagerSchema = z.strictObject({ kind: z.literal('mastra') });
const externalManagerSchema = z.strictObject({ kind: z.literal('agent_connection'), connectionId: idSchema });

/** The exhaustive Manager reference used by defaults, assignments, and frozen history. */
export const mailboxManagerSchema = z.discriminatedUnion('kind', [
  noneManagerSchema,
  mastraManagerSchema,
  externalManagerSchema,
]);

export const userAgentPreferenceSchema = z.strictObject({
  userId: idSchema,
  defaultManager: mailboxManagerSchema,
  revision: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
});

export const mailboxManagerAssignmentSchema = z.strictObject({
  id: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  manager: mailboxManagerSchema,
  automaticProcessingEnabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const mailboxManagerAssignmentRevisionSchema = z.strictObject({
  assignmentId: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  manager: mailboxManagerSchema,
  automaticProcessingEnabled: z.boolean(),
  revision: z.number().int().positive(),
  changedAt: isoDateTimeSchema,
});

export type AgentConnectionState = z.infer<typeof agentConnectionStateSchema>;
export type MailboxManager = z.infer<typeof mailboxManagerSchema>;
export type UserAgentPreference = z.infer<typeof userAgentPreferenceSchema>;
export type MailboxManagerAssignment = z.infer<typeof mailboxManagerAssignmentSchema>;
/** Immutable history identity is the `(assignmentId, revision)` pair. */
export type MailboxManagerAssignmentRevision = z.infer<typeof mailboxManagerAssignmentRevisionSchema>;

const lifecycleTransitions: Readonly<Record<AgentConnectionState, readonly AgentConnectionState[]>> = {
  connected: ['paused', 'disconnected', 'security_revoked'],
  paused: ['connected', 'disconnected', 'security_revoked'],
  disconnected: ['connected', 'security_revoked'],
  security_revoked: [],
};

export class IllegalAgentConnectionTransitionError extends Error {
  constructor(from: AgentConnectionState, to: AgentConnectionState) {
    super(`Illegal agent connection transition: ${from} -> ${to}`);
    this.name = 'IllegalAgentConnectionTransitionError';
  }
}

export function transitionAgentConnection(
  from: AgentConnectionState,
  to: AgentConnectionState,
): AgentConnectionState {
  if (!lifecycleTransitions[from].includes(to)) throw new IllegalAgentConnectionTransitionError(from, to);
  return to;
}

/** Advance the authorization-fencing revision for every legal lifecycle change. */
export function reviseAgentConnectionLifecycle(
  current: Readonly<{ state: AgentConnectionState; lifecycleRevision: number }>,
  to: AgentConnectionState,
): { state: AgentConnectionState; lifecycleRevision: number } {
  if (!Number.isSafeInteger(current.lifecycleRevision) || current.lifecycleRevision < 1) {
    throw new RangeError('Invalid Agent Connection lifecycle revision.');
  }
  return {
    state: transitionAgentConnection(current.state, to),
    lifecycleRevision: current.lifecycleRevision + 1,
  };
}

/** Snapshot a User's current default exactly once when a Mailbox is attached. */
export function assignDefaultManagerToMailbox(input: {
  readonly assignmentId: string;
  readonly mailboxId: string;
  readonly preference: UserAgentPreference;
  readonly now: string;
}): MailboxManagerAssignment {
  return mailboxManagerAssignmentSchema.parse({
    id: input.assignmentId,
    userId: input.preference.userId,
    mailboxId: input.mailboxId,
    manager: input.preference.defaultManager,
    automaticProcessingEnabled: false,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  });
}


/** Create the next current assignment and its append-only history snapshot. */
export function reviseMailboxManagerAssignment(
  current: MailboxManagerAssignment,
  update: Readonly<{ manager: MailboxManager; automaticProcessingEnabled: boolean }>,
  changedAt: string,
): { assignment: MailboxManagerAssignment; revision: MailboxManagerAssignmentRevision } {
  const parsedCurrent = mailboxManagerAssignmentSchema.parse(current);
  const parsedManager = mailboxManagerSchema.parse(update.manager);
  const unchanged = JSON.stringify(parsedCurrent.manager) === JSON.stringify(parsedManager)
    && parsedCurrent.automaticProcessingEnabled === update.automaticProcessingEnabled;
  if (unchanged) throw new RangeError('Mailbox Manager assignment revision must change configuration.');

  const assignment = mailboxManagerAssignmentSchema.parse({
    ...parsedCurrent,
    manager: parsedManager,
    automaticProcessingEnabled: update.automaticProcessingEnabled,
    revision: parsedCurrent.revision + 1,
    updatedAt: changedAt,
  });
  const revision = mailboxManagerAssignmentRevisionSchema.parse({
    assignmentId: assignment.id,
    userId: assignment.userId,
    mailboxId: assignment.mailboxId,
    manager: assignment.manager,
    automaticProcessingEnabled: assignment.automaticProcessingEnabled,
    revision: assignment.revision,
    changedAt,
  });
  return { assignment, revision };
}



export const verifiedAgentReconnectSchema = z.strictObject({
  userId: idSchema,
  connectionId: idSchema,
  verificationEventId: z.string().min(16).max(200),
  verifiedAt: isoDateTimeSchema,
});
export type VerifiedAgentReconnect = z.infer<typeof verifiedAgentReconnectSchema>;

/** Security revocation can only be recovered by a separately verified ceremony. */
export function reconnectSecurityRevokedAgentConnection(
  current: Readonly<{ id: string; userId: string; state: AgentConnectionState; lifecycleRevision: number }>,
  artifact: VerifiedAgentReconnect,
): { state: 'connected'; lifecycleRevision: number; verifiedAt: string } {
  const proof = verifiedAgentReconnectSchema.parse(artifact);
  if (current.state !== 'security_revoked' || current.id !== proof.connectionId || current.userId !== proof.userId) {
    throw new IllegalAgentConnectionTransitionError(current.state, 'connected');
  }
  if (!Number.isSafeInteger(current.lifecycleRevision) || current.lifecycleRevision < 1) throw new RangeError('Invalid Agent Connection lifecycle revision.');
  return { state: 'connected', lifecycleRevision: current.lifecycleRevision + 1, verifiedAt: proof.verifiedAt };
}

export const capabilityGrantReapprovalSchema = z.strictObject({
  approverUserId: idSchema,
  approvalEventId: z.string().min(16).max(200),
  approvedAt: isoDateTimeSchema,
});
export type CapabilityGrantReapproval = z.infer<typeof capabilityGrantReapprovalSchema>;

/** Closed capabilities that may be delegated to a Mailbox Manager. */
export const agentCapabilitySchema = z.enum([
  'mail.list', 'mail.search', 'mail.read', 'attachment.read', 'folder.list',
  'mail.archive', 'mail.trash_recoverable', 'mail.move', 'mail.mark_read', 'mail.mark_unread',
  'draft.create', 'draft.edit', 'send.request',
]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const agentInvocationModeSchema = z.enum(['interactive', 'automatic']);
export const capabilityGrantStateSchema = z.enum(['active', 'revoked', 'reapproval_required']);
export type AgentInvocationMode = z.infer<typeof agentInvocationModeSchema>;
export type CapabilityGrantState = z.infer<typeof capabilityGrantStateSchema>;

const capabilitySetSchema = z.array(agentCapabilitySchema).max(agentCapabilitySchema.options.length)
  .refine((items) => new Set(items).size === items.length, 'Capabilities must be unique.');
const invocationModeSetSchema = z.array(agentInvocationModeSchema).min(1).max(agentInvocationModeSchema.options.length)
  .refine((items) => new Set(items).size === items.length, 'Invocation modes must be unique.');
const grantManagerSchema = z.discriminatedUnion('kind', [mastraManagerSchema, externalManagerSchema]);
const grantBase = {
  id: idSchema,
  userId: idSchema,
  mailboxId: idSchema,
  manager: grantManagerSchema,
  capabilities: capabilitySetSchema,
  invocationModes: invocationModeSetSchema,
  state: capabilityGrantStateSchema,
  revision: z.number().int().positive(),
  approvedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
};

/** Current grant. Runtime revision bindings remain separate fresh facts. */
export const capabilityGrantSchema = z.strictObject({
  ...grantBase,
  updatedAt: isoDateTimeSchema,
});

/** Frozen append-only grant snapshot, identified by (grantId, revision). */
export const capabilityGrantRevisionSchema = z.strictObject({
  ...grantBase,
  changedAt: isoDateTimeSchema,
});

export const agentSafetyCeilingSchema = z.strictObject({
  revision: z.number().int().positive(),
  capabilities: capabilitySetSchema,
  invocationModes: invocationModeSetSchema,
});

/** Bearer credentials may identify only an external Agent Connection, never Mastra. */
export const externalAuthorizationSubjectSchema = z.strictObject({
  kind: z.literal('agent_connection'),
  userId: idSchema,
  connectionId: idSchema,
});

export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;
export type CapabilityGrantRevision = z.infer<typeof capabilityGrantRevisionSchema>;
export type AgentSafetyCeiling = z.infer<typeof agentSafetyCeilingSchema>;
export type ExternalAuthorizationSubject = z.infer<typeof externalAuthorizationSubjectSchema>;
