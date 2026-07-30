import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDashboard, AgentRepository, AgentScope } from '../../src/agent/contracts.js';
import { createAgentRoutes } from '../../src/agent/routes.js';
import { AgentService, agentBrowserScenarios } from '../../src/agent/service.js';
import { AgentPanel, AutonomyControls } from '../../src/agent/ui.js';

const scope: AgentScope = { subjectId: 'person-1', accountIds: ['account-1'] };
const action = { id: 'action-1', accountId: 'account-1', version: 1, title: 'Follow up', reason: 'The sender asked for confirmation.', status: 'failed' as const, outcome: 'The delivery attempt failed.', verification: 'No message was sent.', recoverable: true, reversalHref: '/activity/action-1/reversal', questionId: 'question-1' };
const question = { id: 'question-1', accountId: 'account-1', version: 1, prompt: 'Should this wait until tomorrow?', state: 'open' as const };
const dashboard: AgentDashboard = {
  actions: [action],
  questions: [question],
  alerts: [{ id: 'health-1', kind: 'account_health', message: 'Account connection needs attention.', accountId: 'account-1' }, { id: 'poll-1', kind: 'poll_failure', message: 'Polling is retrying; previous results remain visible.', accountId: 'account-1' }, { id: 'pause-1', kind: 'safety_pause', message: 'Safety pause is active.' }],
  autonomy: { global: { state: 'running', version: 100 }, accounts: { 'account-1': { state: 'paused', version: 101 } } },
};

function repository(overrides: Partial<AgentRepository> = {}): AgentRepository {
  return {
    dashboard: () => Promise.resolve(dashboard),
    answerQuestion: () => Promise.resolve({ kind: 'duplicate' as const, question }),
    retryAction: () => Promise.resolve({ kind: 'queued' as const, action }),
    setAutonomy: (_scope, _target, state) => Promise.resolve({ kind: 'updated' as const, state }),
    ...overrides,
  };
}

describe('agent framework-neutral API', () => {
  it('rejects unauthenticated, cross-origin, and unsupported-version requests before the service', async () => {
    const routes = createAgentRoutes(new AgentService(repository()), { expectedOrigin: 'https://mail.example', apiVersion: '5' });
    const request = { method: 'GET', auth: scope, origin: 'https://mail.example', apiVersion: '5', body: {} };
    expect((await routes.dashboard({ ...request, auth: null })).status).toBe(401);
    expect((await routes.dashboard({ ...request, origin: 'https://evil.example' })).status).toBe(403);
    expect((await routes.dashboard({ ...request, apiVersion: '4' })).status).toBe(426);
  });

  it('returns a duplicate answer as a successful idempotent outcome', async () => {
    const result = await new AgentService(repository()).answer(scope, 'question-1', 'Tomorrow', 1, 'stable-key');
    expect(result.kind).toBe('duplicate');
  });

  it('blocks retry while its linked question is open', async () => {
    const retryAction = vi.fn();
    await expect(new AgentService(repository({ retryAction })).retry(scope, 'action-1', 1)).rejects.toThrow('Answer the open question');
    expect(retryAction).not.toHaveBeenCalled();
  });

  it('passes the expected autonomy version through the route and service', async () => {
    const setAutonomy = vi.fn((_scope: AgentScope, _target: unknown, state: 'paused' | 'running', expectedVersion: number) => Promise.resolve({ kind: 'updated' as const, state, expectedVersion }));
    const routes = createAgentRoutes(new AgentService(repository({ setAutonomy })), { expectedOrigin: 'https://mail.example', apiVersion: '5' });
    const response = await routes.autonomy({ method: 'POST', auth: scope, origin: 'https://mail.example', apiVersion: '5', body: { scope: 'global', state: 'paused', expectedVersion: 100 } });
    expect(response).toMatchObject({ status: 200, body: { state: 'paused' } });
    expect(setAutonomy).toHaveBeenCalledWith(scope, { kind: 'global' }, 'paused', 100);
  });

  it('pauses and resumes global and authorized account autonomy', async () => {
    const setAutonomy = vi.fn((_scope: AgentScope, _target: unknown, state: 'paused' | 'running') => Promise.resolve({ kind: 'updated' as const, state }));
    const service = new AgentService(repository({ setAutonomy }));
    await expect(service.setAutonomy(scope, { kind: 'global' }, 'paused', 1)).resolves.toBe('paused');
    await expect(service.setAutonomy(scope, { kind: 'account', accountId: 'account-1' }, 'running', 1)).resolves.toBe('running');
    await expect(service.setAutonomy(scope, { kind: 'account', accountId: 'other' }, 'paused', 1)).rejects.toThrow('not found');
  });
});

describe('agent SSR UI contracts', () => {
  const markup = renderToStaticMarkup(React.createElement(AgentPanel, { dashboard, idempotencyKey: 'stable-key' }));
  const css = readFileSync(resolve(import.meta.dirname, '../../src/agent/agent.css'), 'utf8');

  it('passes the dashboard version for the selected autonomy scope', () => {
    const onAutonomy = vi.fn();
    const controls = AutonomyControls({ dashboard, handlers: { onAutonomy } });
    const children = controls.props.children as unknown as React.ReactNode;
    const rows = React.Children.toArray(children).filter((child): child is React.ReactElement => React.isValidElement(child) && child.type === 'div') as unknown as Array<{ props: { children: readonly unknown[] } }>;
    const globalButton = rows[0]?.props.children[1] as { props: { onClick: () => void } };
    const accountButton = rows[1]?.props.children[1] as { props: { onClick: () => void } };
    globalButton.props.onClick();
    accountButton.props.onClick();
    expect(onAutonomy).toHaveBeenNthCalledWith(1, { kind: 'global' }, 'paused', 100);
    expect(onAutonomy).toHaveBeenNthCalledWith(2, { kind: 'account', accountId: 'account-1' }, 'running', 101);
  });

  it('uses accessible, written safety states and an answer-and-resume question sheet', () => {
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Safety pause is active.');
    expect(markup).toContain('Account connection needs attention.');
    expect(markup).toContain('data-polling="continues"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Answer and resume');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Memory is active');
  });

  it('does not expose opaque-memory management controls', () => {
    expect(markup).not.toMatch(/(inspect|correct|reset) memory/i);
    expect(markup).not.toContain('Memory summary');
  });

  it('only renders a reversal link for an explicitly recoverable action', () => {
    expect(markup).toContain('href="/activity/action-1/reversal"');
    const irreversible = { ...dashboard, actions: [{ id: action.id, accountId: action.accountId, version: action.version, title: action.title, reason: action.reason, status: action.status, outcome: action.outcome, verification: action.verification, recoverable: false, questionId: action.questionId }] };
    expect(renderToStaticMarkup(React.createElement(AgentPanel, { dashboard: irreversible, idempotencyKey: 'key' }))).not.toContain('Review reversal');
  });

  it('keeps 360px, touch, focus, and reduced-motion contracts in agent-owned CSS', () => {
    for (const token of ['max-width:100%', 'min-height:44px', '@media (max-width:360px)', ':focus-visible', 'prefers-reduced-motion:reduce']) expect(css).toContain(token);
  });

  it('documents browser-ready interaction scenarios without claiming a browser host ran', () => {
    expect(agentBrowserScenarios).toHaveLength(4);
    expect(agentBrowserScenarios.join(' ')).toContain('360px');
  });
});
