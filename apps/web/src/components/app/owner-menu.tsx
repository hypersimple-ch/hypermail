import * as React from 'react';
import { ChevronDown, UserRound } from 'lucide-react';
import { DropdownRoot, DropdownTrigger, DropdownPopover, DropdownMenu, DropdownItem } from '@/components/heroui/dropdown.js';
import { Separator } from '@/components/heroui/separator.js';
import { toast } from '@/components/heroui/toast.js';
import { cn } from '@/lib/utils.js';

interface OwnerMenuProps {
  ownerEmail: string;
  online: boolean;
  compact?: boolean;
  onNavigate: (screen: 'settings' | 'account') => void;
  onSignOut?: () => Promise<void>;
}

export function OwnerMenu({ ownerEmail, online, compact = false, onNavigate, onSignOut }: OwnerMenuProps): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);
  const [signOutPending, setSignOutPending] = React.useState(false);
  const signOutInFlight = React.useRef(false);
  const descriptionId = React.useId();
  const initial = ownerEmail.trim().charAt(0).toUpperCase();
  const navigate = (screen: 'settings' | 'account') => {
    setIsOpen(false);
    onNavigate(screen);
  };
  const signOut = async () => {
    if (!onSignOut || signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSignOutPending(true);
    try {
      await onSignOut();
      setIsOpen(false);
    } catch {
      toast.danger('Could not sign out. Try again.');
    } finally {
      signOutInFlight.current = false;
      setSignOutPending(false);
    }
  };

  return <DropdownRoot isOpen={isOpen} onOpenChange={setIsOpen}>
    <DropdownTrigger aria-label="Account and settings" className={cn('flex items-center gap-2 text-left', compact ? 'size-11 justify-center p-0' : 'w-full max-w-none px-2 py-2')}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold">{initial || <UserRound className="size-4" />}</span>
      {!compact ? <><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{ownerEmail || 'Private owner'}</span><span className="block text-xs text-muted-foreground">{online ? 'Online' : 'Offline'}</span></span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></> : null}
    </DropdownTrigger>
    <DropdownPopover placement={compact ? 'bottom end' : 'top start'} shouldFlip containerPadding={16} className="w-[min(20rem,calc(100vw-2rem))]">
      <div className="border-b border-border px-3 py-3"><p className="text-xs text-muted-foreground">Private owner</p><p className="mt-1 whitespace-normal break-all text-sm font-medium">{ownerEmail || 'Email unavailable'}</p></div>
      <DropdownMenu aria-label="Account and settings">
        <DropdownItem id="settings" textValue="Mailboxes & agents" aria-describedby={`${descriptionId}-settings`} onAction={() => { navigate('settings'); }}>
          <span className="block"><span className="block text-sm font-medium">Mailboxes &amp; agents</span><span id={`${descriptionId}-settings`} className="block text-xs text-muted-foreground">Connected mailboxes and automation</span></span>
        </DropdownItem>
        <DropdownItem id="account" textValue="Account & security" aria-describedby={`${descriptionId}-account`} onAction={() => { navigate('account'); }}>
          <span className="block"><span className="block text-sm font-medium">Account &amp; security</span><span id={`${descriptionId}-account`} className="block text-xs text-muted-foreground">Owner identity and password</span></span>
        </DropdownItem>
        <Separator className="my-1" />
        <DropdownItem id="sign-out" textValue={signOutPending ? 'Signing out…' : 'Sign out'} isDisabled={!onSignOut || signOutPending} shouldCloseOnSelect={false} onAction={() => { void signOut(); }}>
          {signOutPending ? 'Signing out…' : 'Sign out'}
        </DropdownItem>
      </DropdownMenu>
    </DropdownPopover>
  </DropdownRoot>;
}
