/**
 * DataTable: semantic table with optional sorting, row selection, loading and empty states.
 *
 * Props:
 * - columns: DataTableColumn<Row>[] with { id, header (ReactNode), cell(row, index), width? (number px or CSS length),
 *   align? ('start' | 'center' | 'end', default 'start'), sortable?, sortValue?(row) (string | number | null), className? }.
 * - rows: Row[]; rowKey(row): string.
 * - onRowClick?(row): makes rows clickable (role="button", tabIndex 0, Enter/Space).
 * - selectedKey?: string: highlights the row whose rowKey matches.
 * - sort?: { id, dir: 'asc' | 'desc' }: when passed, the table is controlled and does not reorder rows. When undefined,
 *   the table sorts internally by sortValue. Header cycle: unsorted to asc, asc to desc, desc to asc. Nulls sort last.
 * - onSortChange?(sort): called with the next sort state in both modes.
 * - density?: 'inherit' | 'compact'. stickyHeader?: boolean (wrapper scrolls, header stays visible).
 * - emptyState?: ReactNode shown when rows is empty (default: compact EmptyState with ui.noData).
 * - caption: string, rendered visually hidden for assistive tech.
 * - loading?: boolean: shows 5 skeleton rows and sets aria-busy on the wrapper.
 * - className?: added to the wrapper.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { useUiText } from './uiText';
import './DataTable.css';

export type SortDir = 'asc' | 'desc';
export type SortState = { id: string; dir: SortDir };
export type SortValue = string | number | null | undefined;

export type DataTableColumn<Row> = {
  id: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  width?: number | string;
  align?: 'start' | 'center' | 'end';
  sortable?: boolean;
  sortValue?: (row: Row) => SortValue;
  className?: string;
};

export type DataTableProps<Row> = {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  selectedKey?: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  density?: 'inherit' | 'compact';
  emptyState?: ReactNode;
  caption: string;
  stickyHeader?: boolean;
  loading?: boolean;
  className?: string;
};

const SKELETON_ROWS = 5;

function widthCss(width: number | string | undefined): string | undefined {
  if (width === undefined) return undefined;
  return typeof width === 'number' ? `${width}px` : width;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  sort,
  onSortChange,
  density = 'inherit',
  emptyState,
  caption,
  stickyHeader = false,
  loading = false,
  className,
}: DataTableProps<Row>) {
  const { locale } = useI18n();
  const tu = useUiText();
  const [internalSort, setInternalSort] = useState<SortState | undefined>(undefined);
  const controlled = sort !== undefined;
  const activeSort = controlled ? sort : internalSort;

  const displayRows = useMemo(() => {
    if (controlled || !activeSort) return rows;
    const column = columns.find((c) => c.id === activeSort.id);
    const getValue = column?.sortValue;
    if (!getValue) return rows;
    const sign = activeSort.dir === 'asc' ? 1 : -1;
    const isNil = (v: SortValue) => v === null || v === undefined;
    const indexed = rows.map((row, i) => ({ row, i, v: getValue(row) }));
    indexed.sort((a, b) => {
      if (isNil(a.v) && isNil(b.v)) return a.i - b.i;
      if (isNil(a.v)) return 1;
      if (isNil(b.v)) return -1;
      let cmp: number;
      if (typeof a.v === 'number' && typeof b.v === 'number') {
        cmp = a.v - b.v;
      } else {
        cmp = String(a.v).localeCompare(String(b.v), locale, { numeric: true, sensitivity: 'base' });
      }
      return cmp === 0 ? a.i - b.i : cmp * sign;
    });
    return indexed.map((x) => x.row);
  }, [rows, columns, activeSort, controlled, locale]);

  const handleSort = (column: DataTableColumn<Row>) => {
    const current = activeSort && activeSort.id === column.id ? activeSort : undefined;
    const next: SortState =
      current && current.dir === 'asc' ? { id: column.id, dir: 'desc' } : { id: column.id, dir: 'asc' };
    if (!controlled) setInternalSort(next);
    onSortChange?.(next);
  };

  const colCount = columns.length;
  const clickable = onRowClick !== undefined;

  return (
    <div
      className={cx(
        'ec-table-wrap',
        stickyHeader && 'ec-table-wrap--sticky',
        loading && 'ec-table-wrap--loading',
        className,
      )}
      aria-busy={loading ? true : undefined}
    >
      <table className={cx('ec-table', density === 'compact' && 'ec-table--compact')}>
        <caption className="ec-table__caption">{caption}</caption>
        <colgroup>
          {columns.map((col) => {
            const w = widthCss(col.width);
            return <col key={col.id} style={w ? { width: w } : undefined} />;
          })}
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) => {
              const align = col.align ?? 'start';
              const active = activeSort && activeSort.id === col.id ? activeSort : undefined;
              const ariaSort = col.sortable
                ? active
                  ? active.dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
                : undefined;
              const columnName = typeof col.header === 'string' ? col.header : col.id;
              const SortIcon = active ? (active.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cx('ec-table__th', `ec-table__cell--${align}`, col.className)}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className="ec-table__sort"
                      aria-label={tu('ui.table.sortBy', { column: columnName })}
                      onClick={() => handleSort(col)}
                    >
                      <span>{col.header}</span>
                      <SortIcon
                        size={12}
                        aria-hidden="true"
                        className={cx('ec-table__sort-icon', !active && 'ec-table__sort-icon--idle')}
                      />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <tr key={`skeleton-${i}`} className="ec-table__row--skeleton">
                {columns.map((col) => (
                  <td key={col.id} className={cx(`ec-table__cell--${col.align ?? 'start'}`, col.className)}>
                    <Skeleton width={i % 2 ? '55%' : '75%'} />
                  </td>
                ))}
              </tr>
            ))
          ) : displayRows.length === 0 ? (
            <tr>
              <td className="ec-table__empty" colSpan={colCount}>
                {emptyState ?? <EmptyState compact title={tu('ui.noData')} />}
              </td>
            </tr>
          ) : (
            displayRows.map((row, index) => {
              const key = rowKey(row);
              const selected = selectedKey !== undefined && selectedKey === key;
              const onKeyDown = clickable
                ? (e: KeyboardEvent<HTMLTableRowElement>) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick?.(row);
                    }
                  }
                : undefined;
              return (
                <tr
                  key={key}
                  className={cx(
                    'ec-table__row',
                    clickable && 'ec-table__row--clickable',
                    selected && 'ec-table__row--selected',
                  )}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-current={selected ? 'true' : undefined}
                  onClick={clickable ? () => onRowClick?.(row) : undefined}
                  onKeyDown={onKeyDown}
                >
                  {columns.map((col) => (
                    <td key={col.id} className={cx(`ec-table__cell--${col.align ?? 'start'}`, col.className)}>
                      {col.cell(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
