import { Card as HeroUICard } from '@heroui/react/card';
import * as React from 'react';
import { cn } from '@/lib/utils.js';
type DivProps = React.ComponentProps<'div'>;
function Card({ className, ...props }: DivProps): React.JSX.Element { return <HeroUICard className={cn('gap-6 rounded-xl border border-border bg-card py-6 text-card-foreground shadow-sm', className)} {...props} />; }
function CardHeader({ className, ...props }: DivProps): React.JSX.Element { return <HeroUICard.Header className={cn('grid gap-2 px-6', className)} {...props} />; }
function CardTitle({ className, ...props }: React.ComponentProps<'h3'>): React.JSX.Element { return <HeroUICard.Title className={cn('font-semibold leading-none', className)} {...props} />; }
function CardDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element { return <HeroUICard.Description className={cn('text-sm text-muted-foreground', className)} {...props} />; }
function CardContent({ className, ...props }: DivProps): React.JSX.Element { return <HeroUICard.Content className={cn('px-6', className)} {...props} />; }
function CardFooter({ className, ...props }: DivProps): React.JSX.Element { return <HeroUICard.Footer className={cn('flex items-center px-6', className)} {...props} />; }
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
