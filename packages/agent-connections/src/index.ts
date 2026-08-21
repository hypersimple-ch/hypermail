import { z } from 'zod';
import {
  agentConnectionStateSchema,
  agentInvocationModeSchema,
  agentSafetyCeilingSchema,
  capabilityGrantSchema,
  externalAuthorizationSubjectSchema,
  mailboxManagerAssignmentSchema,
  type AgentCapability,
  type AgentInvocationMode,
} from '@hypermail/contracts';

/** Deliberately enumerated: this boundary is not derived from the private MCP tool list. */
export const publicAgentToolNames = [
  'list_emails', 'search_emails', 'read_email', 'read_attachment', 'list_folders',
  'archive_email', 'trash_email', 'move_email', 'mark_read', 'mark_unread',
  'draft_email', 'edit_draft', 'request_send_email',
] as const;
export type PublicAgentTool = typeof publicAgentToolNames[number];

export const PUBLIC_AGENT_TOOL_CAPABILITY = {
  list_emails: 'mail.list',
  search_emails: 'mail.search',
  read_email: 'mail.read',
  read_attachment: 'attachment.read',
  list_folders: 'folder.list',
  archive_email: 'mail.archive',
  trash_email: 'mail.trash_recoverable',
  move_email: 'mail.move',
  mark_read: 'mail.mark_read',
  mark_unread: 'mail.mark_unread',
  draft_email: 'draft.create',
  edit_draft: 'draft.edit',
  request_send_email: 'send.request',
} as const satisfies Record<PublicAgentTool, AgentCapability>;

export const publicAgentToolSchema = z.enum(publicAgentToolNames);

const tokenSchema = z.strictObject({
  valid: z.boolean(),
  audience: z.string().min(1),
  scopes: z.array(z.string().min(1)).max(50),
  subject: externalAuthorizationSubjectSchema,
  mailboxId: z.uuid(),
  lifecycleRevision: z.number().int().positive(),
  assignmentRevision: z.number().int().positive(),
  grantRevision: z.number().int().positive(),
  safetyRevision: z.number().int().positive(),
});
const connectionFactSchema = z.strictObject({
  id: z.uuid(), userId: z.uuid(), state: agentConnectionStateSchema, lifecycleRevision: z.number().int().positive(),
});
const mailboxFactSchema = z.strictObject({ id: z.uuid(), userId: z.uuid() });
const authorizationFactsSchema = z.strictObject({
  expectedAudience: z.string().min(1),
  requiredScope: z.string().min(1).default('agent:mailbox'),
  connection: connectionFactSchema.nullable(),
  mailbox: mailboxFactSchema.nullable(),
  assignment: mailboxManagerAssignmentSchema.nullable(),
  grant: capabilityGrantSchema.nullable(),
  safetyCeiling: agentSafetyCeilingSchema,
  tool: publicAgentToolSchema,
});
const verifiedInvocationBindingSchema = z.strictObject({
  principal: tokenSchema,
  mode: agentInvocationModeSchema,
  sessionId: z.string().min(16).max(200),
});

export type VerifiedInvocationBinding = z.input<typeof verifiedInvocationBindingSchema>;
export type AuthorizationFacts = z.input<typeof authorizationFactsSchema>;
export type AuthorizationDenialCode =
  | 'invalid_request' | 'invalid_token' | 'invalid_audience' | 'insufficient_scope'
  | 'connection_not_found' | 'connection_subject_mismatch' | 'connection_inactive' | 'stale_lifecycle_revision'
  | 'mailbox_not_found' | 'mailbox_subject_mismatch' | 'mailbox_owner_mismatch' | 'assignment_not_found' | 'assignment_subject_mismatch'
  | 'stale_assignment_revision' | 'automatic_processing_disabled' | 'grant_not_found'
  | 'grant_subject_mismatch' | 'grant_inactive' | 'stale_grant_revision' | 'invocation_mode_denied'
  | 'capability_denied' | 'stale_safety_revision' | 'safety_ceiling_denied' | 'stale_final_fence';
export type AuthorizationDecision =
  | Readonly<{ allowed: false; code: AuthorizationDenialCode }>
  | Readonly<{
      allowed: true;
      authority: Readonly<{
        userId: string; connectionId: string; mailboxId: string; mode: AgentInvocationMode; capability: AgentCapability;
        lifecycleRevision: number; assignmentRevision: number; grantRevision: number; safetyRevision: number;
      }>;
    }>;
const deny = (code: AuthorizationDenialCode): AuthorizationDecision => ({ allowed: false, code });

/**
 * Pure, deny-by-default authorization kernel. Callers must load every fact anew for
 * each tool invocation; no session authorization result is accepted or cached here.
 */
export function authorizeAgentTool(raw: AuthorizationFacts, rawBinding: VerifiedInvocationBinding): AuthorizationDecision {
  const parsed = authorizationFactsSchema.safeParse(raw);
  const parsedBinding = verifiedInvocationBindingSchema.safeParse(rawBinding);
  if (!parsed.success || !parsedBinding.success) return deny('invalid_request');
  const facts = parsed.data;
  const binding = parsedBinding.data;
  const token = binding.principal;
  if (!token.valid) return deny('invalid_token');
  if (token.audience !== facts.expectedAudience) return deny('invalid_audience');
  if (!token.scopes.includes(facts.requiredScope)) return deny('insufficient_scope');

  const connection = facts.connection;
  if (!connection) return deny('connection_not_found');
  if (connection.id !== token.subject.connectionId || connection.userId !== token.subject.userId) return deny('connection_subject_mismatch');
  if (connection.state !== 'connected') return deny('connection_inactive');
  if (connection.lifecycleRevision !== token.lifecycleRevision) return deny('stale_lifecycle_revision');

  const mailbox = facts.mailbox;
  if (!mailbox) return deny('mailbox_not_found');
  if (mailbox.id !== token.mailboxId) return deny('mailbox_subject_mismatch');
  if (mailbox.userId !== token.subject.userId) return deny('mailbox_owner_mismatch');
  const assignment = facts.assignment;
  if (!assignment) return deny('assignment_not_found');
  if (assignment.userId !== token.subject.userId || assignment.mailboxId !== mailbox.id
      || assignment.manager.kind !== 'agent_connection' || assignment.manager.connectionId !== connection.id) {
    return deny('assignment_subject_mismatch');
  }
  if (assignment.revision !== token.assignmentRevision) return deny('stale_assignment_revision');
  if (binding.mode === 'automatic' && !assignment.automaticProcessingEnabled) return deny('automatic_processing_disabled');

  const grant = facts.grant;
  if (!grant) return deny('grant_not_found');
  if (grant.userId !== token.subject.userId || grant.mailboxId !== mailbox.id
      || grant.manager.kind !== 'agent_connection' || grant.manager.connectionId !== connection.id) {
    return deny('grant_subject_mismatch');
  }
  if (grant.state !== 'active') return deny('grant_inactive');
  if (grant.revision !== token.grantRevision) return deny('stale_grant_revision');
  if (!grant.invocationModes.includes(binding.mode)) return deny('invocation_mode_denied');
  const capability = PUBLIC_AGENT_TOOL_CAPABILITY[facts.tool];
  if (!grant.capabilities.includes(capability)) return deny('capability_denied');
  if (facts.safetyCeiling.revision !== token.safetyRevision) return deny('stale_safety_revision');
  if (!facts.safetyCeiling.invocationModes.includes(binding.mode) || !facts.safetyCeiling.capabilities.includes(capability)) {
    return deny('safety_ceiling_denied');
  }
  return { allowed: true, authority: {
    userId: token.subject.userId, connectionId: connection.id, mailboxId: mailbox.id,
    mode: binding.mode, capability, lifecycleRevision: connection.lifecycleRevision,
    assignmentRevision: assignment.revision, grantRevision: grant.revision, safetyRevision: facts.safetyCeiling.revision,
  } };
}



export type AuthorizationRevisionVector = Readonly<{
  lifecycleRevision: number; assignmentRevision: number; grantRevision: number; safetyRevision: number;
}>;
export type FreshAuthorization = Readonly<{
  decision: AuthorizationDecision;
  evaluatedAt: string;
  revisions?: AuthorizationRevisionVector;
}>;
export interface FreshAuthorizationFactsLoader {
  /** Must load current facts plus a verified bearer/session binding for this invocation. */
  load(): Promise<Readonly<{ facts: AuthorizationFacts; binding: VerifiedInvocationBinding }>>;
}
export interface MutationAuthorizationFence {
  /** Final conditional check immediately before external mutation dispatch. */
  stillCurrent(authority: Extract<AuthorizationDecision, { allowed: true }>['authority']): Promise<boolean>;
}
export async function authorizeFreshInvocation(loader: FreshAuthorizationFactsLoader, now: () => Date = () => new Date()): Promise<FreshAuthorization> {
  const loaded = await loader.load();
  const decision = authorizeAgentTool(loaded.facts, loaded.binding);
  return decision.allowed
    ? { decision, evaluatedAt: now().toISOString(), revisions: {
        lifecycleRevision: decision.authority.lifecycleRevision, assignmentRevision: decision.authority.assignmentRevision,
        grantRevision: decision.authority.grantRevision, safetyRevision: decision.authority.safetyRevision,
      } }
    : { decision, evaluatedAt: now().toISOString() };
}


export type AuthorizationAuditRequest = Readonly<{ tool: PublicAgentTool }>;
export type AuthorizationAuditEvent = Readonly<{
  decisionId: string; evaluatedAt: string; allowed: boolean; userId: string; connectionId: string;
  mailboxId: string; tool: PublicAgentTool; mode: AgentInvocationMode; code: 'allowed' | AuthorizationDenialCode;
}>;
export interface AuthorizationAuditSink { record(event: AuthorizationAuditEvent): Promise<void>; }
/** Performs and audits initial authorization only. No mutation fence is claimed here. */
export async function authorizeAuditedFreshInvocation(input: Readonly<{
  loader: FreshAuthorizationFactsLoader; audit: AuthorizationAuditSink;
  request: AuthorizationAuditRequest; decisionId: string; now?: () => Date;
}>): Promise<FreshAuthorization & Readonly<{ decisionId: string }>> {
  const loaded = await input.loader.load();
  const decision = authorizeAgentTool(loaded.facts, loaded.binding);
  const evaluatedAt = (input.now ?? (() => new Date()))().toISOString();
  const principal = loaded.binding.principal;
  await input.audit.record({ decisionId: input.decisionId, evaluatedAt, allowed: decision.allowed,
    userId: principal.subject.userId, connectionId: principal.subject.connectionId, mailboxId: principal.mailboxId,
    tool: input.request.tool, mode: loaded.binding.mode, code: decision.allowed ? 'allowed' : decision.code });
  return decision.allowed
    ? { decisionId: input.decisionId, decision, evaluatedAt, revisions: {
        lifecycleRevision: decision.authority.lifecycleRevision, assignmentRevision: decision.authority.assignmentRevision,
        grantRevision: decision.authority.grantRevision, safetyRevision: decision.authority.safetyRevision,
      } }
    : { decisionId: input.decisionId, decision, evaluatedAt };
}

/** Executor-owned final fence. The callback is entered immediately after the fresh check. */
export async function executeAuthorizedMutation<Result>(
  authorization: FreshAuthorization,
  fence: MutationAuthorizationFence,
  mutate: (authority: Extract<AuthorizationDecision, { allowed: true }>['authority']) => Promise<Result>,
): Promise<Result | Readonly<{ allowed: false; code: 'stale_final_fence' }>> {
  if (!authorization.decision.allowed) throw new Error('INITIAL_AUTHORIZATION_REQUIRED');
  const authority = authorization.decision.authority;
  if (!await fence.stillCurrent(authority)) return { allowed: false, code: 'stale_final_fence' };
  return mutate(authority);
}
