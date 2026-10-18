/**
 * SearchInput: text search field with a leading icon, clear button and optional keyboard hint.
 *
 * Props:
 * - value (required) and onChange(v: string)
 * - placeholder: default t('ui.search')
 * - ariaLabel: accessible name; defaults to the placeholder text
 * - onClear: called by the clear button and by Escape; default clears through onChange('')
 * - kbdHint: short key hint such as "/" shown at the right edge while empty (aria-hidden)
 * - ...native input attributes except type; className goes to the wrapper; ref is forwarded to the input
 *
 * Width is 100%. Size it through the parent.
 */
import { forwardRef, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './SearchInput.css';

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  onClear?: () => void;
  kbdHint?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, placeholder, ariaLabel, onClear, kbdHint, className, onKeyDown, ...rest },
  ref,
) {
  const { t } = useI18n();
  const hasValue = value.length > 0;
  const text = placeholder ?? t('ui.search');
  const clearText = t('ui.clear');

  function clear() {
    if (onClear) onClear();
    else onChange('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && hasValue) {
      e.preventDefault();
      clear();
    }
    onKeyDown?.(e);
  }

  return (
    <div className={cx('ec-search', hasValue && 'ec-search--filled', className)}>
      <Search className="ec-search__icon" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        className="ec-search__input"
        value={value}
        placeholder={text}
        aria-label={ariaLabel ?? text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        {...rest}
      />
      {hasValue ? (
        <button type="button" className="ec-search__clear" aria-label={clearText} title={clearText} onClick={clear}>
          <X aria-hidden="true" />
        </button>
      ) : kbdHint ? (
        <kbd className="ec-search__kbd" aria-hidden="true">
          {kbdHint}
        </kbd>
      ) : null}
    </div>
  );
});
