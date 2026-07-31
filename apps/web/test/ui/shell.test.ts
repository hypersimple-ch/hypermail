import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity, Compose, Drafts, HypermailShell, Inbox, More, Sent } from '../../src/ui/index.js';
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

  it('uses shared filter, badge, card, and button patterns for supported activity recovery', () => {
    const markup = render(React.createElement(Activity, { data: mockShellData }));
    for (const text of ['New', 'Questions', 'Failed', 'History', 'Needs input', 'Completed']) expect(markup).toContain(text);
    expect(markup).toContain('data-slot="filter-group"');
    expect(markup).toContain('data-slot="badge"');
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
    expect(markup).toContain('data-slot="native-select"');
    expect(markup).toContain('data-slot="input"');
    expect(markup).toContain('data-slot="textarea"');
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
    expect(render(React.createElement(More))).toContain('Settings and account options');
  });

  it('provides focusable 44px shared controls and does not render unsupported actions', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('min-h-11');
    expect(markup).toContain('focus-visible:ring-2');
    expect(markup).not.toContain('Message actions for Samira Ahmed');
    expect(markup).not.toContain('Hypermail suggests a reply');
  });
});
