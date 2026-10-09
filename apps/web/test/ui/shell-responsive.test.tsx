// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HypermailShell } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';

const draft: DraftRecord = { id: 'd1', accountId: 'personal', sourceMessageId: null, createdBy: 'user', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: 'Saved body', bodyFormat: 'markdown', state: 'editing', createdAt: '', updatedAt: '', version: 4 };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

describe('single responsive shell', () => {
  it('preserves one selected draft and its unsaved edits across the 700px breakpoint', async () => {
    const user = userEvent.setup();
    const saved: DraftRecord[] = [];
    const onUpdateDraft = (record: DraftRecord) => { saved.push(record); return Promise.resolve(); };
    vi.stubGlobal('innerWidth', 390);
    const view = render(<HypermailShell data={mockShellData} initialScreen="drafts" drafts={[draft]} onUpdateDraft={onUpdateDraft} />);
    await user.click(screen.getByRole('button', { name: 'Open draft Follow up' }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Message (markdown)');
    await user.clear(editor);
    await user.type(editor, 'Unsaved body through resizing');
    await user.clear(screen.getByLabelText('Subject'));
    await user.type(screen.getByLabelText('Subject'), 'Edited subject');
    for (const width of [1000, 390]) {
      act(() => { vi.stubGlobal('innerWidth', width); window.dispatchEvent(new Event('resize')); });
      view.rerender(<HypermailShell data={mockShellData} initialScreen="drafts" drafts={[draft]} onUpdateDraft={onUpdateDraft} />);
      expect(screen.getByLabelText('Message (markdown)')).toBe(editor);
      expect(editor.value).toBe('Unsaved body through resizing');
      expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('Edited subject');
      expect(screen.getByText('Version 4 · User-created draft')).toBeTruthy();
    }
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => { expect(saved).toEqual([{ ...draft, subject: 'Edited subject', body: 'Unsaved body through resizing' }]); });
  });

  it.each([false, true])('opens Sent directly on mobile with sent records present=%s', async (hasSent) => {
    const user = userEvent.setup();
    vi.stubGlobal('innerWidth', 390);
    const records: DraftRecord[] = hasSent ? [draft, { ...draft, id: 'sent1', state: 'sent', subject: 'Delivered report' }] : [draft];
    render(<HypermailShell data={mockShellData} drafts={records} />);
    const mobile = within(screen.getByRole('navigation', { name: 'Mobile primary' }));
    await user.click(mobile.getByRole('button', { name: 'Sent' }));
    expect(screen.getByRole('heading', { name: 'Sent' })).toBeTruthy();
    if (hasSent) expect(screen.getByText('Delivered report')).toBeTruthy();
    else expect(screen.getByText('No sent messages.')).toBeTruthy();
    expect(screen.queryByText('Follow up')).toBeNull();
    expect(mobile.getByRole('button', { name: 'Sent' }).getAttribute('aria-current')).toBe('page');
    await user.click(mobile.getByRole('button', { name: 'Drafts' }));
    expect(screen.getByRole('button', { name: 'Open draft Follow up' })).toBeTruthy();
  });
});
