import { Input as HeroUIInput } from '@heroui/react/input';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type InputProps = React.ComponentProps<'input'>;
function Input({ className, ...props }: InputProps): React.JSX.Element { return <HeroUIInput fullWidth className={cn('h-11 min-h-11 border-input bg-background text-foreground focus-visible:ring-2 focus-visible:ring-ring', className)} {...props} />; }
export { Input, type InputProps };
