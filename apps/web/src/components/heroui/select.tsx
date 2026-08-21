import { Label } from '@heroui/react/label';
import { ListBox } from '@heroui/react/list-box';
import { Select as HeroUISelect } from '@heroui/react/select';
import * as React from 'react';
import { cn } from '@/lib/utils.js';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  textValue?: string;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  name?: string;
  value?: string | undefined;
  defaultValue?: string | undefined;
  options: readonly SelectOption[];
  label?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  onValueChange?: (value: string) => void;
}

function Select({ id, name, value, defaultValue, options, label, placeholder, disabled, required, className, onValueChange, ...ariaProps }: SelectProps): React.JSX.Element {
  return <HeroUISelect
    id={id}
    name={name}
    value={value === undefined ? undefined : value || null}
    defaultValue={defaultValue || undefined}
    placeholder={placeholder}
    isDisabled={disabled}
    isRequired={required}
    onChange={(key: string | number | null) => { if (key !== null) onValueChange?.(String(key)); }}
    fullWidth
    className={className}
    {...ariaProps}
  >
    {label ? <Label className="text-sm font-medium leading-none">{label}</Label> : null}
    <HeroUISelect.Trigger className="h-11 min-h-11 rounded-lg border border-input bg-card px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <HeroUISelect.Value className={cn('text-sm', !value && !defaultValue && 'text-muted-foreground')} />
      <HeroUISelect.Indicator />
    </HeroUISelect.Trigger>
    <HeroUISelect.Popover className="rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <ListBox>
        {options.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.textValue ?? (typeof option.label === 'string' ? option.label : option.value)} isDisabled={option.disabled}>
          {option.label}
          <ListBox.ItemIndicator />
        </ListBox.Item>)}
      </ListBox>
    </HeroUISelect.Popover>
  </HeroUISelect>;
}

export { Select };
