import { describe, expect, it } from 'vitest';
import {
  agentDecisionSchema,
  apiErrorSchema,
  actionKindSchema,
  actionSchema,
  agentDraftFieldsSchema,
  draftFieldsSchema,
  ownerActionCorrectionSchema,
  plannedActionSchema,
  recipientProblem,
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
const otherId = 'c2c3d4e5-f678-4abc-8def-1234567890ab';
const fields = { recipients: [{ kind: 'to' as const, address: 'owner@example.com' }], subject: 'Reply', body: 'Thank you', bodyFormat: 'markdown' as const };
const archive = { key: 'classify', confidence: 0.9, reason: 'Routine newsletter', evidenceIds: [`mail:${id}`], dependsOn: [], kind: 'archive', target: { accountId: id, messageId: id } };
const draft = { ...archive, key: 'reply', kind: 'draft_create', draft: fields };
const decision = (actions: unknown[]) => ({ schemaVersion: 2, state: 'actionable', rationale: 'Known preference', actions });

describe('strict domain contracts', () => {
  it('accepts only the five model actions while preserving interactive read-state actions', () => {
    expect(agentDecisionSchema.parse(decision([archive])).state).toBe('actionable');
    for (const kind of ['send', 'mark_read', 'mark_unread', 'delete']) {
      expect(agentDecisionSchema.safeParse(decision([{ ...archive, kind }])).success).toBe(false);
    }
    expect(actionKindSchema.parse('mark_read')).toBe('mark_read');
    expect(actionSchema.parse({ id, activityId: id, decisionId: id, kind: 'mark_read', state: 'planned', idempotencyKey: 'interactive-action-key', target: archive.target }).kind).toBe('mark_read');
    expect(plannedActionSchema.parse({ ...archive, kind: 'recoverable_trash' }).kind).toBe('recoverable_trash');
    expect(plannedActionSchema.parse({ ...archive, kind: 'move', target: { ...archive.target, destinationFolderId: otherId } }).kind).toBe('move');
  });

  it.each([undefined, NaN, Infinity, -Infinity, -0.001, 1.001, '0.9'])('rejects invalid confidence %s', (confidence) => {
    expect(agentDecisionSchema.safeParse(decision([{ ...archive, confidence }])).success).toBe(false);
  });

  it.each([0, 0.5999, 0.60, 1])('retains a valid per-action estimate %s without rounding', (confidence) => {
    expect(plannedActionSchema.parse({ ...archive, confidence }).confidence).toBe(confidence);
  });

  it('requires version two even for non-actionable durable decisions', () => {
    for (const variant of [
      { state: 'question', rationale: 'Need direction', question: 'Which folder?' },
      { state: 'no_action', rationale: 'Keep it' },
      { state: 'failed', rationale: 'Unavailable', errorCode: 'MODEL_UNAVAILABLE' },
    ]) {
      expect(agentDecisionSchema.safeParse(variant).success).toBe(false);
      expect(agentDecisionSchema.safeParse({ ...variant, schemaVersion: 1 }).success).toBe(false);
      expect(agentDecisionSchema.parse({ ...variant, schemaVersion: 2 }).state).toBe(variant.state);
    }
    expect(agentDecisionSchema.safeParse({ ...decision([archive]), schemaVersion: 1 }).success).toBe(false);
  });

  it('requires exact kind-specific targets and existing draft versions', () => {
    expect(plannedActionSchema.parse(draft).target).toEqual(archive.target);
    expect(plannedActionSchema.parse({ ...draft, kind: 'draft_edit', target: { accountId: id, draftId: otherId }, expectedVersion: 3 }).kind).toBe('draft_edit');
    for (const invalid of [
      { ...archive, target: { accountId: id } },
      { ...archive, target: { ...archive.target, draftId: otherId } },
      { ...archive, kind: 'move' },
      { ...draft, target: { accountId: id, draftId: otherId } },
      { ...draft, target: { ...archive.target, draftId: otherId } },
      { ...draft, kind: 'draft_edit', target: { accountId: id, draftId: otherId } },
      { ...draft, kind: 'draft_edit', target: { accountId: id, draftId: otherId }, expectedVersion: 0 },
    ]) expect(plannedActionSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts forward dependencies and independent draft plus classification plans', () => {
    const plan = agentDecisionSchema.parse(decision([{ ...archive, dependsOn: ['reply'] }, draft]));
    expect(plan.state).toBe('actionable');
    if (plan.state === 'actionable') expect(plan.actions.map((action) => action.key)).toEqual(['classify', 'reply']);
  });

  it('rejects duplicate keys, missing/self/duplicate dependencies and cycles', () => {
    for (const actions of [
      [archive, { ...draft, key: archive.key }],
      [{ ...archive, dependsOn: ['missing'] }],
      [{ ...archive, dependsOn: ['classify'] }],
      [{ ...archive, dependsOn: ['reply', 'reply'] }, draft],
      [{ ...archive, dependsOn: ['reply'] }, { ...draft, dependsOn: ['classify'] }],
      [{ ...archive, dependsOn: ['reply'] }, { ...draft, dependsOn: ['third'] }, { ...draft, key: 'third', dependsOn: ['classify'] }],
    ]) expect(agentDecisionSchema.safeParse(decision(actions)).success).toBe(false);
  });

  it('bounds keys, evidence, dependencies and plan size', () => {
    for (const key of ['', 'Upper', 'has-hyphen', 'a'.repeat(65)]) expect(plannedActionSchema.safeParse({ ...archive, key }).success).toBe(false);
    expect(plannedActionSchema.parse({ ...archive, key: 'a'.repeat(64) }).key).toHaveLength(64);
    expect(plannedActionSchema.safeParse({ ...archive, reason: '   ' }).success).toBe(false);
    expect(plannedActionSchema.safeParse({ ...archive, reason: 'a'.repeat(2001) }).success).toBe(false);
    expect(plannedActionSchema.safeParse({ ...archive, evidenceIds: Array.from({ length: 21 }, (_, index) => `memory:${String(index)}`) }).success).toBe(false);
    expect(plannedActionSchema.safeParse({ ...archive, dependsOn: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(agentDecisionSchema.safeParse(decision([])).success).toBe(false);
    const actions = Array.from({ length: 5 }, (_, index) => ({ ...draft, key: `reply_${String(index)}` }));
    expect(agentDecisionSchema.parse(decision(actions)).state).toBe('actionable');
    expect(agentDecisionSchema.safeParse(decision([...actions, { ...draft, key: 'sixth' }])).success).toBe(false);
  });

  it('rejects competing classifications for one message but permits another message', () => {
    for (const action of [
      { ...archive, key: 'second' },
      { ...archive, key: 'second', kind: 'recoverable_trash' },
      { ...archive, key: 'second', kind: 'move', target: { ...archive.target, destinationFolderId: otherId } },
    ]) expect(agentDecisionSchema.safeParse(decision([archive, action])).success).toBe(false);
    expect(agentDecisionSchema.parse(decision([archive, { ...archive, key: 'second', target: { accountId: id, messageId: otherId } }])).state).toBe('actionable');
  });

  it('keeps user HTML editable but forbids HTML and invalid recipients in model drafts', () => {
    const html = { ...fields, bodyFormat: 'html', body: '<p>Thanks</p>' };
    expect(draftFieldsSchema.parse(html).body).toBe(html.body);
    expect(ownerActionCorrectionSchema.parse({ kind: 'draft_create', reason: 'My reply', target: archive.target, draft: html }).kind).toBe('draft_create');
    expect(agentDraftFieldsSchema.safeParse(html).success).toBe(false);
    for (const recipients of [
      [],
      [{ kind: 'cc', address: 'owner@example.com' }],
      [{ kind: 'to', address: 'owner@example.com' }, { kind: 'bcc', address: 'OWNER@example.com' }],
    ]) {
      expect(agentDraftFieldsSchema.safeParse({ ...fields, recipients }).success).toBe(false);
      expect(recipientProblem(recipients as typeof fields.recipients)).not.toBeNull();
    }
    expect(recipientProblem(fields.recipients)).toBeNull();
    expect(agentDraftFieldsSchema.parse({ ...fields, body: 'a'.repeat(2_000_000) }).body).toHaveLength(2_000_000);
    expect(draftFieldsSchema.safeParse({ ...fields, body: 'a'.repeat(2_000_001) }).success).toBe(false);
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
