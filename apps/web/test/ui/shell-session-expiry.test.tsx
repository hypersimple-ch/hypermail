// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Compose } from '../../src/ui/index.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';
import { SessionExpiredError } from '../../src/lib/authenticated-fetch.js';
import { ToastProvider, toast } from '../../src/components/heroui/toast.js';

afterEach(() => { toast.clear(); cleanup(); });

it.each([true, false])('keeps compose input and releases saving after expiry=%s without misreporting expired authentication', async expired => {
  const user = userEvent.setup();
  let rejectSave!: (error: Error) => void;
  const save = new Promise<DraftRecord>((_resolve, reject) => { rejectSave = reject; });
  render(<><Compose accounts={[{ id: 'personal', label: 'Personal', address: 'owner@example.test' }]} onSave={() => save} /><ToastProvider /></>);
  await user.click(screen.getByRole('button', { name: /From account/ }));
  await user.click(screen.getByRole('option', { name: 'Personal' }));
  await user.type(screen.getByLabelText('To'), 'recipient@example.test');
  await user.type(screen.getByLabelText('Subject'), 'Unsaved subject');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true);
  await act(() => { rejectSave(expired ? new SessionExpiredError() : new Error('Provider unavailable')); return save.catch(() => undefined); });
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' }).disabled).toBe(false); });
  expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe('recipient@example.test');
  expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('Unsaved subject');
  if (expired) expect(screen.queryByText('Could not save draft. Your input has been kept.')).toBeNull();
  else expect(await screen.findByText('Could not save draft. Your input has been kept.')).toBeTruthy();
});
