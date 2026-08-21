import { Checkbox as HeroUICheckbox, type CheckboxProps as HeroUICheckboxProps } from '@heroui/react/checkbox';
import { Label } from '@heroui/react/label';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

type CheckboxProps = Omit<HeroUICheckboxProps, 'children' | 'className'> & {
  label: React.ReactNode;
  className?: string;
};

function Checkbox({ label, className, ...props }: CheckboxProps): React.JSX.Element {
  return <HeroUICheckbox className={cn('text-sm', className)} {...props}>
    <HeroUICheckbox.Content className="min-h-11 gap-2">
      <HeroUICheckbox.Control className="shrink-0"><HeroUICheckbox.Indicator /></HeroUICheckbox.Control>
      <Label>{label}</Label>
    </HeroUICheckbox.Content>
  </HeroUICheckbox>;
}

export { Checkbox, type CheckboxProps };
