import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity, Drafts, HypermailShell } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const css = readFileSync(resolve(import.meta.dirname, '../../src/ui/hypermail.css'), 'utf8');
const browser = readFileSync(resolve(import.meta.dirname, '../../src/browser.ts'), 'utf8');

describe('browser runtime contracts', () => {
  it('keeps fixture data outside the production browser entrypoint', () => {
    expect(browser).not.toContain('mockShellData');
    expect(browser).not.toContain('Samira Ahmed');
    expect(browser).toContain("fetch('/api/v1/session')");
    expect(browser).toContain("fetch('/api/v1/inbox')");
    expect(browser).toContain("fetch('/api/v1/drafts')");
  });

  it('discovers private owner setup only from the 401 session capability', () => {
    expect(browser).toContain("session.status === 401");
    expect(browser).toContain("bootstrapAvailable?: unknown");
    expect(browser).toContain("bootstrapAvailable === true");
    expect(browser).toContain("setState(bootstrapAvailable ? 'bootstrap' : 'unauthenticated')");
    expect(browser).toContain("if (state === 'bootstrap') return React.createElement(Bootstrap");
    expect(browser).not.toMatch(/href: ['"]\/?(?:sign-?up|register)/i);
    expect(browser).not.toMatch(/(?:sign-?up|register).*?(?:link|toggle|route)/i);
  });

  it('keeps first-run owner setup accessible, confirmed, and private', () => {
    expect(browser).toContain("fetch('/api/v1/auth/bootstrap'");
    expect(browser).toContain("response.status === 201");
    expect(browser).toContain("response.status === 409");
    expect(browser).toContain("Setup is complete. Sign in to continue.");
    expect(browser).toContain("autoComplete: 'email'");
    expect(browser).toContain("autoComplete: 'new-password'");
    expect(browser).toContain('minLength: 12, maxLength: 1024');
    expect(browser).toContain("name: 'confirmPassword'");
    expect(browser).toContain("Passwords do not match.");
    expect(browser).toContain("role: 'alert'");
    expect(browser).toContain("disabled: pending");
  });

  it('has 360px, tablet, and desktop layout boundaries without horizontal overflow', () => {
    expect(css).toContain('.hm-shell{min-height:100dvh;background:var(--hm-paper);overflow-x:hidden}');
    expect(css).toContain('min-height:79px');
    expect(css).toContain('@media (min-width:700px)');
    expect(css).toContain('grid-template-columns:220px minmax(0,1fr)');
    expect(css).toContain('grid-template-columns:385px minmax(0,1fr)');
    expect(css).toContain('min-width:0');
  });

  it('renders accessible keyboard actions at every responsive presentation', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('aria-label="Mailbox navigation"');
    expect(markup).toContain('aria-label="Mobile primary"');
    expect(markup).toContain('aria-label="Compose"');
    expect(markup).toContain('aria-label="Open message from Samira Ahmed: Quick question about Thursday"');
    expect(markup).toContain('aria-live="polite"');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('width:44px');
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  });

  it('exposes only supported activity mutations and draft navigation as labelled buttons', () => {
    const activity = render(React.createElement(Activity, { data: { ...mockShellData, activity: [{ id: 'failed', expectedVersion: 2, state: 'failed', title: 'Sync failed', context: 'Work', time: 'now', action: 'Retry' }, { id: 'handled', expectedVersion: 3, state: 'complete', title: 'Reply handled', context: 'Personal', time: 'now', action: 'Acknowledge' }] } }));
    expect(activity).toContain('>Retry</button>');
    expect(activity).toContain('>Acknowledge</button>');
    const drafts = render(React.createElement(Drafts, { drafts: [{ id: 'd1', accountId: 'personal', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: '', state: 'editing', updatedAt: '' }] }));
    expect(drafts).toContain('aria-label="Edit draft Follow up"');
  });
});
