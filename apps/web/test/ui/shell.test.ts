import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Compose, destinationForScreen, Drafts, HypermailShell, Inbox, More, Sent } from '../../src/ui/index.js';
import { ActivityScreen } from '../../src/activity/surfaces.js';
import { mockShellData } from '../../src/ui/fixtures.js';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('responsive shell rendering contracts', () => {
  it('renders labelled mobile and desktop Inbox regions with accessible compose controls', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('aria-label="Inbox"');
    expect(markup).toContain('aria-label="Desktop mailbox"');
    expect(markup).toContain('All Accounts');
    expect(markup).toContain('aria-label="Compose"');
    expect(markup).toContain('aria-label="Mobile primary"');
    expect(markup).toContain('grid-cols-[385px_minmax(0,1fr)]');
    expect(markup).not.toContain('Message actions for Samira Ahmed');
  });

  it('maps detail screens to their primary route families', () => {
    expect(destinationForScreen('message')).toBe('inbox');
    expect(destinationForScreen('activity-detail')).toBe('activity');
    for (const screen of ['settings', 'account', 'pending-sends'] as const) expect(destinationForScreen(screen)).toBe('more');
    expect(destinationForScreen('compose')).toBeUndefined();
  });

  it('keeps message detail in the desktop Inbox split and exposes owner connection status', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData, initialScreen: 'message', ownerEmail: 'owner@example.test', online: false }));
    expect(markup).toContain('aria-label="Desktop mailbox"');
    expect(markup).toContain('aria-label="Inbox"');
    expect(markup).toContain('aria-label="Message detail"');
    expect(markup).toContain('aria-label="Owner and connection status"');
    expect(markup).toContain('owner@example.test');
    expect(markup).toContain('Offline');
  });

  it('uses shared filter, badge, card, and button patterns for supported activity recovery', () => {
    const markup = render(React.createElement(ActivityScreen, { page: mockShellData.activity }));
    for (const text of ['New', 'Questions', 'Failed', 'History', 'Handled — acknowledge']) expect(markup).toContain(text);
    expect(markup).toContain('data-slot="filter-group"');
    expect(markup).toContain('data-slot="chip"');
    expect(markup).toContain('data-slot="card"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).not.toContain('>Review</button>');
  });

  it('renders semantic loading, empty, and error state panels', () => {
    expect(render(React.createElement(Inbox, { data: mockShellData, state: 'loading' }))).toContain('data-slot="state-panel"');
    expect(render(React.createElement(Inbox, { data: mockShellData, state: 'empty' }))).toContain('No mail here yet');
    const error = render(React.createElement(Inbox, { data: mockShellData, state: 'error' }));
    expect(error).toContain('role="alert"');
    expect(error).toContain('Could not load mail');
  });

  it('uses shared fields and a high-contrast primary save action in compose', () => {
    const markup = render(React.createElement(Compose, { accounts: mockShellData.accounts }));
    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup).toContain('data-slot="input"');
    expect(markup).toContain('data-slot="rich-text-editor"');
    expect(markup).toContain('aria-label="Message formatting"');
    expect(markup).toContain('data-variant="default"');
    expect(markup).toContain('Save draft');
  });

  it('keeps editable drafts distinct from read-only sent records', () => {
    const drafts = [{ id: 'd1', accountId: 'a1', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: '', state: 'editing', updatedAt: '', version: 4 }, { id: 's1', accountId: 'a1', recipients: [{ kind: 'to', address: 'sent@example.test' }], subject: 'Delivered', body: '', state: 'sent', updatedAt: '' }];
    expect(render(React.createElement(Drafts, { drafts }))).toContain('Follow up');
    expect(render(React.createElement(Drafts, { drafts }))).not.toContain('Delivered');
    const sent = render(React.createElement(Sent, { drafts }));
    expect(sent).toContain('Delivered');
    expect(sent).not.toContain('>Edit</button>');
    const more = render(React.createElement(More, { ownerEmail: 'owner@example.test', onSettings: () => {}, onAccount: () => {} }));
    expect(more).toContain('Add and review connected mailboxes');
    expect(more).toContain('owner@example.test');
  });

  it('renders Settings and Account as full-area screens reached through More', () => {
    const settings = render(React.createElement(HypermailShell, { data: mockShellData, initialScreen: 'settings', settingsMailboxes: [{ id: 'personal', provider: 'gmail', email: 'me@example.com', displayName: 'Personal', state: 'ready' }], onStartMailboxConnection: () => Promise.resolve({ state: 'error' }), onCompleteMailboxConnection: () => Promise.resolve({ state: 'error' }) }));
    expect(settings).toContain('Viewing settings');
    expect(settings).toContain('Connected mailboxes');
    expect(settings).toContain('Personal');
    const account = render(React.createElement(HypermailShell, { data: mockShellData, initialScreen: 'account', ownerEmail: 'owner@example.test', onChangePassword: () => Promise.resolve({ ok: true }), onSignOut: () => Promise.resolve() }));
    expect(account).toContain('Viewing account');
    expect(account).toContain('Owner identity');
    expect(account).toContain('owner@example.test');
  });

  it('provides focusable 44px shared controls and does not render unsupported actions', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('min-h-11');
    expect(markup).toContain('focus-visible:ring-2');
    expect(markup).not.toContain('Message actions for Samira Ahmed');
    expect(markup).not.toContain('Hypermail suggests a reply');
  });
});
