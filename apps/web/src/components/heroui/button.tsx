import { Button as HeroUIButton } from '@heroui/react/button';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';
type ButtonProps = Omit<React.ComponentProps<'button'>, 'size'> & { variant?: ButtonVariant; size?: ButtonSize };

const variants = { default: 'primary', destructive: 'danger', outline: 'outline', secondary: 'secondary', ghost: 'ghost', link: 'tertiary' } as const;
const sizes = { default: 'md', sm: 'sm', lg: 'lg', icon: 'md' } as const;

function buttonVariants({ variant = 'default', size = 'default', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn('button', `button--${variants[variant]}`, `button--${sizes[size]}`, 'min-h-11 rounded-lg focus-visible:ring-2 focus-visible:ring-ring', variant === 'outline' && 'bg-card hover:bg-muted', size === 'icon' && 'button--icon-only size-11 min-w-11 p-0', className);
}

function Button({ className, variant = 'default', size = 'default', disabled, children, ...props }: ButtonProps): React.JSX.Element {
  return <HeroUIButton data-variant={variant} data-size={size} className={buttonVariants({ variant, size, className: className ?? '' })} variant={variants[variant]} size={sizes[size]} isIconOnly={size === 'icon'} isDisabled={disabled} {...props}>{children}</HeroUIButton>;
}

export { Button, buttonVariants, type ButtonProps };
