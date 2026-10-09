import {
  DropdownRoot as HeroUIDropdownRoot,
  DropdownTrigger as HeroUIDropdownTrigger,
  DropdownPopover as HeroUIDropdownPopover,
  DropdownMenu as HeroUIDropdownMenu,
  DropdownItem as HeroUIDropdownItem,
} from '@heroui/react/dropdown';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

type DropdownRootProps = React.ComponentProps<typeof HeroUIDropdownRoot>;
type DropdownTriggerProps = React.ComponentProps<typeof HeroUIDropdownTrigger>;
type DropdownPopoverProps = React.ComponentProps<typeof HeroUIDropdownPopover>;
type DropdownMenuProps = React.ComponentProps<typeof HeroUIDropdownMenu>;
type DropdownItemProps = React.ComponentProps<typeof HeroUIDropdownItem>;
type DropdownTriggerRenderState = Parameters<Extract<DropdownTriggerProps['className'], (...args: never[]) => unknown>>[0];
type DropdownPopoverRenderState = Parameters<Extract<DropdownPopoverProps['className'], (...args: never[]) => unknown>>[0];

function DropdownRoot(props: DropdownRootProps): React.JSX.Element {
  return <HeroUIDropdownRoot {...props} />;
}

function DropdownTrigger({ className, ...props }: DropdownTriggerProps): React.JSX.Element {
  return <HeroUIDropdownTrigger {...props} className={(state: DropdownTriggerRenderState) => cn('min-h-11 min-w-11 rounded-lg text-foreground outline-none data-[hovered=true]:bg-secondary data-[pressed=true]:bg-secondary data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-ring', typeof className === 'function' ? className(state) : className)} />;
}

function DropdownPopover({ className, ...props }: DropdownPopoverProps): React.JSX.Element {
  return <HeroUIDropdownPopover {...props} className={(state: DropdownPopoverRenderState) => cn('z-40 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-none', typeof className === 'function' ? className(state) : className)} />;
}

function DropdownMenu({ className, ...props }: DropdownMenuProps): React.JSX.Element {
  return <HeroUIDropdownMenu {...props} className={cn('outline-none', className)} />;
}

function DropdownItem({ className, ...props }: DropdownItemProps): React.JSX.Element {
  return <HeroUIDropdownItem {...props} className={cn('min-h-11 rounded-lg px-3 py-2 text-foreground outline-none data-[focused=true]:bg-secondary data-[hovered=true]:bg-secondary data-[selected=true]:bg-secondary data-[disabled=true]:opacity-50', className)} />;
}

export { DropdownRoot, DropdownTrigger, DropdownPopover, DropdownMenu, DropdownItem };
export type { DropdownRootProps, DropdownTriggerProps, DropdownPopoverProps, DropdownMenuProps, DropdownItemProps };
