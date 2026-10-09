import { TextArea as HeroUITextArea } from '@heroui/react/textarea';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type TextareaProps = React.ComponentProps<'textarea'>;
function Textarea({ className, ...props }: TextareaProps): React.JSX.Element { return <HeroUITextArea fullWidth className={cn('min-h-28 rounded-lg border border-input bg-card text-foreground shadow-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props} />; }
export { Textarea, type TextareaProps };
