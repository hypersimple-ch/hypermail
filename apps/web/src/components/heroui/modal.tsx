import * as React from 'react';
import { ModalRoot as HeroModalRoot, ModalBackdrop as HeroModalBackdrop, ModalContainer as HeroModalContainer, ModalDialog as HeroModalDialog, ModalHeading as HeroModalHeading } from '@heroui/react/modal';
import { cn } from '@/lib/utils.js';

type BackdropClassName = Extract<React.ComponentProps<typeof HeroModalBackdrop>['className'], (...args: never[]) => unknown>;
type BackdropRenderState = Parameters<BackdropClassName>[0];
type ContainerClassName = Extract<React.ComponentProps<typeof HeroModalContainer>['className'], (...args: never[]) => unknown>;
type ContainerRenderState = Parameters<ContainerClassName>[0];

export function ModalRoot(props: React.ComponentProps<typeof HeroModalRoot>): React.JSX.Element {
  return <HeroModalRoot {...props} />;
}
export function ModalBackdrop({ className, ...props }: React.ComponentProps<typeof HeroModalBackdrop>): React.JSX.Element {
  return <HeroModalBackdrop {...props} className={(state: BackdropRenderState) => cn('!z-40 !h-[100dvh] !bg-[rgb(37_37_37/0.18)] !backdrop-blur-[6px]', typeof className === 'function' ? className(state) : className)} />;
}
export function ModalContainer({ className, ...props }: React.ComponentProps<typeof HeroModalContainer>): React.JSX.Element {
  return <HeroModalContainer placement="center" scroll="inside" {...props} className={(state: ContainerRenderState) => cn('!z-40 !h-full !w-full !max-w-none !p-0 [&[data-entering]]:!animate-none [&[data-exiting]]:![--tw-exit-scale:1]', typeof className === 'function' ? className(state) : className)} />;
}
export function ModalDialog({ className, ...props }: React.ComponentProps<typeof HeroModalDialog>): React.JSX.Element {
  return <HeroModalDialog {...props} className={cn('!min-h-0 !rounded-xl !border !border-border !bg-white !p-0 !text-foreground !shadow-none !outline-none', className)} />;
}
export function ModalHeading({ className, ...props }: React.ComponentProps<typeof HeroModalHeading>): React.JSX.Element {
  return <HeroModalHeading {...props} className={cn('text-xl font-semibold', className)} />;
}
