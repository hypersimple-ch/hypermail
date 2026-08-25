// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgementBlockReason, ActivityBlockedError, ActivityConflictError, ActivityService, createActivityRoutes,
  InMemoryActivityRepository, type ActivityRecord, ActivityDetail, ActivityScreen, relativeTime,
} from '../../src/activity/index.js';

afterEach(cleanup);

describe('relative activity timestamps', () => {
  const now = new Date('2026-01-15T12:00:00Z');
  it('renders coarse human intervals and keeps invalid input as-is', () => {
    expect(relativeTime('2026-01-15T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-01-15T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-01-15T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-01-13T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('2020-01-15T12:00:00Z', now)).toContain('2020');
    expect(relativeTime('not-a-date', now)).toBe('not-a-date');
  });
  it('renders relative time instead of raw ISO timestamps in the list', () => {
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    const page = { items: [{ ...(record('a1', 'new')), title: 'Subject', messageLabel: 'Sender', accountLabel: 'Personal', updatedAt: recent }], nextCursor: null, counts: { new: 1, questions: 0, failed: 0, history: 0 } };
    const markup = renderToStaticMarkup(React.createElement(ActivityScreen, { page }));
    expect(markup).toContain('30m ago');
    expect(markup).not.toContain(`${recent}</time>`);
  });
});

const scope = { subjectId: 'person-1', accountIds: ['account-a'] } as const;
const record = (id: string, state: ActivityRecord['state'], version = 1): ActivityRecord => ({
  id, accountId: 'account-a', messageId: `message-${id}`, state, version,
  createdAt: `2025-01-0${id.slice(-1)}T00:00:00.000Z`, updatedAt: `2025-01-0${id.slice(-1)}T01:00:00.000Z`,
  title: `Activity ${id}`, accountLabel: 'Personal', messageLabel: `Message ${id}`,
  timeline: [{ id: `${id}-created`, at: '2025-01-01T00:00:00.000Z', label: 'Created' }],
});

const seed = [
  record('item-1', 'new'),
  { ...record('item-2', 'waiting_question'), question: { state: 'open' as const, prompt: 'Which folder?' } },
  { ...record('item-3', 'failed'), failure: { code: 'SYNC', message: 'Connection failed', retrying: false } },
  record('item-4', 'handled'),
  record('item-5', 'acknowledged'),
  { ...record('item-6', 'new'), accountId: 'account-b', accountLabel: 'Work' },
] as const;

describe('Activity API and service contracts', () => {
  it('scopes accounts, has stable cursor pagination, bounded search, and count badges', async () => {
    const service = new ActivityService(new InMemoryActivityRepository(seed));
    const first = await service.list(scope, { filter: 'new', limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(['item-4']);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.list(scope, { filter: 'new', limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.id)).toEqual(['item-1']);
    expect(first.counts).toEqual({ new: 2, questions: 1, failed: 1, history: 1 });
    await expect(service.list(scope, { search: 'x'.repeat(121) })).rejects.toThrow('limited');
    await expect(service.list(scope, { accountId: 'account-b' })).rejects.toThrow('not found');
    await expect(service.list({ subjectId: 'person-1', accountIds: [] })).resolves.toEqual({ items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } });
  });

  it('keeps handled work New until version-safe manual acknowledgement and leaves it searchable in History', async () => {
    const service = new ActivityService(new InMemoryActivityRepository(seed));
    expect((await service.list(scope, { filter: 'new' })).items.map((item) => item.id)).toContain('item-4');
    const acknowledged = await service.acknowledge(scope, 'item-4', 1);
    expect(acknowledged).toMatchObject({ state: 'acknowledged', version: 2 });
    expect((await service.list(scope, { filter: 'history', search: 'Activity item-4' })).items.map((item) => item.id)).toEqual(['item-4']);
    await expect(service.acknowledge(scope, 'item-4', 1)).rejects.toBeInstanceOf(ActivityBlockedError);
  });

  it('blocks acknowledgement for questions, failures and retries, and supports retry only with the current version', async () => {
    const service = new ActivityService(new InMemoryActivityRepository(seed));
    for (const id of ['item-2', 'item-3', 'item-1']) await expect(service.acknowledge(scope, id, 1)).rejects.toBeInstanceOf(ActivityBlockedError);
    expect(acknowledgementBlockReason({ ...seed[2], failure: { code: 'SYNC', message: 'Connection failed', retrying: true } })).toContain('retrying');
    await expect(service.retry(scope, 'item-3', 2)).rejects.toBeInstanceOf(ActivityConflictError);
    expect(await service.retry(scope, 'item-3', 1)).toMatchObject({ state: 'new', version: 2, jobState: 'pending' });
  });

  it('requires an authenticated scope at the API boundary and does not reveal unscoped detail', async () => {
    const routes = createActivityRoutes(new ActivityService(new InMemoryActivityRepository(seed)));
    expect((await routes.list({ method: 'GET', auth: null, query: {}, body: {} })).status).toBe(401);
    expect((await routes.detail({ method: 'GET', auth: scope, query: {}, body: {} }, 'item-6')).status).toBe(404);
    expect((await routes.acknowledge({ method: 'POST', auth: scope, query: {}, body: { expectedVersion: 1 } }, 'item-4')).status).toBe(200);
  });
});

describe('Activity component accessibility and interaction contracts', () => {
  it('renders all filters, count badges, text statuses, and honest detail links', () => {
    const page = { items: [seed[1], seed[2], seed[3]], nextCursor: null, counts: { new: 2, questions: 1, failed: 1, history: 1 } };
    const list = renderToStaticMarkup(React.createElement(ActivityScreen, { page, filter: 'questions' }));
    for (const text of ['New', 'Questions', 'Failed', 'History', 'Needs input', 'Failed', 'Open']) expect(list).toContain(text);
    expect(list).toContain('aria-pressed="true"');
    const detail = renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[1] }));
    expect(detail).toContain('Question needs your input');
    expect(detail).toContain('Answer the open question before acknowledging.');
    expect(detail).toContain('disabled=""');
    expect(renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[2] }))).toContain('>Retry</button>');
    expect(renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[3] }))).toContain('>Acknowledge</button>');
  });

  it('disables Activity mutations while a request is pending', () => {
    const retrying = renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[2], pendingAction: 'retry' }));
    expect(retrying).toContain('Retrying…');
    expect(retrying).toContain('disabled=""');
    const acknowledging = renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[3], pendingAction: 'acknowledge' }));
    expect(acknowledging).toContain('Acknowledging…');
    expect(acknowledging).toContain('disabled=""');
  });

  it('keeps the Activity back action inside the detail page contract', () => {
    const onBack = vi.fn();
    render(React.createElement(ActivityDetail, { activity: seed[2], onBack }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('associates question errors with the shared answer field', async () => {
    const onAnswerQuestion = vi.fn(() => Promise.reject(new Error('offline')));
    render(React.createElement(ActivityDetail, { activity: seed[1], onAnswerQuestion }));
    const answer = screen.getByRole('textbox', { name: 'Your answer' });
    expect(answer.getAttribute('data-slot')).toBe('textarea');
    fireEvent.change(answer, { target: { value: 'Use the archive folder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer and continue' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Could not record the answer');
    expect(answer.getAttribute('aria-invalid')).toBe('true');
    expect(answer.getAttribute('aria-describedby')).toBe(error.id);
    expect((answer as HTMLTextAreaElement).value).toBe('Use the archive folder');
  });

  it('is SSR-safe and delegates filter changes through the shared filter component', () => {
    expect(() => renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[2] }))).not.toThrow();
    const onFilterChange = vi.fn();
    render(React.createElement(ActivityScreen, { page: { items: [], nextCursor: null, counts: { new: 0, questions: 0, failed: 0, history: 0 } }, onFilterChange }));
    fireEvent.click(screen.getByRole('button', { name: /Failed/ }));
    expect(onFilterChange).toHaveBeenCalledWith('failed');
  });
});
