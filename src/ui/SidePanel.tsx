/**
 * SidePanel: right-side drawer (portal to body) with a scrim, sticky header/footer and a scrolling body.
 *
 * Props: open, onClose, title (ReactNode), subtitle?, actions? (header buttons before the close button),
 * children (body), footer? (sticky bottom bar), width (px, default 560; full width below 720px), ariaLabel? (used when
 * the title is not plain text).
 * Behaviour: click on the scrim or the close button, or Escape, calls onClose. Focus moves into the panel on open and
 * returns to the previously focused element on close. Tab is trapped inside the panel. Body scroll is NOT locked.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { focusableWithin } from './Popover';
import { useUiText } from './uiText';
import './SidePanel.css';

export type SidePanelProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  ariaLabel?: string;
};

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  actions,
  children,
  footer,
  width = 560,
  ariaLabel,
}: SidePanelProps) {
  const tu = useUiText();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel ? focusableWithin(panel)[0] : undefined;
    (first ?? panel)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const current = document.activeElement;
      const outside = !panel.contains(current);
      if (e.shiftKey && (current === firstItem || outside)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (current === lastItem || outside)) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="ec-side-panel-layer">
      <div className="ec-side-panel__scrim" aria-hidden="true" onClick={() => onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        className="ec-side-panel"
        style={{ width: `min(${width}px, 100vw)` }}
      >
        <header className="ec-side-panel__head">
          <div className="ec-side-panel__titles">
            <h2 id={titleId} className="ec-side-panel__title">
              {title}
            </h2>
            {subtitle ? <p className="ec-side-panel__subtitle">{subtitle}</p> : null}
          </div>
          <div className="ec-side-panel__actions">
            {actions}
            <IconButton label={tu('ui.panel.close')} icon={<X size={16} />} onClick={() => onClose()} />
          </div>
        </header>
        <div className="ec-side-panel__body">{children}</div>
        {footer ? <footer className="ec-side-panel__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
