// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterGroup, NavigationItem, PageHeader, StatePanel } from '../../src/components/app/patterns.js';
import { Alert } from '../../src/components/ui/alert.js';
import { Badge } from '../../src/components/ui/badge.js';
import { Button, buttonVariants } from '../../src/components/ui/button.js';
import { Card } from '../../src/components/ui/card.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../src/components/ui/field.js';
import { Input } from '../../src/components/ui/input.js';
import { NativeSelect } from '../../src/components/ui/native-select.js';
import { Separator } from '../../src/components/ui/separator.js';
import { Spinner } from '../../src/components/ui/spinner.js';
import { Textarea } from '../../src/components/ui/textarea.js';
import { cn } from '../../src/lib/utils.js';

afterEach(cleanup);

describe('shadcn-style component foundation', () => {
  it('keeps readable button variants and a 44px minimum target', () => {
    expect(buttonVariants()).toContain('bg-primary');
    expect(buttonVariants()).toContain('text-primary-foreground');
    expect(buttonVariants()).toContain('min-h-11');
    expect(buttonVariants({ variant: 'destructive' })).toContain('text-destructive-foreground');
    expect(buttonVariants({ variant: 'outline' })).toContain('text-foreground');
  });

  it('merges conflicting Tailwind utilities deterministically', () => {
    expect(cn('px-2 text-sm', undefined, 'px-4')).toBe('text-sm px-4');
  });

  it('passes semantic and invalid state props to controls', () => {
    render(<Field><FieldLabel htmlFor="subject">Subject</FieldLabel><Input id="subject" aria-invalid="true" /><FieldDescription id="help">Required for review.</FieldDescription><FieldError id="error">Enter a subject.</FieldError><Textarea aria-label="Body" /><NativeSelect aria-label="Account"><option>Personal</option></NativeSelect></Field>);
    expect(screen.getByLabelText('Subject').getAttribute('data-slot')).toBe('input');
    expect(screen.getByLabelText('Subject').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Enter a subject.');
    expect(screen.getByLabelText('Body').getAttribute('data-slot')).toBe('textarea');
    expect(screen.getByLabelText('Account').getAttribute('data-slot')).toBe('native-select');
  });

  it('exposes component slots and disabled state without raw selector contracts', () => {
    render(<><Button disabled>Compose</Button><Badge>New</Badge><Alert>Blocked</Alert><Card>Message</Card><Separator decorative={false} /><Spinner /></>);
    expect(screen.getByRole('button', { name: 'Compose' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Compose' }).getAttribute('data-variant')).toBe('default');
    expect(screen.getByText('New').getAttribute('data-slot')).toBe('badge');
    expect(screen.getByRole('alert').getAttribute('data-slot')).toBe('alert');
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
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
    render(<><PageHeader title="Activity" description="Agent work" actions={<Button>Pause</Button>} /><StatePanel title="Loading activity" loading /></>);
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByText('Loading activity')).toBeTruthy();
  });
});
