import { describe, expect, it } from 'vitest';
import {
  agentEvaluateJobSchema,
  queueJobSchema,
  runtimeCapabilitiesSchema,
  runtimeHealthSchema,
} from '../src/runtime.js';

const userId = '00000000-0000-4000-8000-000000000001';
const id = 'b2c3d4e5-f678-4abc-8def-1234567890ab';

describe('runtime contracts', () => {
  it('rejects queue payload confusion and unknown fields', () => {
    expect(agentEvaluateJobSchema.parse({ jobId: id })).toEqual({ jobId: id });
    expect(agentEvaluateJobSchema.parse({ jobId: id, userId })).toEqual({ jobId: id, userId });
    expect(() => agentEvaluateJobSchema.parse({ jobId: id, userId: 'bad' })).toThrow();
    expect(() => agentEvaluateJobSchema.parse({ jobId: id, userId, extra: true })).toThrow();
    expect(() => queueJobSchema.parse({ name: 'agent.evaluate', payload: { notificationId: id } })).toThrow();
    expect(() => queueJobSchema.parse({ name: 'send.email', payload: { draftId: id } })).toThrow();
  });

  it('keeps health responses bounded and secret-free', () => {
    expect(runtimeHealthSchema.parse({
      live: true,
      ready: false,
      checkedAt: '2025-01-01T00:00:00.000Z',
      dependencies: {
        database: 'ready', queue: 'ready', hypermail: 'unavailable', model: 'ready',
        scheduler: 'ready', notifications: 'degraded', approvedSend: 'disabled',
      },
    }).ready).toBe(false);
    expect(() => runtimeHealthSchema.parse({
      live: true, ready: false, checkedAt: '2025-01-01T00:00:00.000Z',
      dependencies: { database: 'unavailable', reason: 'postgresql://secret' },
    })).toThrow();
  });

  it('allows only mailbox mutation capabilities and never send', () => {
    expect(runtimeCapabilitiesSchema.parse({
      approvedSend: 'disabled',
      autonomousMutations: ['archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread'],
    }).approvedSend).toBe('disabled');
    expect(() => runtimeCapabilitiesSchema.parse({ approvedSend: 'configured', autonomousMutations: ['draft_create'] })).toThrow();
    expect(() => runtimeCapabilitiesSchema.parse({ approvedSend: 'configured', autonomousMutations: ['send'] })).toThrow();
  });
});
