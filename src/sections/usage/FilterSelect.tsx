import { ChevronDown } from 'lucide-react';

/**
 * Compact labelled native select used by the shared filter bar (kit has no Select yet).
 * Props: value, onChange, options [{value,label}], ariaLabel, active? (tints when a non-default value is chosen).
 */
export function FilterSelect({ value, onChange, options, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  ariaLabel: string;
}) {
  // Keep an unlisted current value selectable (e.g. a deep-linked account not in the option list yet).
  const list = options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
  return (
    <label className="usage-select" data-active={value !== '' && value !== 'all' ? 'true' : 'false'}>
      <select value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.currentTarget.value)}>
        {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  );
}
