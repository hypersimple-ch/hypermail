import * as React from 'react';
import type { AgentAction, AgentAlert, AgentDashboard, AgentQuestion, AutonomyScope, AutonomyState } from './contracts.js';

export type AgentUiHandlers = Readonly<{
  onAnswer?: (input: Readonly<{ questionId: string; answer: string; expectedVersion: number; idempotencyKey: string }>) => void;
  onRetry?: (action: AgentAction) => void;
  onAutonomy?: (target: AutonomyScope, state: AutonomyState, expectedVersion: number) => void;
}>;
const h = React.createElement;

export function AgentAlerts({ alerts }: Readonly<{ alerts: readonly AgentAlert[] }>) {
  return h('section', { className: 'hm-agent-alerts', 'aria-label': 'Agent safety and account status', 'data-polling': 'continues' },
    alerts.map((alert) => h('div', { className: 'hm-agent-alert', role: 'alert', key: alert.id },
      h('strong', null, `${alert.kind.replaceAll('_', ' ')}:`), ' ', alert.message,
    )),
  );
}

export function AgentActionCard({ action, onRetry }: Readonly<{ action: AgentAction; onRetry?: (action: AgentAction) => void }>) {
  const canRetry = action.status === 'failed' || action.status === 'blocked';
  return h('article', { className: 'hm-agent-action', 'aria-label': `Agent action: ${action.title}` },
    h('h3', null, action.title),
    h('p', null, h('strong', null, 'Why: '), action.reason),
    h('p', null, h('strong', null, 'Outcome: '), action.outcome ?? 'Waiting for an outcome.'),
    h('p', null, h('strong', null, 'Verification: '), action.verification ?? 'Verification pending.'),
    h('p', { className: 'hm-agent-status' }, `Status: ${action.status}`),
    canRetry ? h('button', { type: 'button', onClick: () => onRetry?.(action), 'aria-label': `Retry ${action.title}` }, 'Retry') : null,
    action.recoverable && action.reversalHref ? h('a', { href: action.reversalHref, className: 'hm-agent-reversal' }, 'Review reversal') : null,
  );
}

export function AgentQuestionSheet({ question, idempotencyKey, pending = false, onAnswer }: Readonly<{
  question: AgentQuestion;
  idempotencyKey: string;
  pending?: boolean;
  onAnswer?: AgentUiHandlers['onAnswer'];
}>) {
  const inputId = `agent-answer-${question.id}`;
  return h('section', { className: 'hm-agent-question-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${inputId}-title` },
    h('h2', { id: `${inputId}-title` }, 'Agent needs your answer'),
    h('p', null, question.prompt),
    h('form', { onSubmit: (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget as unknown as { elements: { namedItem(name: string): { value: string } | null } }; const field = form.elements.namedItem('answer'); onAnswer?.({ questionId: question.id, answer: field?.value ?? '', expectedVersion: question.version, idempotencyKey }); } },
      h('label', { htmlFor: inputId }, 'Your answer'),
      h('textarea', { id: inputId, name: 'answer', required: true, rows: 3, disabled: pending }),
      h('p', { className: 'hm-agent-help' }, 'Submitting records your answer and resumes this work once. Repeating a submission is safe.'),
      h('button', { type: 'submit', disabled: pending }, pending ? 'Recording answer…' : 'Answer and resume'),
    ),
  );
}

export function AutonomyControls({ dashboard, handlers = {} }: Readonly<{ dashboard: AgentDashboard; handlers?: AgentUiHandlers }>) {
  const control = (label: string, target: AutonomyScope, status: AgentDashboard['autonomy']['global']) => {
    const next: AutonomyState = status.state === 'paused' ? 'running' : 'paused';
    return h('div', { className: 'hm-agent-autonomy-row', key: label },
      h('span', null, `${label}: ${status.state === 'paused' ? 'Paused' : 'Active'}`),
      h('button', { type: 'button', onClick: () => handlers.onAutonomy?.(target, next, status.version), 'aria-pressed': status.state === 'paused' }, next === 'paused' ? 'Pause' : 'Resume'),
    );
  };
  return h('section', { className: 'hm-agent-autonomy', 'aria-label': 'Agent autonomy controls' },
    h('h2', null, 'Autonomy'),
    control('All accounts', { kind: 'global' }, dashboard.autonomy.global),
    Object.entries(dashboard.autonomy.accounts).map(([accountId, state]) => control(`Account ${accountId}`, { kind: 'account', accountId }, state)),
  );
}

/** SSR-safe: no browser globals, effects, storage, or opaque-memory data are accessed. */
export function AgentPanel({ dashboard, idempotencyKey, handlers = {} }: Readonly<{ dashboard: AgentDashboard; idempotencyKey: string; handlers?: AgentUiHandlers }>) {
  const openQuestion = dashboard.questions.find((question) => question.state === 'open');
  return h('aside', { className: 'hm-agent-panel', 'aria-label': 'Agent' },
    h(AgentAlerts, { alerts: dashboard.alerts }),
    h('p', { className: 'hm-agent-memory-note' }, 'Memory is active to help the agent, but it is not inspectable in milestone one.'),
    h(AutonomyControls, { dashboard, handlers }),
    h('section', { 'aria-label': 'Agent actions' }, h('h2', null, 'Agent actions'), dashboard.actions.map((action) => h(AgentActionCard, { key: action.id, action, ...(handlers.onRetry === undefined ? {} : { onRetry: handlers.onRetry }) }))),
    openQuestion ? h(AgentQuestionSheet, { question: openQuestion, idempotencyKey, ...(handlers.onAnswer === undefined ? {} : { onAnswer: handlers.onAnswer }) }) : null,
    h('p', { className: 'hm-agent-live', 'aria-live': 'polite' }, 'Agent status updates while polling continues.'),
  );
}
