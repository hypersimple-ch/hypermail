import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  acknowledgementBlockReason, ActivityBlockedError, ActivityConflictError, ActivityService, createActivityRoutes,
  InMemoryActivityRepository, type ActivityRecord, ActivityDetail, ActivityScreen, activitySurfaceCss,
} from '../../src/activity/index.js';

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

describe('Activity SSR, accessibility, and responsive behavioral contracts', () => {
  it('renders all filters, count badges, text statuses, question/failure/retry/acknowledgement controls', () => {
    const page = { items: [seed[1], seed[2], seed[3]], nextCursor: null, counts: { new: 2, questions: 1, failed: 1, history: 1 } };
    const list = renderToStaticMarkup(React.createElement(ActivityScreen, { page, filter: 'questions' }));
    for (const text of ['New', 'Questions', 'Failed', 'History', 'Needs input', 'Failed', 'Retry']) expect(list).toContain(text);
    expect(list).toContain('aria-pressed="true"');
    const detail = renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[1] }));
    expect(detail).toContain('Question needs your input');
    expect(detail).toContain('Answer the open question before acknowledging.');
    expect(detail).toContain('disabled=""');
  });

  it('is SSR-safe and ships a browser-ready responsive contract without claiming a browser run', () => {
    expect(() => renderToStaticMarkup(React.createElement(ActivityDetail, { activity: seed[2] }))).not.toThrow();
    expect(activitySurfaceCss).toContain('min-width:0');
    expect(activitySurfaceCss).toContain('@media (min-width:700px)');
    expect(activitySurfaceCss).toContain('min-height:44px');
  });
});
