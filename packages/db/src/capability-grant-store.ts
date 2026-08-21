import { z } from 'zod';
import {
  agentCapabilitySchema,
  agentInvocationModeSchema,
  capabilityGrantSchema,
  type AgentCapability,
  type AgentInvocationMode,
  type CapabilityGrant,
  type CapabilityGrantReapproval,
} from '@hypermail/contracts';
import type { SqlClient } from './postgres-client.js';

export class StaleCapabilityGrantRevisionError extends Error {
  constructor() { super('Stale or unchanged capability grant revision.'); this.name = 'StaleCapabilityGrantRevisionError'; }
}
type GrantRow = Record<string, unknown>;
const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
function rowToGrant(row: GrantRow): CapabilityGrant {
  return capabilityGrantSchema.parse({
    id: row['id'], userId: row['user_id'], mailboxId: row['account_id'],
    manager: row['manager_kind'] === 'agent_connection'
      ? { kind: 'agent_connection', connectionId: row['agent_connection_id'] }
      : { kind: 'mastra' },
    capabilities: row['capabilities'], invocationModes: row['invocation_modes'], state: row['state'],
    revision: Number(row['revision']), approvedAt: date(row['approved_at']), createdAt: date(row['created_at']), updatedAt: date(row['updated_at']),
  });
}
export type CreateCapabilityGrant = Omit<CapabilityGrant, 'id' | 'revision' | 'state' | 'createdAt' | 'updatedAt'> & Readonly<{ id?: string }>;
export type ReviseCapabilityGrant = Readonly<{
  id: string; userId: string; expectedRevision: number; manager: CapabilityGrant['manager']; capabilities: readonly AgentCapability[];
  invocationModes: readonly AgentInvocationMode[]; state: CapabilityGrant['state']; approvedAt: string;
}>;

/** PostgreSQL current-row CAS; migration triggers append every successful revision. */
export class CapabilityGrantStore {
  constructor(private readonly sql: SqlClient) {}
  async create(input: CreateCapabilityGrant): Promise<CapabilityGrant> {
    const candidate = capabilityGrantSchema.omit({ id: true, revision: true, createdAt: true, updatedAt: true }).parse({
      userId: input.userId, mailboxId: input.mailboxId, manager: input.manager,
      capabilities: input.capabilities, invocationModes: input.invocationModes,
      state: 'reapproval_required', approvedAt: input.approvedAt,
    });
    const connectionId = candidate.manager.kind === 'agent_connection' ? candidate.manager.connectionId : null;
    const result = await this.sql.query<GrantRow>(
      `insert into app.agent_capability_grants
       (id, user_id, account_id, manager_kind, agent_connection_id, capabilities, invocation_modes, state, revision, approved_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, $4::app.mailbox_manager_kind, $5::uuid,
               $6::text[], $7::text[], $8::app.capability_grant_state, 1, $9::timestamptz)
       returning *`,
      [input.id ?? null, candidate.userId, candidate.mailboxId, candidate.manager.kind, connectionId,
        candidate.capabilities, candidate.invocationModes, 'reapproval_required', candidate.approvedAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Capability grant was not created.');
    return rowToGrant(row);
  }
  async revise(input: ReviseCapabilityGrant): Promise<CapabilityGrant> {
    const update = z.strictObject({
      id: z.uuid(), userId: z.uuid(), expectedRevision: z.number().int().positive(),
      manager: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('mastra') }), z.strictObject({ kind: z.literal('agent_connection'), connectionId: z.uuid() })]),
      capabilities: z.array(agentCapabilitySchema).max(agentCapabilitySchema.options.length).refine(items => new Set(items).size === items.length, 'Capabilities must be unique.'),
      invocationModes: z.array(agentInvocationModeSchema).min(1).max(agentInvocationModeSchema.options.length).refine(items => new Set(items).size === items.length, 'Invocation modes must be unique.'),
      state: z.enum(['active', 'revoked', 'reapproval_required']), approvedAt: z.iso.datetime({ offset: true }),
    }).parse(input);
    const result = await this.sql.query<GrantRow>(
      `update app.agent_capability_grants
       set manager_kind = $4::app.mailbox_manager_kind, agent_connection_id = $5::uuid,
           capabilities = $6::text[], invocation_modes = $7::text[], state = $8::app.capability_grant_state,
           approved_at = $9::timestamptz, revision = revision + 1, updated_at = now()
       where id = $1::uuid and user_id = $2::uuid and revision = $3
         and not (state <> 'active' and $8::app.capability_grant_state = 'active')
         and not (state = 'active' and (manager_kind, agent_connection_id) is distinct from ($4::app.mailbox_manager_kind, $5::uuid))
         and (manager_kind, agent_connection_id, capabilities, invocation_modes, state, approved_at)
             is distinct from ($4::app.mailbox_manager_kind, $5::uuid, $6::text[], $7::text[], $8::app.capability_grant_state, $9::timestamptz)
       returning *`,
      [update.id, update.userId, update.expectedRevision, update.manager.kind,
        update.manager.kind === 'agent_connection' ? update.manager.connectionId : null,
        update.capabilities, update.invocationModes, update.state, update.approvedAt],
    );
    const row = result.rows[0];
    if (!row) throw new StaleCapabilityGrantRevisionError();
    return rowToGrant(row);
  }
  /** Explicit User reapproval; generic CAS cannot reactivate a non-active grant. */
  async reapprove(input: CapabilityGrantReapproval & Readonly<{ grantId: string; expectedRevision: number }>): Promise<CapabilityGrant> {
    if (input.approverUserId.length === 0 || input.approvalEventId.length === 0) throw new Error('Invalid capability grant reapproval artifact.');
    return this.sql.transaction(async sql => {
      const result = await sql.query<GrantRow>(
        `update app.agent_capability_grants set state = 'active', approved_at = $4::timestamptz,
             revision = revision + 1, updated_at = now()
         where id = $1::uuid and user_id = $2::uuid and revision = $3 and state = 'reapproval_required'
         returning *`,
        [input.grantId, input.approverUserId, input.expectedRevision, input.approvedAt],
      );
      const row = result.rows[0];
      if (!row) throw new StaleCapabilityGrantRevisionError();
      await sql.query(
        `insert into app.capability_grant_reapproval_events (event_id, grant_id, grant_revision, approver_user_id, approved_at)
         values ($1, $2::uuid, $3, $4::uuid, $5::timestamptz)`,
        [input.approvalEventId, input.grantId, Number(row['revision']), input.approverUserId, input.approvedAt],
      );
      return rowToGrant(row);
    });
  }

  async getCurrent(userId: string, mailboxId: string): Promise<CapabilityGrant | null> {
    const result = await this.sql.query<GrantRow>(
      `select * from app.agent_capability_grants where user_id = $1::uuid and account_id = $2::uuid`, [userId, mailboxId],
    );
    return result.rows[0] ? rowToGrant(result.rows[0]) : null;
  }
}
