/* HeroUI 3.2.4's public Toast types cross React Aria's unstable toast declarations. TypeScript resolves them, but type-aware ESLint currently marks that upstream chain as unresolved. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import * as React from 'react';
import {
  Toast as HeroUIToast,
  ToastCloseButton,
  ToastContent,
  ToastDescription,
  ToastIndicator,
  ToastProvider as HeroUIToastProvider,
  ToastTitle,
  toast as heroUIToast,
  type ToastContentValue,
} from '@heroui/react/toast';
import { cn } from '@/lib/utils.js';

export const toastDuration = 5_000;

export type ToastVariant = 'default' | 'success' | 'warning' | 'danger';

const addToast = (variant: ToastVariant, message: React.ReactNode, description?: React.ReactNode): string => {
  const options = { description, timeout: toastDuration };
  if (variant === 'success') return heroUIToast.success(message, options);
  if (variant === 'warning') return heroUIToast.warning(message, options);
  if (variant === 'danger') return heroUIToast.danger(message, options);
  return heroUIToast(message, options);
};

export const toast = Object.assign(
  (message: React.ReactNode, description?: React.ReactNode) => addToast('default', message, description),
  {
    success: (message: React.ReactNode, description?: React.ReactNode) => addToast('success', message, description),
    warning: (message: React.ReactNode, description?: React.ReactNode) => addToast('warning', message, description),
    danger: (message: React.ReactNode, description?: React.ReactNode) => addToast('danger', message, description),
    clear: () => { heroUIToast.clear(); },
  },
);

function ToastProgress({ duration, variant }: Readonly<{ duration: number; variant: ToastVariant }>): React.JSX.Element {
  const progress = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = progress.current;
    if (!element || typeof element.animate !== 'function' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const animation = element.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration, easing: 'linear', fill: 'forwards' });
    const toastElement = element.closest('[data-slot="toast"]');
    const pause = () => { animation.pause(); };
    const resume = () => { animation.play(); };
    toastElement?.addEventListener('mouseenter', pause);
    toastElement?.addEventListener('mouseleave', resume);
    toastElement?.addEventListener('focusin', pause);
    toastElement?.addEventListener('focusout', resume);
    return () => {
      toastElement?.removeEventListener('mouseenter', pause);
      toastElement?.removeEventListener('mouseleave', resume);
      toastElement?.removeEventListener('focusin', pause);
      toastElement?.removeEventListener('focusout', resume);
      animation.cancel();
    };
  }, [duration]);
  return <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-muted"><div ref={progress} data-slot="toast-progress" className={cn('h-full origin-left', variant === 'success' && 'bg-success', variant === 'warning' && 'bg-warning', variant === 'danger' && 'bg-destructive', variant === 'default' && 'bg-foreground')} /></div>;
}

type ToastProviderChildren = React.ComponentProps<typeof HeroUIToastProvider>['children'];
type ToastRenderer = Extract<ToastProviderChildren, (...arguments_: never[]) => unknown>;
type ToastRenderProps = Parameters<ToastRenderer>[0];

export function ToastProvider(): React.JSX.Element {
  return <HeroUIToastProvider placement="top" maxVisibleToasts={3} width="min(28rem, calc(100vw - 2rem))">
    {({ toast: queuedToast }: ToastRenderProps) => {
      const content = queuedToast.content as ToastContentValue;
      const variant = (content.variant === 'accent' ? 'default' : content.variant ?? 'default') as ToastVariant;
      return <HeroUIToast toast={queuedToast} variant={content.variant} className="relative overflow-hidden border border-border bg-card text-card-foreground shadow-none">
        <ToastIndicator variant={content.variant} />
        <ToastContent>
          {content.title ? <ToastTitle>{content.title}</ToastTitle> : null}
          {content.description ? <ToastDescription>{content.description}</ToastDescription> : null}
        </ToastContent>
        <ToastCloseButton aria-label="Dismiss notification" className="min-h-11 min-w-11" />
        <ToastProgress duration={toastDuration} variant={variant} />
      </HeroUIToast>;
    }}
  </HeroUIToastProvider>;
}
