import * as React from 'react';
import { cn } from '@/lib/utils.js';

function Input({ className, type, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return <input type={type} data-slot="input" className={cn('flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 md:text-sm', className)} {...props} />;
}

export { Input };
