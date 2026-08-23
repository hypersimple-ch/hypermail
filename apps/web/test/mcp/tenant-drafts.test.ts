/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { TenantDraftServiceAdapter, type TenantAuthority } from '../../src/mcp/index.js';

const authority: TenantAuthority = { authorizationDecisionId: 'decision', credentialId: 'credential', userId: 'user', connectionId: 'connection', mailboxId: 'mailbox', mode: 'interactive', lifecycleRevision: 1, assignmentRevision: 1, grantRevision: 1, safetyRevision: 1 };
const journal = { prepare: async () => ({ actionId: 'action' }), start: async () => undefined, verifying: async () => undefined, verified: async () => undefined, cancel: async () => undefined, finish: async () => undefined };

describe('TenantDraftServiceAdapter body format', () => {
  it('forces public MCP draft creation to markdown', async () => {
    const createAgent = vi.fn(async () => ({ accountId: 'mailbox', recipients: [{ kind: 'to' as const, address: 'to@example.test' }], subject: 'Subject', body: '**Body**', bodyFormat: 'markdown' as const, id: '00000000-0000-4000-8000-000000000001', sourceMessageId: null, createdBy: 'agent' as const, state: 'editing' as const, version: 1, createdAt: '', updatedAt: '' }));
    const drafts = { agentDraftWriter: { createAgent, editAgent: vi.fn() } };
    await new TenantDraftServiceAdapter(drafts as never, async () => true, journal as never).create(authority, { to: [{ address: 'to@example.test' }], subject: 'Subject', body: '**Body**' });
    expect(createAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: '**Body**', bodyFormat: 'markdown' }));
  });
});
