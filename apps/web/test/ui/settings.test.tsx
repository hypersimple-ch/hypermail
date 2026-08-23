// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings, type MailboxConnectionResult, type SettingsMailbox, type StartMailboxConnectionInput } from '../../src/ui/settings.js';
import { ToastProvider, toast } from '../../src/components/heroui/toast.js';

const mailboxes: readonly SettingsMailbox[] = [
  { id: 'gmail', provider: 'gmail', email: 'me@gmail.test', displayName: 'Personal', state: 'ready' },
  { id: 'outlook', provider: 'microsoft', email: 'work@outlook.test', displayName: null, state: 'degraded' },
];
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });

const pendingOutlook = { provider: 'microsoft' as const, handle: 'opaque-handle', authorizationUrl: 'https://microsoft.example/verify', userCode: 'ABCD-EFGH', expiresAt: 'in 10 minutes' };

function openAddMailbox() { fireEvent.click(screen.getByRole('button', { name: 'Add mailbox' })); }

function render(node: React.ReactElement) { return testingRender(<>{node}<ToastProvider /></>); }


afterEach(() => { toast.clear(); cleanup(); });

describe('Settings', () => {
  it('renders an empty mailbox state and a back path', () => {
    const onBack = vi.fn();
    render(<Settings mailboxes={[]} onBack={onBack} />);
    expect(screen.getByText('No mailboxes connected.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('lists projected mailboxes with written ready and degraded states', () => {
    render(<Settings mailboxes={mailboxes} />);
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.getByText('Gmail · me@gmail.test')).toBeTruthy();
    expect(screen.getByText('Outlook · work@outlook.test')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('shows provider-specific Gmail and Outlook starts plus their pending instructions', async () => {
    const onStartConnection = vi.fn().mockResolvedValue({ state: 'pending', pending: { provider: 'gmail', handle: 'gmail-handle', authorizationUrl: 'https://google.example/auth' } });
    render(<Settings mailboxes={[]} onStartConnection={onStartConnection} onCompleteConnection={vi.fn().mockResolvedValue({ state: 'pending', pending: { provider: 'gmail', handle: 'gmail-handle' } })} />);
    openAddMailbox();
    expect(screen.getByRole('button', { name: 'Continue with Gmail' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Gmail' }));
    await waitFor(() => { expect(screen.getByRole('link', { name: /Open Google sign-in/ }).getAttribute('href')).toBe('https://google.example/auth'); });
    expect(screen.getByRole('link', { name: /Open Google sign-in/ }).getAttribute('target')).toBeNull();
    expect(screen.getByText(/redirected automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've returned" })).toBeNull();

    cleanup();
    render(<Settings mailboxes={[]} pendingConnection={pendingOutlook} onCompleteConnection={vi.fn().mockResolvedValue({ state: 'pending', pending: pendingOutlook })} />);
    expect(screen.getByText('Enter this code at the Microsoft verification page:')).toBeTruthy();
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open Microsoft verification/ }).getAttribute('href')).toBe('https://microsoft.example/verify');
    expect(screen.getByRole('link', { name: /Open Microsoft verification/ }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeTruthy();
  });

  it('submits validated IMAP input without retaining a password after the request', async () => {
    const resolve = vi.fn<(input: StartMailboxConnectionInput) => Promise<MailboxConnectionResult>>().mockResolvedValue({ state: 'ready' });
    render(<Settings mailboxes={[]} onStartConnection={resolve} />);
    openAddMailbox();
    fireEvent.click(screen.getByRole('button', { name: /Provider/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'IMAP' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect IMAP' }));
    expect(screen.getByText('Enter the required IMAP details and a valid port.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Mailbox email'), { target: { value: 'mail@example.test' } });
    fireEvent.change(screen.getByLabelText('IMAP host'), { target: { value: 'imap.example.test' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'mail-user' } });
    const password = screen.getByLabelText('Password');
    const credential = ['test', 'credential'].join('-');
    fireEvent.change(password, { target: { value: credential } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect IMAP' }));
    await waitFor(() => { expect(resolve).toHaveBeenCalledOnce(); });
    const submitted = resolve.mock.calls[0]?.[0];
    expect(submitted?.provider).toBe('imap');
    if (submitted?.provider !== 'imap') throw new Error('Expected IMAP input.');
    expect(submitted.imap).toMatchObject({ password: credential, imapPort: 993 });
    await waitFor(() => { expect(screen.queryByLabelText('Password')).toBeNull(); });
    expect(password.isConnected).toBe(false);
    expect(screen.queryByText(credential)).toBeNull();
    expect(screen.getByText('Mailbox connected.').closest('[data-slot="toast"]')).toBeTruthy();
  });

  it('disables pending actions and reports completion, errors, and notices in text', async () => {
    let finish: ((value: { state: 'ready' }) => void) | undefined;
    const onCompleteConnection = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<Settings mailboxes={[]} pendingConnection={pendingOutlook} statusNotice="Mailbox connection resumed." onCompleteConnection={onCompleteConnection} />);
    expect(screen.getByText('Mailbox connection resumed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(screen.getByRole('button', { name: /Checking connection/ }).disabled).toBe(true);
    if (finish) finish({ state: 'ready' });
    await waitFor(() => { expect(screen.getByText('Mailbox connected.').closest('[data-slot="toast"]')).toBeTruthy(); });

    cleanup();
    render(<Settings mailboxes={[]} pendingConnection={pendingOutlook} onCompleteConnection={vi.fn().mockRejectedValue(new Error('password=private'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => { expect(screen.getByText('Could not check the connection. Try again.').closest('[data-slot="toast"]')).toBeTruthy(); });
    expect(screen.queryByText(/password=private/)).toBeNull();
  });
});
