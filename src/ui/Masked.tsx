/**
 * Masked: displays a value through the privacy mask (usePrivacyMask). Display only; keep raw values for requests,
 * keys and copying (CopyButton copies the raw value).
 *
 * Props: value (raw string), kind ('text' default, or 'identifier' for ids/keys), identities (extra strings to hide
 * inside free text), as ('span' | 'code'), mono (use the monospace font), className.
 * When the value is masked, title and aria-label are the localized "Hidden" text, never the raw value.
 * When it is not masked, title shows the displayed value so truncated text can be read on hover.
 */
import { usePrivacyMask } from '../privacy';
import { cx } from './cx';
import { useUiText } from './uiText';
import './Masked.css';

export type MaskedProps = {
  value: string;
  kind?: 'text' | 'identifier';
  identities?: string[];
  as?: 'span' | 'code';
  mono?: boolean;
  className?: string;
};

export function Masked({ value, kind = 'text', identities, as = 'span', mono = false, className }: MaskedProps) {
  const mask = usePrivacyMask();
  const tu = useUiText();
  const shown = kind === 'identifier' ? mask.identifier(value) : mask.text(value, identities);
  const isMasked = shown !== value;
  const Tag = as;

  return (
    <Tag
      className={cx('ec-masked', mono && 'ec-masked--mono', isMasked && 'ec-masked--hidden', className)}
      title={isMasked ? tu('ui.masked') : shown}
      aria-label={isMasked ? tu('ui.masked') : undefined}
    >
      {shown}
    </Tag>
  );
}
