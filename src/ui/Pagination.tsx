/**
 * Pagination: page controls with a "from–to / total" range and an optional page-size select.
 *
 * Props:
 * - page: 1-based current page (clamped to the valid range)
 * - pageSize: rows per page
 * - total: total row count
 * - onPage(n): called with the requested 1-based page
 * - onPageSize?(n): when provided, shows a styled native select of sizes; the consumer should reset page to 1
 * - pageSizes: options for the select; default [10, 20, 50, 100]. pageSize is added if missing.
 *
 * Renders nothing when total <= pageSize and onPageSize is not provided.
 */
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { IconButton } from './IconButton';
import './Pagination.css';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  pageSizes?: number[];
}

const DEFAULT_PAGE_SIZES = [10, 20, 50, 100];

export function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizes = DEFAULT_PAGE_SIZES }: PaginationProps) {
  const { t, formatNumber } = useI18n();
  if (total <= pageSize && !onPageSize) return null;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 1), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  const sizes = pageSizes.includes(pageSize) ? pageSizes : [...pageSizes, pageSize].sort((a, b) => a - b);

  return (
    <div className="ec-pager">
      <span className="ec-pager__range">
        {t('ui.pagination.range', {
          from: formatNumber(from),
          to: formatNumber(to),
          total: formatNumber(total),
        })}
      </span>
      <div className="ec-pager__controls">
        {onPageSize && (
          <span className="ec-pager__select-wrap">
            <select
              className="ec-pager__select"
              aria-label={t('ui.pagination.rows')}
              value={pageSize}
              onChange={(e) => onPageSize?.(Number(e.target.value))}
            >
              {sizes.map((size) => (
                <option key={size} value={size}>
                  {formatNumber(size)}
                </option>
              ))}
            </select>
            <ChevronDown className="ec-pager__chevron" aria-hidden="true" />
          </span>
        )}
        <IconButton
          label={t('ui.pagination.prev')}
          icon={<ChevronLeft />}
          variant="ghost"
          size="sm"
          disabled={current <= 1}
          onClick={() => onPage(current - 1)}
        />
        <IconButton
          label={t('ui.pagination.next')}
          icon={<ChevronRight />}
          variant="ghost"
          size="sm"
          disabled={current >= pages}
          onClick={() => onPage(current + 1)}
        />
      </div>
    </div>
  );
}
