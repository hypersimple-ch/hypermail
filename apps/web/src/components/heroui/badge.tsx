import { Chip } from '@heroui/react/chip';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';
type BadgeProps = React.ComponentProps<'span'> & { variant?: BadgeVariant };
const colors = { default: 'default', secondary: 'default', outline: 'default', destructive: 'danger' } as const;
function Badge({ className, variant = 'default', children, ...props }: BadgeProps): React.JSX.Element { return <Chip color={colors[variant]} variant={variant === 'outline' ? 'outline' : 'soft'} size="sm" data-variant={variant} className={cn('w-fit whitespace-nowrap', className)} {...props}>{<>{children}</>}</Chip>; }
export { Badge, type BadgeProps };
