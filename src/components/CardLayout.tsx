import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Grid3x3, LayoutDashboard, LayoutGrid, Rows3 } from 'lucide-react';
import { SegmentedControl } from './SegmentedControl';
import { useI18n } from '../i18n';
import { stackQuotaColumns } from '../services/quotaLayout';
import './CardLayout.css';

/**
 * Card layouts for pages that list cards of uneven height.
 * Grid keeps each card at its own height; Even rows stretches cards to the row's tallest;
 * Stacked packs cards into columns with no row gaps; Compact packs narrower glance cards that expand for detail.
 */
export type CardLayout = 'grid' | 'even' | 'stacked' | 'compact';
export const cardLayouts: readonly CardLayout[] = ['grid', 'even', 'stacked', 'compact'];
export type StackedColumns = Readonly<Record<'stacked' | 'compact', Readonly<{ minWidth: number; gap: number }>>>;

const icons: Record<CardLayout, ReactNode> = {
  grid: <LayoutGrid size={16} aria-hidden="true" />,
  even: <Rows3 size={16} aria-hidden="true" />,
  stacked: <LayoutDashboard size={16} aria-hidden="true" />,
  compact: <Grid3x3 size={16} aria-hidden="true" />,
};

/** The page's chosen layout, kept in localStorage under `storageKey` like other page preferences; Grid when unset or unreadable. */
export function useCardLayout(storageKey: string): [CardLayout, (layout: CardLayout) => void] {
  const [layout, setLayoutState] = useState<CardLayout>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return cardLayouts.find((candidate) => candidate === stored) ?? 'grid';
    } catch {
      return 'grid';
    }
  });
  const setLayout = useCallback((next: CardLayout) => {
    setLayoutState(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* Layout is a display preference. */ }
  }, [storageKey]);
  return [layout, setLayout];
}

/** Keys of the cards a person expanded in Compact; not stored. */
export function useExpandedCards(): [ReadonlySet<string>, (key: string) => void] {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  return [expanded, toggle];
}

export function CardLayoutSwitch({ value, onChange, className = '' }: { value: CardLayout; onChange: (layout: CardLayout) => void; className?: string }) {
  const { t } = useI18n();
  return <SegmentedControl className={`routing-segmented card-layout-control ${className}`.trim()} aria-label={t('cardLayout.label')} value={value} onChange={onChange}
    items={cardLayouts.map((layout) => ({ value: layout, title: t(`cardLayout.${layout}`), 'aria-label': t(`cardLayout.${layout}`), label: icons[layout] }))} />;
}

/**
 * The card container for a layout. Grid and Even rows render one element with `data-layout`, styled by the page's own grid rule;
 * Stacked and Compact render columns whose count follows the container width (`columns` gives each layout's minimum card width
 * and gap), placing each card in the column with the least estimated height (`heights`, one per child).
 */
export function CardLayoutGrid({ layout, className, columns, heights, children }: {
  layout: CardLayout;
  className: string;
  columns: StackedColumns;
  heights: readonly number[];
  children: readonly ReactNode[];
}) {
  if (layout === 'stacked' || layout === 'compact') {
    return <StackedGrid layout={layout} className={className} columns={columns[layout]} heights={heights}>{children}</StackedGrid>;
  }
  return <div className={`${className} card-layout-grid`} data-layout={layout}>{children}</div>;
}

function StackedGrid({ layout, className, columns: { minWidth, gap }, heights, children }: {
  layout: 'stacked' | 'compact';
  className: string;
  columns: Readonly<{ minWidth: number; gap: number }>;
  heights: readonly number[];
  children: readonly ReactNode[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    // The exact (fractional) width: clientWidth rounds, which can admit a column narrower than minWidth.
    const measure = () => setColumnCount(Math.max(1, Math.floor((element.getBoundingClientRect().width + gap) / (minWidth + gap))));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minWidth, gap]);
  return <div ref={container} className={`${className} card-layout-grid`} data-layout={layout} style={{ '--card-layout-gap': `${gap}px` } as React.CSSProperties}>
    {stackQuotaColumns(heights, columnCount).map((items, column) => <div className="card-layout-column" key={column}>{items.map((index) => children[index])}</div>)}
  </div>;
}
