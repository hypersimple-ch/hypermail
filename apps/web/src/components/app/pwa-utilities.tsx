import * as React from 'react';
import { Button } from '@/components/heroui/button.js';
import { Card } from '@/components/heroui/card.js';

export function PwaUtilities({ installAvailable, updateAvailable, onInstall, onUpdate }: { installAvailable: boolean; updateAvailable: boolean; onInstall: () => void; onUpdate: () => void }): React.JSX.Element | null {
  if (!installAvailable && !updateAvailable) return null;
  return <aside aria-label="Application utilities" className="pointer-events-none fixed left-0 right-24 bottom-20 z-10 flex flex-wrap justify-center gap-2 px-4 [@media(min-width:700px)]:left-60 [@media(min-width:700px)]:bottom-3"><Card className="pointer-events-auto min-w-0 flex-wrap flex-row items-center gap-2 p-2">{installAvailable ? <Button type="button" variant="outline" onClick={onInstall}>Install Hypermail</Button> : null}{updateAvailable ? <Button type="button" variant="outline" onClick={onUpdate}>Reload to update</Button> : null}</Card></aside>;
}
