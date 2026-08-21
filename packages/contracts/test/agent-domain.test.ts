import { describe, expect, it } from 'vitest';
import {
  agentConnectionSchema,
  assignDefaultManagerToMailbox,
  mailboxManagerAssignmentRevisionSchema,
  mailboxManagerSchema,
  reviseAgentConnectionLifecycle,
  reviseMailboxManagerAssignment,
  transitionAgentConnection,
  reconnectSecurityRevokedAgentConnection,
  userAgentPreferenceSchema,
} from '../src/index.js';

const userId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';
const mailboxId = '00000000-0000-4000-8000-000000000003';
const assignmentId = '00000000-0000-4000-8000-000000000004';
const now = '2026-08-10T12:00:00.000Z';

describe('Agent Connection contracts', () => {
  it('accepts an agent-neutral verified external identity and rejects unknown data', () => {
    const connection = {
      id: connectionId,
      userId,
      adapter: 'hermes',
      externalProfileId: 'profile-stable-123',
      displayName: 'Personal Hermes',
      state: 'connected',
      lifecycleRevision: 1,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    } as const;
    expect(agentConnectionSchema.parse(connection)).toEqual(connection);
    expect(() => agentConnectionSchema.parse({ ...connection, credential: 'secret' })).toThrow();
    expect(() => agentConnectionSchema.parse({ ...connection, adapter: 'Hermes Profile' })).toThrow();
  });

  it('enforces pause, disconnect, security revocation, and verified reconnection paths', () => {
    expect(transitionAgentConnection('connected', 'paused')).toBe('paused');
    expect(transitionAgentConnection('paused', 'connected')).toBe('connected');
    expect(transitionAgentConnection('connected', 'disconnected')).toBe('disconnected');
    expect(transitionAgentConnection('disconnected', 'connected')).toBe('connected');
    expect(transitionAgentConnection('connected', 'security_revoked')).toBe('security_revoked');
    expect(() => transitionAgentConnection('security_revoked', 'connected')).toThrow();
    expect(reconnectSecurityRevokedAgentConnection(
      { id: connectionId, userId, state: 'security_revoked', lifecycleRevision: 7 },
      { connectionId, userId, verificationEventId: 'verified-reconnect-event-1', verifiedAt: now },
    )).toEqual({ state: 'connected', lifecycleRevision: 8, verifiedAt: now });
    expect(() => transitionAgentConnection('connected', 'connected')).toThrow(/Illegal agent connection transition/);
    expect(() => transitionAgentConnection('disconnected', 'paused')).toThrow();
    expect(() => transitionAgentConnection('security_revoked', 'paused')).toThrow();
    expect(reviseAgentConnectionLifecycle({ state: 'paused', lifecycleRevision: 4 }, 'connected')).toEqual({
      state: 'connected', lifecycleRevision: 5,
    });
    expect(() => reviseAgentConnectionLifecycle({ state: 'connected', lifecycleRevision: 0 }, 'paused')).toThrow();
  });
});

describe('Mailbox Manager contracts', () => {
  it('uses an exhaustive strict discriminant and requires external connection identity', () => {
    expect(mailboxManagerSchema.parse({ kind: 'mastra' })).toEqual({ kind: 'mastra' });
    expect(mailboxManagerSchema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(mailboxManagerSchema.parse({ kind: 'agent_connection', connectionId })).toEqual({ kind: 'agent_connection', connectionId });
    expect(() => mailboxManagerSchema.parse({ kind: 'agent_connection' })).toThrow();
    expect(() => mailboxManagerSchema.parse({ kind: 'mastra', connectionId })).toThrow();
    expect(() => mailboxManagerSchema.parse({ kind: 'fallback' })).toThrow();
  });

  it('copies the current default once without enabling automatic processing', () => {
    const preference = userAgentPreferenceSchema.parse({
      userId,
      defaultManager: { kind: 'agent_connection', connectionId },
      revision: 7,
      updatedAt: now,
    });
    const assignment = assignDefaultManagerToMailbox({ assignmentId, mailboxId, preference, now });
    expect(assignment).toMatchObject({
      id: assignmentId,
      userId,
      mailboxId,
      manager: { kind: 'agent_connection', connectionId },
      automaticProcessingEnabled: false,
      revision: 1,
    });

    const changedPreference = { ...preference, defaultManager: { kind: 'none' } as const, revision: 8 };
    expect(assignDefaultManagerToMailbox({ assignmentId: connectionId, mailboxId, preference: changedPreference, now }).manager).toEqual({ kind: 'none' });
    expect(assignment.manager).toEqual({ kind: 'agent_connection', connectionId });
  });

  it('increments assignment fencing revision and emits an immutable snapshot', () => {
    const current = assignDefaultManagerToMailbox({
      assignmentId,
      mailboxId,
      preference: userAgentPreferenceSchema.parse({ userId, defaultManager: { kind: 'mastra' }, revision: 1, updatedAt: now }),
      now,
    });
    const changedAt = '2026-08-10T13:00:00.000Z';
    const changed = reviseMailboxManagerAssignment(current, {
      manager: { kind: 'agent_connection', connectionId },
      automaticProcessingEnabled: true,
    }, changedAt);
    expect(changed.assignment).toMatchObject({ revision: 2, manager: { kind: 'agent_connection', connectionId } });
    expect(changed.revision).toMatchObject({ assignmentId, revision: 2, userId, mailboxId });
    expect(current).toMatchObject({ revision: 1, manager: { kind: 'mastra' } });
    expect(() => reviseMailboxManagerAssignment(current, {
      manager: { kind: 'mastra' }, automaticProcessingEnabled: false,
    }, changedAt)).toThrow(/must change configuration/);
  });

  it('validates immutable assignment snapshots independently of current state', () => {
    expect(mailboxManagerAssignmentRevisionSchema.parse({
      assignmentId,
      userId,
      mailboxId,
      manager: { kind: 'mastra' },
      automaticProcessingEnabled: true,
      revision: 3,
      changedAt: now,
    }).revision).toBe(3);
    expect(() => mailboxManagerAssignmentRevisionSchema.parse({
      assignmentId, userId, mailboxId, manager: { kind: 'mastra' }, automaticProcessingEnabled: false, revision: 0, changedAt: now,
    })).toThrow();
  });
});
