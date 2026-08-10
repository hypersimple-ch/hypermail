import { Alert as HeroUIAlert } from '@heroui/react/alert';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type AlertProps = React.ComponentProps<'div'> & { variant?: 'default' | 'destructive' };
function Alert({ className, variant = 'default', children, role = 'alert', ...props }: AlertProps): React.JSX.Element { return <HeroUIAlert role={role} status={variant === 'destructive' ? 'danger' : 'default'} className={cn('w-full rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground', variant === 'destructive' && 'border-destructive/40', className)} {...props}><HeroUIAlert.Content>{children}</HeroUIAlert.Content></HeroUIAlert>; }
function AlertTitle({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element { return <HeroUIAlert.Title className={cn('text-current', className)} {...props} />; }
function AlertDescription({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element { return <HeroUIAlert.Description className={cn('text-current opacity-100', className)} {...props} />; }
export { Alert, AlertTitle, AlertDescription, type AlertProps };
