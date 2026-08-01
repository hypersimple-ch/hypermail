import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity, Drafts, HypermailShell, Sent } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const globals = readFileSync(resolve(import.meta.dirname, '../../src/styles/globals.css'), 'utf8');
const shellSource = readFileSync(resolve(import.meta.dirname, '../../src/ui/index.tsx'), 'utf8');
const buttonSource = readFileSync(resolve(import.meta.dirname, '../../src/components/ui/button.tsx'), 'utf8');
const browser = readFileSync(resolve(import.meta.dirname, '../../src/browser.tsx'), 'utf8');

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
    expect(browser).toContain("if (state === 'bootstrap') return <Bootstrap");
    expect(browser).not.toMatch(/href: ['"]\/?(?:sign-?up|register)/i);
    expect(browser).not.toMatch(/(?:sign-?up|register).*?(?:link|toggle|route)/i);
  });

  it('keeps first-run owner setup accessible, confirmed, and private', () => {
    expect(browser).toContain("fetch('/api/v1/auth/bootstrap'");
    expect(browser).toContain("response.status === 201");
    expect(browser).toContain("response.status === 409");
    expect(browser).toContain("Setup is complete. Sign in to continue.");
    expect(browser).toContain('autoComplete="email"');
    expect(browser).toContain('autoComplete="new-password"');
    expect(browser).toContain('minLength={12} maxLength={1024}');
    expect(browser).toContain('name="confirmPassword"');
    expect(browser).toContain('Passwords do not match.');
    expect(browser).toContain('<FieldSet disabled={pending}>');
    expect(browser).toContain("@/components/ui/field.js");
  });

  it('wires Settings mailbox onboarding and Account security to authenticated APIs', () => {
    expect(shellSource).toContain("screen === 'settings'");
    expect(shellSource).toContain("screen === 'account'");
    expect(shellSource).toContain('onStartMailboxConnection');
    expect(shellSource).toContain('onChangePassword');
    expect(browser).toContain("fetch('/api/v1/mailboxes'");
    expect(browser).toContain("fetch('/api/v1/mailboxes/complete'");
    expect(browser).toContain("fetch('/api/v1/auth/password'");
    expect(browser).toContain("fetch('/api/v1/auth/logout'");
    expect(browser).toContain("location.pathname === '/oauth/gmail/callback'");
    expect(browser).toContain("window.location.assign(authorizationUrl)");
    expect(browser).toContain("url.origin !== 'https://accounts.google.com'");
    expect(browser).toContain("authorizationResponse = callback.toString()");
    expect(browser).toContain("window.history.replaceState(window.history.state, '', '/')");
    const storageWrite = browser.split('\n').find((line) => line.includes('sessionStorage.setItem')) ?? '';
    expect(storageWrite).toContain('provider: pending.provider, handle: pending.handle, expiresAt: pending.expiresAt');
    expect(storageWrite).not.toMatch(/password|authorizationUrl|userCode|code:|state:/);
  });

  it('has 360px, tablet, and desktop layout boundaries without horizontal overflow', () => {
    expect(shellSource).toContain('min-h-dvh overflow-x-hidden');
    expect(shellSource).toContain('min-h-[79px]');
    expect(shellSource).toContain('[@media(min-width:700px)]');
    expect(shellSource).toContain('grid-cols-[220px_minmax(0,1fr)]');
    expect(shellSource).toContain('grid-cols-[385px_minmax(0,1fr)]');
    expect(shellSource).toContain('min-w-0');
    expect(shellSource).not.toContain('hm-');
  });

  it('renders accessible keyboard actions at every responsive presentation', () => {
    const markup = render(React.createElement(HypermailShell, { data: mockShellData }));
    expect(markup).toContain('aria-label="Mailbox navigation"');
    expect(markup).toContain('aria-label="Mobile primary"');
    expect(markup).toContain('aria-label="Compose"');
    expect(markup).toContain('aria-label="Open message from Samira Ahmed: Quick question about Thursday"');
    expect(markup).toContain('aria-live="polite"');
    expect(buttonSource).toContain('focus-visible:ring-2');
    expect(buttonSource).toContain('min-h-11');
    expect(globals).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('uses supported versioned mutations, filters, and distinct sent projection', () => {
    expect(browser).toContain('activities?filter=${encodeURIComponent(activityFilter)}');
    expect(browser).toContain("method: 'POST'");
    expect(browser).toContain('expectedVersion: draft.expectedVersion');
    expect(browser).not.toContain("method: draft.id ? 'PUT'");
    expect(browser).not.toContain('safe: true');
    const activity = render(React.createElement(Activity, { data: { ...mockShellData, activity: [{ id: 'failed', expectedVersion: 2, state: 'failed', title: 'Sync failed', context: 'Work', time: 'now', action: 'Retry' }, { id: 'handled', expectedVersion: 3, state: 'complete', title: 'Reply handled', context: 'Personal', time: 'now', action: 'Acknowledge' }] } }));
    expect(activity).toContain('>Retry</button>');
    expect(activity).toContain('>Acknowledge</button>');
    expect(activity).toContain('Questions');
    const records = [{ id: 'd1', accountId: 'personal', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: '', state: 'editing', updatedAt: '' }, { id: 's1', accountId: 'personal', recipients: [], subject: 'Sent only', body: '', state: 'sent', updatedAt: '' }];
    expect(render(React.createElement(Drafts, { drafts: records }))).toContain('aria-label="Edit draft Follow up"');
    expect(render(React.createElement(Sent, { drafts: records }))).toContain('Sent only');
  });
});
