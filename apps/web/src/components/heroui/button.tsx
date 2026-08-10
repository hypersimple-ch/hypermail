import { Button as HeroUIButton } from '@heroui/react/button';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';
type ButtonProps = Omit<React.ComponentProps<'button'>, 'size'> & { variant?: ButtonVariant; size?: ButtonSize; asChild?: boolean };

const variants = { default: 'primary', destructive: 'danger', outline: 'outline', secondary: 'secondary', ghost: 'ghost', link: 'tertiary' } as const;
const sizes = { default: 'md', sm: 'sm', lg: 'lg', icon: 'md' } as const;

function buttonVariants({ variant = 'default', size = 'default', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn('button', `button--${variants[variant]}`, `button--${sizes[size]}`, 'min-h-11 focus-visible:ring-2 focus-visible:ring-ring', size === 'icon' && 'button--icon-only size-11 min-w-11 p-0', className);
}

function Button({ className, variant = 'default', size = 'default', asChild = false, disabled, children, ...props }: ButtonProps): React.JSX.Element {
  const styles = buttonVariants({ variant, size, className: className ?? '' });
  if (asChild && React.isValidElement<{ className?: string }>(children)) {
    return React.cloneElement(children, { className: cn(styles, children.props.className), 'data-slot': 'button' } as { className?: string });
  }
  return <HeroUIButton data-variant={variant} data-size={size} className={styles} variant={variants[variant]} size={sizes[size]} isIconOnly={size === 'icon'} isDisabled={disabled} {...props}>{children}</HeroUIButton>;
}

export { Button, buttonVariants, type ButtonProps };
