import { Separator as HeroUISeparator } from '@heroui/react/separator';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type SeparatorProps = React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean };
function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: SeparatorProps): React.JSX.Element { return <HeroUISeparator orientation={orientation} aria-hidden={decorative || undefined} aria-orientation={decorative ? undefined : orientation} className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} {...props} />; }
export { Separator, type SeparatorProps };
