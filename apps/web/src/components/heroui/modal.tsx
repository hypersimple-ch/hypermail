import * as React from 'react';
import { ModalRoot as HeroModalRoot, ModalBackdrop as HeroModalBackdrop, ModalContainer as HeroModalContainer, ModalDialog as HeroModalDialog, ModalHeading as HeroModalHeading } from '@heroui/react/modal';
import { cn } from '@/lib/utils.js';

type ModalBackdropProps = Omit<React.ComponentProps<typeof HeroModalBackdrop>, 'className'> & { className?: string };
type ModalContainerProps = Omit<React.ComponentProps<typeof HeroModalContainer>, 'className'> & { className?: string };
type ModalDialogProps = Omit<React.ComponentProps<typeof HeroModalDialog>, 'className'> & { className?: string };
type ModalHeadingProps = Omit<React.ComponentProps<typeof HeroModalHeading>, 'className'> & { className?: string };

export function ModalRoot(props: React.ComponentProps<typeof HeroModalRoot>): React.JSX.Element {
  return <HeroModalRoot {...props} />;
}
export function ModalBackdrop({ className, ...props }: ModalBackdropProps): React.JSX.Element {
  return <HeroModalBackdrop {...props} className={cn('!z-40 !h-[100dvh] !bg-[rgb(37_37_37/0.18)] !backdrop-blur-[6px]', className)} />;
}
export function ModalContainer({ className, ...props }: ModalContainerProps): React.JSX.Element {
  return <HeroModalContainer placement="center" scroll="inside" {...props} className={cn('!z-40 !h-full !w-full !max-w-none !p-0 [&[data-entering]]:!animate-none [&[data-exiting]]:![--tw-exit-scale:1]', className)} />;
}
export function ModalDialog({ className, ...props }: ModalDialogProps): React.JSX.Element {
  return <HeroModalDialog {...props} className={cn('!min-h-0 !rounded-xl !border !border-border !bg-white !p-0 !text-foreground !shadow-none !outline-none', className)} />;
}
export function ModalHeading({ className, ...props }: ModalHeadingProps): React.JSX.Element {
  return <HeroModalHeading {...props} className={cn('text-xl font-semibold', className)} />;
}
