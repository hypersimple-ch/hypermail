// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPage, FilterGroup, NavigationItem, PageContainer, PageHeader, StatePanel } from '../../src/components/app/patterns.js';
import { Alert } from '../../src/components/heroui/alert.js';
import { Badge } from '../../src/components/heroui/badge.js';
import { Button, buttonVariants } from '../../src/components/heroui/button.js';
import { Card } from '../../src/components/heroui/card.js';
import { Checkbox } from '../../src/components/heroui/checkbox.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../src/components/heroui/field.js';
import { Input } from '../../src/components/heroui/input.js';
import { Select } from '../../src/components/heroui/select.js';
import { Separator } from '../../src/components/heroui/separator.js';
import { Spinner } from '../../src/components/heroui/spinner.js';
import { Textarea } from '../../src/components/heroui/textarea.js';
import { ToastProvider, toast, toastDuration } from '../../src/components/heroui/toast.js';
import { cn } from '../../src/lib/utils.js';

afterEach(() => { toast.clear(); cleanup(); });

describe('HeroUI component foundation', () => {
  it('keeps readable button variants and a 44px minimum target', () => {
    expect(buttonVariants()).toContain('button--primary');
    expect(buttonVariants()).toContain('min-h-11');
    expect(buttonVariants({ variant: 'destructive' })).toContain('button--danger');
    expect(buttonVariants({ variant: 'outline' })).toContain('button--outline');
  });

  it('merges conflicting Tailwind utilities deterministically', () => {
    expect(cn('px-2 text-sm', undefined, 'px-4')).toBe('text-sm px-4');
  });

  it('passes semantic and invalid state props to controls', () => {
    render(<Field><FieldLabel htmlFor="subject">Subject</FieldLabel><Input id="subject" aria-invalid="true" /><FieldDescription id="help">Required for review.</FieldDescription><FieldError id="error">Enter a subject.</FieldError><Textarea aria-label="Body" /><Select aria-label="Account" value="personal" options={[{ value: 'personal', label: 'Personal' }]} /><Checkbox label="Automatic processing" isDisabled /></Field>);
    expect(screen.getByLabelText('Subject').getAttribute('data-slot')).toBe('input');
    expect(screen.getByLabelText('Subject').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Enter a subject.');
    expect(screen.getByLabelText('Body').getAttribute('data-slot')).toBe('textarea');
    expect(screen.getByRole('button', { name: /Account/ }).getAttribute('data-slot')).toBe('select-trigger');
    expect(screen.getByRole('checkbox', { name: 'Automatic processing' }).disabled).toBe(true);
  });

  it('submits HeroUI select and checkbox values through their accessible hidden controls', () => {
    render(<form data-testid="preferences"><Select aria-label="Account" name="account" defaultValue="work" options={[{ value: 'personal', label: 'Personal' }, { value: 'work', label: 'Work' }]} /><Checkbox name="tls" label="Use TLS" defaultSelected /></form>);
    const values = new FormData(screen.getByTestId('preferences'));
    expect(values.get('account')).toBe('work');
    expect(values.get('tls')).toBe('on');
  });

  it('exposes component slots and disabled state without raw selector contracts', () => {
    render(<><Button disabled>Compose</Button><Badge>New</Badge><Alert>Blocked</Alert><Card>Message</Card><Separator decorative={false} /><Spinner /></>);
    expect(screen.getByRole('button', { name: 'Compose' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Compose' }).getAttribute('data-variant')).toBe('default');
    expect(screen.getByText('New').getAttribute('data-slot')).toBe('chip');
    expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('alert-root');
    expect(screen.getByRole('separator').getAttribute('data-slot')).toBe('separator');
  });

  it('renders queued HeroUI toasts with a timed progress bar and accessible close control', async () => {
    render(<ToastProvider />);
    act(() => { toast.success('Draft saved.'); });
    const message = await screen.findByText('Draft saved.');
    const root = message.closest('[data-slot="toast"]');
    expect(root).toBeTruthy();
    expect(root?.querySelector('[data-slot="toast-progress"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss notification' }).className).toContain('min-h-11');
    expect(toastDuration).toBe(5_000);
  });
});

describe('application patterns', () => {
  it('announces active navigation and filter state', () => {
    const change = vi.fn();
    render(<><NavigationItem active>Inbox</NavigationItem><FilterGroup label="Activity filters" value="new" options={[{ value: 'new', label: 'New', count: 2 }, { value: 'failed', label: 'Failed' }]} onChange={change} /></>);
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /New/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(change).toHaveBeenCalledWith('failed');
  });

  it('renders reusable headers and loading states', () => {
    render(<AppPage aria-label="Activity page"><PageContainer measure="reading"><PageHeader title="Activity" description="Agent work" actions={<Button>Pause</Button>} /><StatePanel title="Loading activity" loading /></PageContainer></AppPage>);
    expect(screen.getByRole('region', { name: 'Activity page' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByText('Loading activity')).toBeTruthy();
  });
});
