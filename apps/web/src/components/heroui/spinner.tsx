import { Spinner as HeroUISpinner } from '@heroui/react/spinner';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type SpinnerProps = React.ComponentProps<'span'> & { size?: 'sm' | 'md' | 'lg' };
function Spinner({ className, size = 'sm', ...props }: SpinnerProps): React.JSX.Element { return <HeroUISpinner aria-hidden="true" size={size} className={cn('motion-reduce:[&_*]:animate-none', className)} {...props} />; }
export { Spinner };
