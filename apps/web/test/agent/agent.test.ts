// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDashboard, AgentRepository, AgentScope } from '../../src/agent/contracts.js';
import { createAgentRoutes } from '../../src/agent/routes.js';
import { AgentService, agentBrowserScenarios } from '../../src/agent/service.js';
import { AgentPanel, AutonomyControls } from '../../src/agent/ui.js';

afterEach(cleanup);

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
  it('allows origin-less dashboard reads but rejects unauthenticated, cross-origin mutation, and unsupported-version requests', async () => {
    const routes = createAgentRoutes(new AgentService(repository()), { expectedOrigin: 'https://mail.example', apiVersion: '5' });
    const request = { method: 'GET', auth: scope, origin: 'https://mail.example', apiVersion: '5', body: {} };
    expect((await routes.dashboard({ ...request, auth: null })).status).toBe(401);
    expect((await routes.dashboard({ ...request, origin: null })).status).toBe(200);
    await expect(new AgentService(repository()).dashboard({ subjectId: 'person-1', accountIds: [] })).resolves.toEqual({ actions: [], questions: [], alerts: [], autonomy: { global: { state: 'running', version: 1 }, accounts: {} } });
    expect((await routes.answer({ ...request, method: 'POST', origin: 'https://evil.example' }, 'question-1')).status).toBe(403);
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

  it('passes the dashboard version for the selected autonomy scope', () => {
    const onAutonomy = vi.fn();
    render(React.createElement(AutonomyControls, { dashboard, handlers: { onAutonomy } }));
    const [globalButton, accountButton] = screen.getAllByRole('button', { name: /Pause|Resume/ });
    if (!globalButton || !accountButton) throw new Error('Expected global and account autonomy controls.');
    fireEvent.click(globalButton);
    fireEvent.click(accountButton);
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

  it('uses shared focus-safe 44px button variants for both pause and resume controls', () => {
    const controls = renderToStaticMarkup(React.createElement(AutonomyControls, { dashboard }));
    expect(controls).toContain('data-size="sm"');
    expect(controls).toContain('focus-visible:ring-2');
    expect(controls).toContain('>Pause</button>');
    expect(controls).toContain('>Resume</button>');
  });

  it('documents browser-ready interaction scenarios without claiming a browser host ran', () => {
    expect(agentBrowserScenarios).toHaveLength(4);
    expect(agentBrowserScenarios.join(' ')).toContain('360px');
  });
});
