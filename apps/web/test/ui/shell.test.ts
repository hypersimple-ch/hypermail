import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity, Drafts, HypermailShell, Inbox, More } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const css = readFileSync(resolve(import.meta.dirname, '../../src/ui/hypermail.css'), 'utf8');

describe('responsive shell rendering contracts', () => {
  it('renders a labelled mobile Inbox with account labels and accessible compose', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('aria-label="Inbox"');
    expect(markup).toContain('All Accounts');
    expect(markup).toContain('aria-label="Compose"');
    expect(markup).toContain('Mobile primary');
    expect(markup).toContain('Message actions for Samira Ahmed');
  });

  it('renders all activity status words and recovery actions without color-only meaning', () => {
    const markup = render(React.createElement(Activity, { data: mockShellData }));
    for (const text of ['New', 'Needs input', 'Failed', 'Completed', 'Review', 'Answer', 'Fix', 'View']) expect(markup).toContain(text);
  });

  it('renders loading, empty, and error states', () => {
    expect(render(React.createElement(Inbox, { data: mockShellData, state: 'loading' }))).toContain('Loading inbox');
    expect(render(React.createElement(Inbox, { data: mockShellData, state: 'empty' }))).toContain('No mail here yet');
    expect(render(React.createElement(Inbox, { data: mockShellData, state: 'error' }))).toContain('Could not load mail');
  });

  it('renders dedicated Drafts and More screens rather than an inbox fallback', () => {
    expect(render(React.createElement(Drafts, { drafts: [{ id: 'd1', accountId: 'a1', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: '', state: 'editing', updatedAt: '' }] }))).toContain('Follow up');
    expect(render(React.createElement(More))).toContain('Settings and account options');
  });

  it('keeps mobile, tablet, and desktop sizing contracts in the CSS', () => {
    expect(css).toContain('overflow-x:hidden'); // 360px document cannot grow horizontally
    expect(css).toContain('min-height:79px'); // balanced touch rows at 360px
    expect(css).toContain('@media (min-width:700px)'); // tablet/desktop switch
    expect(css).toContain('grid-template-columns:220px minmax(0,1fr)');
    expect(css).toContain('grid-template-columns:385px minmax(0,1fr)');
    expect(css).toContain('min-width:0'); // truncation rather than desktop/list overflow
  });

  it('provides keyboard/touch/reduced-motion affordances', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('Message actions for Samira Ahmed');
    expect(markup).toContain('aria-live="polite"');
    expect(css).toContain('width:44px');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  });
});
