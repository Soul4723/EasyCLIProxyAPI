/**
 * CopyButton: copies a raw value to the clipboard and shows a short "Copied" state.
 *
 * Props:
 * - value: string copied exactly as given (privacy masking must never change it)
 * - label: visible text. Omit for an icon-only button, which gets aria-label and title t('ui.copy')
 * - size: 'md' (default, --ec-ctrl-h) | 'sm' (--ec-ctrl-h-sm)
 * - variant: 'ghost' (default) | 'outline'
 * - onCopied(): called after a successful copy
 *
 * On success shows a check icon and t('ui.copied') for 1.5s. On failure shows t('common.copyFailed').
 * Status is announced through a polite live region. Uses navigator.clipboard, falling back to a hidden textarea.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './CopyButton.css';

export interface CopyButtonProps {
  value: string;
  label?: string;
  size?: 'md' | 'sm';
  variant?: 'ghost' | 'outline';
  onCopied?: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

const FEEDBACK_MS = 1500;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback (for example when the page lacks clipboard permission).
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label, size = 'md', variant = 'ghost', onCopied }: CopyButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function handleClick() {
    const ok = await writeClipboard(value);
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
  }

  const copied = state === 'copied';
  const failed = state === 'failed';
  const iconOnly = !label;
  const statusText = copied ? t('ui.copied') : failed ? t('common.copyFailed') : '';
  const visibleText = iconOnly ? undefined : (statusText || label);
  const icon = copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />;

  return (
    <>
      <button
        type="button"
        className={cx(
          'ec-copy',
          `ec-copy--${size}`,
          `ec-copy--${variant}`,
          iconOnly && 'ec-copy--icon',
          copied && 'ec-copy--copied',
          failed && 'ec-copy--failed',
        )}
        aria-label={iconOnly ? t('ui.copy') : undefined}
        title={iconOnly ? t('ui.copy') : undefined}
        onClick={() => void handleClick()}
      >
        {icon}
        {visibleText && <span className="ec-copy__label">{visibleText}</span>}
      </button>
      <span className="ec-copy__sr" aria-live="polite">
        {statusText}
      </span>
    </>
  );
}
