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
type DropdownTriggerProps = Omit<React.ComponentProps<typeof HeroUIDropdownTrigger>, 'className'> & { className?: string };
type DropdownPopoverProps = Omit<React.ComponentProps<typeof HeroUIDropdownPopover>, 'className'> & { className?: string };
type DropdownMenuProps = Omit<React.ComponentProps<typeof HeroUIDropdownMenu>, 'className'> & { className?: string };
type DropdownItemProps = Omit<React.ComponentProps<typeof HeroUIDropdownItem>, 'className'> & { className?: string };

function DropdownRoot(props: DropdownRootProps): React.JSX.Element {
  return <HeroUIDropdownRoot {...props} />;
}

function DropdownTrigger({ className, ...props }: DropdownTriggerProps): React.JSX.Element {
  return <HeroUIDropdownTrigger {...props} className={cn('min-h-11 min-w-11 rounded-lg text-foreground outline-none data-[hovered=true]:bg-secondary data-[pressed=true]:bg-secondary data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-ring', className)} />;
}

function DropdownPopover({ className, ...props }: DropdownPopoverProps): React.JSX.Element {
  return <HeroUIDropdownPopover {...props} className={cn('z-40 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-none', className)} />;
}

function DropdownMenu({ className, ...props }: DropdownMenuProps): React.JSX.Element {
  return <HeroUIDropdownMenu {...props} className={cn('outline-none', className)} />;
}

function DropdownItem({ className, ...props }: DropdownItemProps): React.JSX.Element {
  return <HeroUIDropdownItem {...props} className={cn('min-h-11 rounded-lg px-3 py-2 text-foreground outline-none data-[focused=true]:bg-secondary data-[hovered=true]:bg-secondary data-[selected=true]:bg-secondary data-[disabled=true]:opacity-50', className)} />;
}

export { DropdownRoot, DropdownTrigger, DropdownPopover, DropdownMenu, DropdownItem };
export type { DropdownRootProps, DropdownTriggerProps, DropdownPopoverProps, DropdownMenuProps, DropdownItemProps };
