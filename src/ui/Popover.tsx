/**
 * Popover: anchored floating panel (portal to body) for menus and small forms.
 *
 * Props: open, onClose, anchorRef (the trigger element), children, align ('start' | 'end', default 'start'),
 * side ('bottom' | 'top', default 'bottom'; flips when there is no room), width (px or CSS string), label (required,
 * becomes aria-label of role="dialog"), initialFocus ('first' focusable item | 'container', default 'first').
 * Position is fixed, computed from anchor.getBoundingClientRect(), recomputed on scroll (capture), resize and size changes,
 * and clamped to the viewport. Escape closes and returns focus to the anchor. A pointerdown outside the popover and the
 * anchor closes it.
 *
 * Also exports PopoverItem (button row, icon + label, danger tone), PopoverSeparator, PopoverHeading, and focusableWithin
 * (shared focus helper used by SidePanel).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { clamp } from '../services/format';
import './Popover.css';

const GAP = 6;
const EDGE = 8;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of a container, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden);
}

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  width?: number | string;
  label: string;
  initialFocus?: 'first' | 'container';
};

type Placement = { top: number; left: number; side: 'bottom' | 'top' };

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = 'start',
  side = 'bottom',
  width,
  label,
  initialFocus = 'first',
}: PopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [placement, setPlacement] = useState<Placement>({ top: -9999, left: -9999, side });

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const rect = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let placed = side;
    const below = vh - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    if (placed === 'bottom' && h > below && above > below) placed = 'top';
    else if (placed === 'top' && h > above && below > above) placed = 'bottom';

    const top = placed === 'bottom' ? rect.bottom + GAP : rect.top - GAP - h;
    const left = align === 'end' ? rect.right - w : rect.left;
    setPlacement({
      side: placed,
      top: clamp(top, EDGE, Math.max(EDGE, vh - h - EDGE)),
      left: clamp(left, EDGE, Math.max(EDGE, vw - w - EDGE)),
    });
  }, [anchorRef, align, side]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const pop = popRef.current;
    const observer = pop && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (observer && pop) observer.observe(pop);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    if (!pop) return;
    const first = initialFocus === 'first' ? focusableWithin(pop)[0] : undefined;
    (first ?? pop).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        anchorRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pop.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, anchorRef, initialFocus]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-side={placement.side}
      className="ec-popover"
      style={{ top: placement.top, left: placement.left, width }}
    >
      {children}
    </div>,
    document.body,
  );
}

export type PopoverItemProps = {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
};

export function PopoverItem({ icon, children, onClick, disabled = false, danger = false, className }: PopoverItemProps) {
  return (
    <button
      type="button"
      className={cx('ec-popover__item', danger && 'ec-popover__item--danger', className)}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? (
        <span className="ec-popover__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ec-popover__text">{children}</span>
    </button>
  );
}

export function PopoverSeparator() {
  return <div className="ec-popover__sep" role="separator" />;
}

export function PopoverHeading({ children }: { children: ReactNode }) {
  return <div className="ec-popover__heading">{children}</div>;
}
