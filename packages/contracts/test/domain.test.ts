import { describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  apiErrorSchema,
  replayState,
  transitionAction,
  transitionActivity,
  transitionDraft,
  transitionHealth,
  transitionJob,
  transitionNotification,
  transitionQuestion,
} from '../src/index.js';

const id = 'b2c3d4e5-f678-4abc-8def-1234567890ab';

describe('strict domain contracts', () => {
  it('accepts only allowlisted autonomous actions', () => {
    expect(agentDecisionSchema.parse({
      state: 'actionable',
      rationale: 'Known newsletter preference',
      actions: [{ kind: 'archive', target: { accountId: id, messageId: id }, reason: 'Routine newsletter' }],
    }).state).toBe('actionable');

    expect(() => agentDecisionSchema.parse({
      state: 'actionable',
      rationale: 'Forbidden',
      actions: [{ kind: 'send', target: { accountId: id, draftId: id }, reason: 'Never autonomous' }],
    })).toThrow();
  });

  it('rejects unknown API error fields', () => {
    expect(() => apiErrorSchema.parse({
      error: { code: 'INTERNAL', message: 'Safe', correlationId: 'correlation-1', retryable: false, stack: 'secret' },
    })).toThrow();
  });
});

describe('transition reducers', () => {
  it('keeps handled activity new until explicit acknowledgement', () => {
    expect(transitionActivity('new', 'handled')).toBe('handled');
    expect(transitionActivity('handled', 'acknowledged')).toBe('acknowledged');
    expect(() => transitionActivity('new', 'acknowledged')).toThrow(/Illegal activity transition/);
    expect(() => transitionActivity('waiting_question', 'acknowledged')).toThrow();
    expect(() => transitionActivity('failed', 'acknowledged')).toThrow();
  });

  it('enforces question, job, action, draft, notification, and health paths', () => {
    expect(transitionQuestion('open', 'answered')).toBe('answered');
    expect(transitionJob('running', 'suspended')).toBe('suspended');
    expect(transitionAction('executing', 'unverifiable')).toBe('unverifiable');
    expect(transitionDraft('ready', 'sending')).toBe('sending');
    expect(transitionNotification('failed', 'pending')).toBe('pending');
    expect(transitionHealth('healthy', 'paused')).toBe('paused');
    expect(() => transitionAction('planned', 'succeeded')).toThrow();
    expect(() => transitionDraft('sent', 'editing')).toThrow();
  });

  it('replays deterministically and rejects a corrupted replay', () => {
    const events = ['running', 'failed', 'pending', 'running', 'succeeded'] as const;
    expect(replayState('pending' as const, events, transitionJob)).toBe('succeeded');
    expect(() => replayState('pending' as const, ['succeeded'] as const, transitionJob)).toThrow();
  });
});
