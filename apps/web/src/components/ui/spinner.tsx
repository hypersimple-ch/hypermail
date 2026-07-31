import { LoaderCircle } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

function Spinner({ className, ...props }: React.ComponentProps<'svg'>): React.JSX.Element {
  return <LoaderCircle data-slot="spinner" aria-hidden="true" className={cn('size-4 animate-spin motion-reduce:animate-none', className)} {...props} />;
}
export { Spinner };
