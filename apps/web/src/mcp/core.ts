import type { AgentInvocationMode } from '@hypermail/contracts';
import type { PublicAgentTool } from '@hypermail/agent-connections';
import { z } from 'zod';
import { publicToolRegistry } from './registry.js';
import type { PublicToolArgs, PublicToolName, PublicToolResult } from './contracts.js';

export type VerifiedAccessPrincipal = Readonly<{ credentialId: string; familyId: string; clientId: string; userId: string; connectionId: string; mailboxId: string; audience: string; scopes: readonly string[]; lifecycleRevision: number; assignmentRevision: number; grantRevision: number; safetyRevision: number }>;
export type VerifiedInvocationBinding = Readonly<{ principal: VerifiedAccessPrincipal; mode: AgentInvocationMode; sessionId: string; signal?: AbortSignal }>;
export type TenantAuthority = Readonly<{ authorizationDecisionId: string; credentialId: string; userId: string; connectionId: string; mailboxId: string; mode: AgentInvocationMode; lifecycleRevision: number; assignmentRevision: number; grantRevision: number; safetyRevision: number; signal?: AbortSignal }>;
export type InitialAuthorization = Readonly<{ authority: TenantAuthority; capability: string; decisionId: string }>;

/** Implemented by the verified bearer/session adapter; tool arguments never select tenant or mode. */
export interface PublicInvocationAuthorizer {
  authorize(binding: VerifiedInvocationBinding, tool: PublicAgentTool): Promise<InitialAuthorization>;
}
/** Must compare every frozen authority revision to fresh state. */
export interface FinalMutationFence { stillCurrent(authorization: InitialAuthorization): Promise<boolean>; }
export interface TenantMailboxOperations {
  list(authority: TenantAuthority, args: PublicToolArgs<'list_emails'>): Promise<PublicToolResult<'list_emails'>>;
  search(authority: TenantAuthority, args: PublicToolArgs<'search_emails'>): Promise<PublicToolResult<'search_emails'>>;
  read(authority: TenantAuthority, args: PublicToolArgs<'read_email'>): Promise<PublicToolResult<'read_email'>>;
  readAttachment(authority: TenantAuthority, args: PublicToolArgs<'read_attachment'>): Promise<PublicToolResult<'read_attachment'>>;
  listFolders(authority: TenantAuthority, args: PublicToolArgs<'list_folders'>): Promise<PublicToolResult<'list_folders'>>;
  archive(authority: TenantAuthority, args: PublicToolArgs<'archive_email'>): Promise<PublicToolResult<'archive_email'>>;
  trashRecoverable(authority: TenantAuthority, args: PublicToolArgs<'trash_email'>): Promise<PublicToolResult<'trash_email'>>;
  move(authority: TenantAuthority, args: PublicToolArgs<'move_email'>): Promise<PublicToolResult<'move_email'>>;
  markRead(authority: TenantAuthority, args: PublicToolArgs<'mark_read'>): Promise<PublicToolResult<'mark_read'>>;
  markUnread(authority: TenantAuthority, args: PublicToolArgs<'mark_unread'>): Promise<PublicToolResult<'mark_unread'>>;
}
/** App-draft port: implementations adapt to DraftService.agentDraftWriter and inject the authorized mailbox account. */
export interface TenantDraftOperations {
  create(authority: TenantAuthority, args: PublicToolArgs<'draft_email'>): Promise<PublicToolResult<'draft_email'>>;
  edit(authority: TenantAuthority, args: PublicToolArgs<'edit_draft'>): Promise<PublicToolResult<'edit_draft'>>;
}
/** Deliberately has no send/confirm operation. A request can only enter pending owner approval. */
export interface OwnerSendApprovalRequests {
  requestPending(authority: TenantAuthority, args: PublicToolArgs<'request_send_email'>): Promise<PublicToolResult<'request_send_email'>>;
}
export type PublicFacadePorts = Readonly<{ authorizer: PublicInvocationAuthorizer; fence: FinalMutationFence; mailbox: TenantMailboxOperations; drafts: TenantDraftOperations; sendRequests: OwnerSendApprovalRequests }>;
export type PublicErrorCode = 'invalid_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'temporarily_unavailable' | 'internal_error';
const errorMessages: Record<PublicErrorCode, string> = { invalid_request: 'Invalid tool arguments.', unauthorized: 'Authentication is required.', forbidden: 'This operation is not authorized.', not_found: 'The requested resource was not found.', conflict: 'The resource changed; refresh and retry.', temporarily_unavailable: 'The operation is temporarily unavailable.', internal_error: 'The operation failed.' };
export class PublicMcpError extends Error { constructor(readonly code: PublicErrorCode) { super(errorMessages[code]); this.name = 'PublicMcpError'; } }
export function mapPublicMcpError(error: unknown): PublicMcpError {
  if (error instanceof PublicMcpError) return error;
  if (error instanceof z.ZodError || error instanceof RangeError || error instanceof TypeError) return new PublicMcpError('invalid_request');
  const name = error instanceof Error ? error.name : '';
  if (name === 'DraftNotFoundError') return new PublicMcpError('not_found');
  if (name === 'DraftConflictError') return new PublicMcpError('conflict');
  if (name === 'DraftBlockedError' || name === 'SendRejectedError' || name === 'FreshAuthRequiredError') return new PublicMcpError('forbidden');
  return new PublicMcpError('internal_error');
}
const mutating = new Set<PublicToolName>(['archive_email', 'trash_email', 'move_email', 'mark_read', 'mark_unread', 'draft_email', 'edit_draft', 'request_send_email']);

export class PublicMcpFacadeCore {
  constructor(private readonly ports: PublicFacadePorts) {}
  async invoke<Name extends PublicToolName>(binding: VerifiedInvocationBinding, name: Name, rawArgs: unknown): Promise<PublicToolResult<Name>> {
    try {
      const definition = publicToolRegistry[name];
      const args: unknown = definition.args.parse(rawArgs);
      const authorization = await this.ports.authorizer.authorize(binding, name);
      const execute = (): Promise<unknown> => this.dispatch(name, authorization.authority, args as never);
      let rawResult: unknown;
      if (mutating.has(name)) {
        // This is intentionally the last awaited operation before entering the mutating port.
        if (!await this.ports.fence.stillCurrent(authorization)) throw new PublicMcpError('forbidden');
        rawResult = await execute();
      } else rawResult = await execute();
      return definition.result.parse(rawResult) as PublicToolResult<Name>;
    } catch (error) { throw mapPublicMcpError(error); }
  }
  private dispatch(name: PublicToolName, authority: TenantAuthority, args: never): Promise<unknown> {
    switch (name) {
      case 'list_emails': return this.ports.mailbox.list(authority, args);
      case 'search_emails': return this.ports.mailbox.search(authority, args);
      case 'read_email': return this.ports.mailbox.read(authority, args);
      case 'read_attachment': return this.ports.mailbox.readAttachment(authority, args);
      case 'list_folders': return this.ports.mailbox.listFolders(authority, args);
      case 'archive_email': return this.ports.mailbox.archive(authority, args);
      case 'trash_email': return this.ports.mailbox.trashRecoverable(authority, args);
      case 'move_email': return this.ports.mailbox.move(authority, args);
      case 'mark_read': return this.ports.mailbox.markRead(authority, args);
      case 'mark_unread': return this.ports.mailbox.markUnread(authority, args);
      case 'draft_email': return this.ports.drafts.create(authority, args);
      case 'edit_draft': return this.ports.drafts.edit(authority, args);
      case 'request_send_email': return this.ports.sendRequests.requestPending(authority, args);
    }
  }
}
