import * as React from 'react';
import { cn } from '@/lib/utils.js';

function Field({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element { return <div data-slot="field" className={cn('grid gap-2', className)} {...props} />; }
function FieldLabel({ className, ...props }: React.ComponentProps<'label'>): React.JSX.Element { return <label data-slot="field-label" className={cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)} {...props} />; }
function FieldDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element { return <p data-slot="field-description" className={cn('text-sm text-muted-foreground', className)} {...props} />; }
function FieldError({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element { return <p data-slot="field-error" role="alert" className={cn('text-sm font-medium text-destructive', className)} {...props} />; }
function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>): React.JSX.Element { return <fieldset data-slot="field-set" className={cn('grid min-w-0 gap-4 border-0 p-0 disabled:opacity-70', className)} {...props} />; }
function FieldLegend({ className, ...props }: React.ComponentProps<'legend'>): React.JSX.Element { return <legend data-slot="field-legend" className={cn('mb-2 text-base font-semibold', className)} {...props} />; }

export { Field, FieldLabel, FieldDescription, FieldError, FieldSet, FieldLegend };
