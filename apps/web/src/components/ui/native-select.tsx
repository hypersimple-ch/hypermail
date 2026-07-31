import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>): React.JSX.Element {
  return <div data-slot="native-select-wrapper" className="relative inline-flex min-w-0">
    <select data-slot="native-select" className={cn('h-11 w-full appearance-none rounded-md border border-input bg-background py-2 pr-9 pl-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30', className)} {...props}>{children}</select>
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
  </div>;
}

function NativeSelectOption(props: React.ComponentProps<'option'>): React.JSX.Element { return <option data-slot="native-select-option" {...props} />; }
function NativeSelectOptGroup(props: React.ComponentProps<'optgroup'>): React.JSX.Element { return <optgroup data-slot="native-select-optgroup" {...props} />; }

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
