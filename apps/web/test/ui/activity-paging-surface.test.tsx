// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { ActivityScreen } from '../../src/activity/surfaces.js';
import { HypermailShell, type ShellData } from '../../src/ui/index.js';
import type { ActivityFilter, ActivityPage, ActivityRecord } from '../../src/activity/contracts.js';

const rows: ActivityRecord[] = Array.from({ length: 26 }, (_, index) => ({ id: `activity-${String(index + 1)}`, accountId: 'mailbox-1', accountLabel: 'Personal', messageId: null, messageLabel: 'Message', title: `Work item ${String(index + 1)}`, state: 'new', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', timeline: [] }));
const page: ActivityPage = { items: rows.slice(0, 25), nextCursor: 'opaque-next-page', counts: { new: 26, questions: 0, failed: 0, history: 0 } };
const emptyPage: ActivityPage = { ...page, items: [], nextCursor: null };
const data: ShellData = { accounts: [], messages: [], activity: page };

afterEach(() => { cleanup(); history.replaceState({}, '', '/'); });

it('keeps loaded rows available during paging and prevents repeated paging until completion', async () => {
  const user = userEvent.setup();
  let finish: (() => void) | undefined;
  function Host(): React.JSX.Element {
    const [current, setCurrent] = React.useState(page);
    const [pending, setPending] = React.useState(false);
    const [selected, setSelected] = React.useState<ActivityRecord>();
    return selected ? <h1>{selected.title} detail</h1> : <ActivityScreen page={current} loadingMore={pending} onOpen={setSelected} onLoadMore={() => {
      setPending(true);
      finish = () => { setCurrent({ ...page, items: rows, nextCursor: null }); setPending(false); };
    }} />;
  }
  render(<Host />);
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  const loadingButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Loading…' });
  expect(loadingButton.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Open: Work item 25' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open: Work item 26' })).toBeNull();
  act(() => { finish?.(); });
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Open: Work item 26' }));
  expect(screen.getByRole('heading', { name: 'Work item 26 detail' })).toBeTruthy();
});

it('retries a failed additional page without restarting or losing the first page', async () => {
  const user = userEvent.setup();
  function Host(): React.JSX.Element {
    const [current, setCurrent] = React.useState<ShellData>({ ...data, activityState: 'error', activityError: 'Next page unavailable.' });
    return <HypermailShell data={current} initialScreen="activity" onActivityFilter={() => {
      // A mistaken first-page retry would remove the visible page instead of appending.
      setCurrent({ ...data, activity: emptyPage });
      return Promise.resolve();
    }} onActivityLoadMore={() => { setCurrent({ ...data, activity: { ...page, items: rows, nextCursor: null }, activityState: 'ready' }); }} />;
  }
  render(<Host />);
  expect(screen.getByText('Next page unavailable.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open: Work item 25' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: 'Open: Work item 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open: Work item 26' })).toBeTruthy();
  expect(screen.queryByText('Next page unavailable.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('keeps filter selection usable after an initial failure and retries the selected filter', async () => {
  const user = userEvent.setup();
  function Host(): React.JSX.Element {
    const [current, setCurrent] = React.useState<ShellData>({ ...data, activity: emptyPage, activityState: 'error', activityError: 'Activity unavailable.' });
    const [failedOnce, setFailedOnce] = React.useState(false);
    const load = (filter: ActivityFilter): Promise<void> => {
      if (!failedOnce) { setFailedOnce(true); setCurrent({ ...data, activity: emptyPage, activityState: 'error', activityError: 'Selected filter unavailable.' }); return Promise.resolve(); }
      const first = rows[0];
      if (!first) throw new Error('activity fixture must include a first record');
      setCurrent({ ...data, activity: { ...emptyPage, items: [{ ...first, title: `${filter} result`, state: 'failed' }] }, activityState: 'ready' });
      return Promise.resolve();
    };
    return <HypermailShell data={current} initialScreen="activity" onActivityFilter={load} />;
  }
  render(<Host />);
  expect(screen.queryByText('No new activity.')).toBeNull();
  await user.click(within(screen.getByRole('group', { name: 'Activity filters' })).getByRole('button', { name: /^Failed/ }));
  expect(screen.getByText('Selected filter unavailable.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: 'Open: failed result' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});
