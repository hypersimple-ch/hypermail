// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account, type AccountProps } from '../../src/ui/account.js';

afterEach(cleanup);

const changePassword = vi.fn<AccountProps['onChangePassword']>();
const signOut = vi.fn<AccountProps['onSignOut']>();

function renderAccount(overrides: Partial<AccountProps> = {}) {
  return render(<Account ownerEmail="owner@example.test" onChangePassword={changePassword} onSignOut={signOut} onBack={vi.fn()} {...overrides} />);
}

function fillPasswords(currentPassword: string, newPassword: string, confirmation = newPassword) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: currentPassword } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: newPassword } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirmation } });
}

afterEach(() => {
  changePassword.mockReset();
  signOut.mockReset();
});

describe('Account', () => {
  it('shows the authenticated owner email as read-only identity', () => {
    renderAccount();
    const email = screen.getByLabelText('Email');
    expect(email.value).toBe('owner@example.test');
    expect(email.readOnly).toBe(true);
    expect(screen.getByText('Owner identity')).toBeTruthy();
  });

  it('rejects short and non-matching new passwords without invoking the handler', () => {
    renderAccount();
    fillPasswords('current-password', 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Your new password must be at least 12 characters.')).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();

    fillPasswords('current-password', 'a-valid-password', 'different-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('New password and confirmation must match.')).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('sends only the current and new passwords', async () => {
    changePassword.mockResolvedValue({ ok: true });
    renderAccount();
    fillPasswords('current-password', 'a-valid-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => { expect(changePassword).toHaveBeenCalledWith({ currentPassword: 'current-password', newPassword: 'a-valid-password' }); });
    expect(changePassword.mock.calls[0]?.[0]).not.toHaveProperty('confirmation');
  });

  it('disables account actions while a password change is pending', () => {
    let finish: ((result: { ok: true }) => void) | undefined;
    changePassword.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderAccount();
    fillPasswords('current-password', 'a-valid-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(screen.getByRole('button', { name: 'Changing password…' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Sign out' }).disabled).toBe(true);
    expect(screen.getByLabelText('Current password').hasAttribute('disabled')).toBe(true);
    if (finish) finish({ ok: true });
  });

  it('clears all password fields and announces success after a successful change', async () => {
    changePassword.mockResolvedValue({ ok: true });
    renderAccount();
    fillPasswords('current-password', 'a-valid-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Password changed.'); });
    expect(screen.getByLabelText('Current password').value).toBe('');
    expect(screen.getByLabelText('New password').value).toBe('');
    expect(screen.getByLabelText('Confirm new password').value).toBe('');
  });

  it('announces a bounded password handler error', async () => {
    changePassword.mockResolvedValue({ ok: false, error: 'Current password is incorrect.' });
    renderAccount();
    fillPasswords('wrong-password', 'a-valid-password');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Current password is incorrect.')).toBeTruthy();
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  it('invokes sign out and disables it while pending', async () => {
    let finish: (() => void) | undefined;
    signOut.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Signing out…' }).disabled).toBe(true);
    if (finish) finish();
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Signed out.'); });
  });
});
