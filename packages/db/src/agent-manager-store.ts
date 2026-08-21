import type { AgentConnectionState, MailboxManager, VerifiedAgentReconnect } from '@hypermail/contracts';
import { reconnectSecurityRevokedAgentConnection, reviseAgentConnectionLifecycle } from '@hypermail/contracts';
import type { SqlClient } from './postgres-client.js';

type ManagerColumns = { manager_kind: MailboxManager['kind']; agent_connection_id: string | null };

function managerColumns(manager: MailboxManager): ManagerColumns {
  return manager.kind === 'agent_connection'
    ? { manager_kind: manager.kind, agent_connection_id: manager.connectionId }
    : { manager_kind: manager.kind, agent_connection_id: null };
}

/** Atomic writers for revision-fenced Agent Connection and Mailbox Manager state. */
export class AgentManagerStore {
  constructor(private readonly sql: SqlClient) {}

  /** Existing local bootstrap selects Mastra explicitly; hosted onboarding may choose another Manager. */
  async initializeDefaultManager(userId: string, manager: MailboxManager = { kind: 'mastra' }): Promise<void> {
    const columns = managerColumns(manager);
    await this.sql.query(
      `insert into app.user_agent_preferences
         (user_id, default_manager_kind, default_agent_connection_id, revision)
       values ($1, $2, $3, 1)
       on conflict (user_id) do nothing`,
      [userId, columns.manager_kind, columns.agent_connection_id],
    );
  }

  /**
   * Copies the locked current default once and appends revision 1. Must run in the
   * same transaction that creates the user_accounts ownership edge.
   */
  async assignCurrentDefault(userId: string, accountId: string): Promise<void> {
    await this.sql.transaction(async (sql) => {
      const preference = await sql.query<ManagerColumns>(
        `select default_manager_kind as manager_kind,
                default_agent_connection_id as agent_connection_id
         from app.user_agent_preferences
         where user_id = $1
         for share`,
        [userId],
      );
      const current = preference.rows[0];
      if (!current) throw new Error('Mailbox Manager default is not configured.');

      await sql.query(
        `insert into app.mailbox_manager_assignments
           (user_id, account_id, manager_kind, agent_connection_id, automatic_processing_enabled, revision)
         values ($1, $2, $3, $4, false, 1)
         on conflict (user_id, account_id) do nothing`,
        [userId, accountId, current.manager_kind, current.agent_connection_id],
      );
    });
  }

  /** Default compare-and-swap; existing Mailbox assignments are never rewritten. */
  async reviseDefaultManager(input: Readonly<{
    userId: string;
    expectedRevision: number;
    manager: MailboxManager;
  }>): Promise<number> {
    const columns = managerColumns(input.manager);
    const result = await this.sql.query<{ revision: number }>(
      `update app.user_agent_preferences
       set default_manager_kind = $3, default_agent_connection_id = $4,
           revision = revision + 1, updated_at = now()
       where user_id = $1 and revision = $2
         and (default_manager_kind, default_agent_connection_id)
             is distinct from ($3::app.mailbox_manager_kind, $4::uuid)
       returning revision`,
      [input.userId, input.expectedRevision, columns.manager_kind, columns.agent_connection_id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Stale or unchanged Default Mailbox Manager revision.');
    return row.revision;
  }

  /** Lifecycle compare-and-swap; every legal state change increments its fence. */
  async reviseConnectionLifecycle(input: Readonly<{
    userId: string;
    connectionId: string;
    expectedState: AgentConnectionState;
    expectedRevision: number;
    state: AgentConnectionState;
  }>): Promise<number> {
    const next = reviseAgentConnectionLifecycle(
      { state: input.expectedState, lifecycleRevision: input.expectedRevision },
      input.state,
    );
    const result = await this.sql.query<{ lifecycle_revision: number }>(
      `update app.agent_connections
       set state = $5, lifecycle_revision = $4, updated_at = now()
       where user_id = $1 and id = $2 and state = $3 and lifecycle_revision = $6
       returning lifecycle_revision`,
      [input.userId, input.connectionId, input.expectedState, next.lifecycleRevision, next.state, input.expectedRevision],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Stale Agent Connection lifecycle revision.');
    return row.lifecycle_revision;
  }

  /** Records a short-lived proof issued by the verified reconnect ceremony. */
  async issueVerifiedReconnectProof(input: VerifiedAgentReconnect & Readonly<{ expiresAt: string }>): Promise<void> {
    await this.sql.query(
      `insert into app.agent_connection_reconnect_proofs (event_id, user_id, connection_id, verified_at, expires_at)
       values ($1, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz)`,
      [input.verificationEventId, input.userId, input.connectionId, input.verifiedAt, input.expiresAt],
    );
  }

  /** Distinct verified ceremony; generic lifecycle CAS cannot resurrect security revocation. */
  async reconnectSecurityRevoked(input: VerifiedAgentReconnect & Readonly<{ expectedRevision: number }>): Promise<number> {
    const next = reconnectSecurityRevokedAgentConnection(
      { id: input.connectionId, userId: input.userId, state: 'security_revoked', lifecycleRevision: input.expectedRevision },
      { userId: input.userId, connectionId: input.connectionId, verificationEventId: input.verificationEventId, verifiedAt: input.verifiedAt },
    );
    return this.sql.transaction(async sql => {
      const proof = await sql.query<{ event_id: string }>(
        `update app.agent_connection_reconnect_proofs set consumed_at = now(), lifecycle_revision = $5
         where event_id = $1 and user_id = $2::uuid and connection_id = $3::uuid
           and verified_at = $4::timestamptz and consumed_at is null and expires_at > now()
         returning event_id`,
        [input.verificationEventId, input.userId, input.connectionId, input.verifiedAt, next.lifecycleRevision],
      );
      if (!proof.rows[0]) throw new Error('Verified reconnect proof is missing, expired, or already consumed.');
      const result = await sql.query<{ lifecycle_revision: number }>(
        `update app.agent_connections
         set state = 'connected', lifecycle_revision = $4, verified_at = $5::timestamptz, updated_at = now()
         where user_id = $1 and id = $2 and state = 'security_revoked' and lifecycle_revision = $3
         returning lifecycle_revision`,
        [input.userId, input.connectionId, input.expectedRevision, next.lifecycleRevision, next.verifiedAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Stale or ineligible Agent Connection verified reconnect.');
      await sql.query(
        `insert into app.agent_connection_reconnect_events (event_id, connection_id, lifecycle_revision, verified_at)
         values ($1, $2::uuid, $3, $4::timestamptz)`,
        [input.verificationEventId, input.connectionId, row.lifecycle_revision, input.verifiedAt],
      );
      return row.lifecycle_revision;
    });
  }

  /**
   * Atomically reassigns a Mailbox and fences its existing grant. A Manager
   * replacement always disables automatic processing. Selecting no Manager
   * revokes (but does not retarget) the old grant; selecting a new Manager
   * retargets it in reapproval-required state.
   */
  async reviseAssignmentAndFenceGrant(input: Readonly<{
    userId: string; accountId: string; expectedAssignmentRevision: number; expectedGrantRevision: number;
    manager: MailboxManager;
    /** @deprecated Manager replacement always disables automatic processing. */
    automaticProcessingEnabled?: boolean;
  }>): Promise<Readonly<{ assignmentRevision: number; grantRevision: number }>> {
    const columns = managerColumns(input.manager);
    return this.sql.transaction(async sql => {
      const assignment = await sql.query<{ revision: number }>(
        `update app.mailbox_manager_assignments set manager_kind = $4, agent_connection_id = $5,
           automatic_processing_enabled = false, revision = revision + 1, updated_at = now()
         where user_id = $1 and account_id = $2 and revision = $3
           and (manager_kind, agent_connection_id)
               is distinct from ($4::app.mailbox_manager_kind, $5::uuid)
         returning revision`,
        [input.userId, input.accountId, input.expectedAssignmentRevision, columns.manager_kind, columns.agent_connection_id],
      );
      const grant = input.manager.kind === 'none'
        ? await sql.query<{ revision: number }>(
          `update app.agent_capability_grants set state = 'revoked',
             revision = revision + 1, updated_at = now()
           where user_id = $1 and account_id = $2 and revision = $3 and state <> 'revoked'
           returning revision`,
          [input.userId, input.accountId, input.expectedGrantRevision],
        )
        : await sql.query<{ revision: number }>(
          `update app.agent_capability_grants set manager_kind = $4, agent_connection_id = $5,
             state = 'reapproval_required', revision = revision + 1, updated_at = now()
           where user_id = $1 and account_id = $2 and revision = $3
           returning revision`,
          [input.userId, input.accountId, input.expectedGrantRevision, columns.manager_kind, columns.agent_connection_id],
        );
      if (!assignment.rows[0] || !grant.rows[0]) throw new Error('Stale assignment or capability grant revision.');
      return { assignmentRevision: assignment.rows[0].revision, grantRevision: grant.rows[0].revision };
    });
  }

  /** Assignment compare-and-swap and history append occur in one transaction. */
  async reviseAssignment(input: Readonly<{
    userId: string;
    accountId: string;
    expectedRevision: number;
    manager: MailboxManager;
    automaticProcessingEnabled: boolean;
  }>): Promise<number> {
    const columns = managerColumns(input.manager);
    return this.sql.transaction(async (sql) => {
      const updated = await sql.query<{ id: string; revision: number; updated_at: Date }>(
        `update app.mailbox_manager_assignments
         set manager_kind = $4, agent_connection_id = $5,
             automatic_processing_enabled = case
               when (manager_kind, agent_connection_id)
                 is distinct from ($4::app.mailbox_manager_kind, $5::uuid)
               then false else $6
             end,
             revision = revision + 1, updated_at = now()
         where user_id = $1 and account_id = $2 and revision = $3
           and (manager_kind, agent_connection_id, automatic_processing_enabled)
               is distinct from ($4::app.mailbox_manager_kind, $5::uuid, $6::boolean)
           and (
             (manager_kind, agent_connection_id)
               is not distinct from ($4::app.mailbox_manager_kind, $5::uuid)
             or not exists (
               select 1 from app.agent_capability_grants
               where user_id = $1 and account_id = $2
             )
           )
         returning id, revision, updated_at`,
        [input.userId, input.accountId, input.expectedRevision, columns.manager_kind, columns.agent_connection_id, input.automaticProcessingEnabled],
      );
      const assignment = updated.rows[0];
      if (!assignment) throw new Error('Stale or unchanged Mailbox Manager assignment revision.');
      return assignment.revision;
    });
  }
}
