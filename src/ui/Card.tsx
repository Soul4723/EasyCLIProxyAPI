/**
 * Card: surface container for grouped content. Also exports CardHeader and Panel.
 *
 * Card props:
 * - as: 'div' (default) | 'section' | 'article' | 'li'
 * - tone: 'surface' (default, --ec-surface with 1px --ec-border) | 'raised' (--ec-raised) | 'plain' (no background or border)
 * - padded: default true (--ec-pad); false removes padding
 * - interactive: hover and focus treatment for clickable cards. The consumer adds role, tabIndex and handlers.
 * - selected: accent border with an inset ring
 * - ...native div attributes
 *
 * CardHeader props: title (rendered in an h3), count?, actions?, icon?, subtitle?
 * Panel: Card with tone="raised". Accepts the same props except tone.
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './Card.css';

export type CardTone = 'surface' | 'raised' | 'plain';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li';
  tone?: CardTone;
  padded?: boolean;
  interactive?: boolean;
  selected?: boolean;
  children?: ReactNode;
}

export function Card({
  as = 'div',
  tone = 'surface',
  padded = true,
  interactive = false,
  selected = false,
  className,
  children,
  ...rest
}: CardProps) {
  const Tag = as;
  return (
    <Tag
      className={cx(
        'ec-card',
        `ec-card--${tone}`,
        !padded && 'ec-card--flush',
        interactive && 'ec-card--interactive',
        selected && 'ec-card--selected',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
}

export function CardHeader({ title, count, actions, icon, subtitle }: CardHeaderProps) {
  const { formatNumber } = useI18n();
  return (
    <div className="ec-card__header">
      <div className="ec-card__heading">
        {icon && (
          <span className="ec-card__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div className="ec-card__titles">
          <h3 className="ec-card__title">
            {title}
            {count != null && <em className="ec-card__count">{formatNumber(count)}</em>}
          </h3>
          {subtitle && <div className="ec-card__subtitle">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="ec-card__actions">{actions}</div>}
    </div>
  );
}

export type PanelProps = Omit<CardProps, 'tone'>;

export function Panel(props: PanelProps) {
  return <Card {...props} tone="raised" />;
}
