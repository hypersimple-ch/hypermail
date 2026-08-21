import type { LucideIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent } from '@/components/heroui/card.js';
import { Spinner } from '@/components/heroui/spinner.js';

type NavigationItemProps = Omit<React.ComponentProps<typeof Button>, 'variant'> & {
  active?: boolean;
  icon?: LucideIcon;
};

function NavigationItem({ active = false, icon: Icon, className, children, ...props }: NavigationItemProps): React.JSX.Element {
  return <Button variant="ghost" aria-current={active ? 'page' : undefined} data-slot="navigation-item" className={cn('w-full justify-start text-muted-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground', className)} {...props}>
    {Icon ? <Icon aria-hidden="true" /> : null}{children}
  </Button>;
}

type FilterOption<T extends string> = Readonly<{ value: T; label: string; count?: number }>;
type FilterGroupProps<T extends string> = Readonly<{
  label: string;
  value: T;
  options: readonly FilterOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}>;

function FilterGroup<T extends string>({ label, value, options, onChange, className }: FilterGroupProps<T>): React.JSX.Element {
  return <div data-slot="filter-group" role="group" aria-label={label} className={cn('flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain', className)}>
    {options.map((option) => <Button key={option.value} type="button" size="sm" variant={option.value === value ? 'secondary' : 'ghost'} aria-pressed={option.value === value} className="shrink-0 rounded-full" onClick={() => { onChange(option.value); }}>
      {option.label}{option.count === undefined ? null : <span aria-label={`${String(option.count)} items`} className="text-xs text-muted-foreground">{option.count}</span>}
    </Button>)}
  </div>;
}

type AppPageProps = React.ComponentProps<'section'>;
function AppPage({ className, ...props }: AppPageProps): React.JSX.Element {
  return <section data-slot="app-page" className={cn('mx-auto w-full max-w-5xl min-w-0 bg-background px-4 py-4 sm:px-6 sm:py-6', className)} {...props} />;
}

type PageMeasure = 'wide' | 'reading' | 'form';
type PageContainerProps = React.ComponentProps<'div'> & { measure?: PageMeasure };
const pageMeasures: Record<PageMeasure, string> = {
  wide: 'max-w-none',
  reading: 'max-w-3xl',
  form: 'max-w-2xl',
};
function PageContainer({ measure = 'wide', className, ...props }: PageContainerProps): React.JSX.Element {
  return <div data-slot="page-container" data-measure={measure} className={cn('w-full min-w-0', pageMeasures[measure], className)} {...props} />;
}

type PageHeaderProps = React.ComponentProps<'header'> & { title: string; description?: string; actions?: React.ReactNode };
function PageHeader({ title, description, actions, className, ...props }: PageHeaderProps): React.JSX.Element {
  return <header data-slot="page-header" className={cn('flex flex-wrap items-start justify-between gap-4', className)} {...props}>
    <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}</div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </header>;
}

type StatePanelProps = React.ComponentProps<'div'> & { title: string; description?: string; loading?: boolean; action?: React.ReactNode };
function StatePanel({ title, description, loading = false, action, className, ...props }: StatePanelProps): React.JSX.Element {
  return <Card data-slot="state-panel" className={cn('border-dashed', className)} {...props}><CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
    {loading ? <Spinner className="size-5" /> : null}<h2 className="font-semibold">{title}</h2>{description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}{action}
  </CardContent></Card>;
}

export { AppPage, PageContainer, NavigationItem, FilterGroup, PageHeader, StatePanel, type FilterOption, type PageMeasure };
