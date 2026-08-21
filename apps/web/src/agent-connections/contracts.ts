export type ManagerChoice = Readonly<{ kind: 'mastra' | 'none' }> | Readonly<{ kind: 'agent_connection'; connectionId: string }>;
export type ConnectionState = 'connected' | 'paused' | 'disconnected' | 'security_revoked';
export type GrantState = 'active' | 'revoked' | 'reapproval_required';
export type AgentConnectionView = Readonly<{ id: string; adapter: string; displayName: string; state: ConnectionState; lifecycleRevision: number; verifiedAt: string }>;
export type ManagerPreferenceView = Readonly<{ manager: ManagerChoice; revision: number }>;
export type MailboxManagerView = Readonly<{ mailboxId: string; mailboxLabel: string; assignment: Readonly<{ manager: ManagerChoice; automaticProcessingEnabled: boolean; revision: number }>; grant: null | Readonly<{ id: string; state: GrantState; revision: number; capabilities: readonly string[]; invocationModes: readonly ('interactive'|'automatic')[] }> }>;
export type ManagerSettingsView = Readonly<{ onboardingRequired: boolean; defaultManager: ManagerPreferenceView | null; connections: readonly AgentConnectionView[]; mailboxes: readonly MailboxManagerView[] }>;
export interface AgentConnectionsRepository {
  read(userId: string): Promise<ManagerSettingsView>;
  setDefault(userId: string, manager: ManagerChoice, expectedRevision: number): Promise<void>;
  setLifecycle(userId: string, connectionId: string, state: ConnectionState, expectedRevision: number): Promise<void>;
  setAssignment(userId: string, mailboxId: string, manager: ManagerChoice, automatic: boolean, expectedAssignmentRevision: number, expectedGrantRevision?: number): Promise<void>;
  reapproveGrant(userId: string, mailboxId: string, expectedGrantRevision: number, approvalEventId: string, approvedAt: string): Promise<void>;
}
export class ManagerInputError extends Error {}
export class ManagerConflictError extends Error {}
export class ManagerNotFoundError extends Error {}
