/**
 * ProviderLogo: provider tile with the real logo, or a monogram when there is no logo (or `monogram` is set).
 * Use ProviderName for the text; the logo is decorative (alt="", aria-hidden unless `title` is given).
 *
 * Props: provider (id or alias, see providers.ts), size (px, default 24), rounded ('tile' | 'circle'),
 * title (tooltip text, optional), monogram (force the letter), className.
 * Monochrome logos (xAI, Devin, OpenAI, Copilot) and Kimi are inverted on the dark theme only (CSS).
 */
import type { CSSProperties } from 'react';
import { cx } from './cx';
import { providerInfo } from './providers';
import './ProviderLogo.css';

export type ProviderLogoProps = {
  provider: string;
  size?: number;
  rounded?: 'tile' | 'circle';
  title?: string;
  monogram?: boolean;
  className?: string;
};

export function ProviderLogo({
  provider,
  size = 24,
  rounded = 'tile',
  title,
  monogram = false,
  className,
}: ProviderLogoProps) {
  const info = providerInfo(provider);
  const showLogo = !monogram && Boolean(info.icon);
  const letter = info.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span
      className={cx(
        'ec-provider-logo',
        rounded === 'circle' && 'ec-provider-logo--circle',
        showLogo && info.invertInDark && `ec-provider-logo--${info.invertInDark}`,
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.44),
        '--ec-logo-color': info.colorVar,
      } as CSSProperties}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      {showLogo ? (
        <img className="ec-provider-logo__img" src={info.icon} alt="" draggable={false} />
      ) : (
        <span className="ec-provider-logo__mono">{letter}</span>
      )}
    </span>
  );
}

export type ProviderNameProps = {
  provider: string;
  className?: string;
};

/** Display name for a provider id or alias (unknown names are shown as given). */
export function ProviderName({ provider, className }: ProviderNameProps) {
  return <span className={cx('ec-provider-name', className)}>{providerInfo(provider).name}</span>;
}
