/**
 * Charts: dependency-free SVG charts for the kit.
 *
 * Sparkline props: values (number[]), width (96), height (28), color (CSS colour, default var(--ec-s1)),
 * fill (boolean, default false: a low-alpha area under the line), ariaLabel? (omit to hide from assistive tech).
 *
 * AreaChart props: series ({id, label, color?, values}[]), xLabels (string[]), height (220), yFormat?(n) (default compact
 * number), tooltipFormat?(value, seriesId, xLabel), smooth (true, Catmull-Rom curves), stacked (false), ariaLabel (required).
 * Width follows the container (ResizeObserver). Pointer movement shows a crosshair and tooltip. The container is
 * focusable: ArrowLeft/ArrowRight/Home/End step through points, Escape clears the selection.
 *
 * HBar props: rows ({id, label: ReactNode, value, color?, valueLabel?: ReactNode, onClick?}[]), max? (default: largest
 * value), ariaLabel (required). Labels are 90 to 120px wide and ellipsised; values are right-aligned mono.
 *
 * ChartLegend props: items ({label: ReactNode, color}[]).
 *
 * Colours are applied through style props so that var() tokens resolve. Gradient ids come from useId, sanitised.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { clamp, formatCompactNumber } from '../services/format';
import { useUiText } from './uiText';
import './Charts.css';

const DEFAULT_COLOR = 'var(--ec-s1)';

type Pt = { x: number; y: number };

const r2 = (n: number) => Math.round(n * 100) / 100;

function extent(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 1 };
}

function yFor(v: number, min: number, max: number, top: number, h: number): number {
  if (max === min) return top + h / 2;
  return top + h - ((v - min) / (max - min)) * h;
}

/** Nice upper bound for an axis (1, 2, 2.5, 5 or 10 times a power of ten). */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * exp;
}

/**
 * SVG path segments through points. Smooth mode uses Catmull-Rom converted to cubic beziers, with control-point y
 * clamped to bounds so curves cannot overshoot the plot area. move=true starts with M, false continues with L.
 */
function segments(points: Pt[], smooth: boolean, bounds: [number, number], move: boolean): string {
  if (points.length === 0) return '';
  const head = `${move ? 'M' : 'L'}${r2(points[0].x)},${r2(points[0].y)}`;
  if (points.length === 1 || !smooth) {
    return head + points.slice(1).map((p) => `L${r2(p.x)},${r2(p.y)}`).join('');
  }
  const [lo, hi] = bounds;
  const cy = (y: number) => clamp(y, lo, hi);
  let d = head;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = cy(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = cy(p2.y - (p3.y - p1.y) / 6);
    d += `C${r2(c1x)},${r2(c1y)} ${r2(c2x)},${r2(c2y)} ${r2(p2.x)},${r2(p2.y)}`;
  }
  return d;
}

// ---------------------------------------------------------------- Sparkline

export type SparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  ariaLabel?: string;
};

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = DEFAULT_COLOR,
  fill = false,
  ariaLabel,
}: SparklineProps) {
  const pad = 2;
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const { min, max } = extent(values);
  const pts: Pt[] = values.map((v, i) => ({
    x: pad + (values.length > 1 ? (i / (values.length - 1)) * innerW : innerW / 2),
    y: yFor(v, min, max, pad, innerH),
  }));
  const line = segments(pts, false, [pad, pad + innerH], true);
  const area =
    pts.length > 1
      ? `${line}L${r2(pts[pts.length - 1].x)},${r2(pad + innerH)}L${r2(pts[0].x)},${r2(pad + innerH)}Z`
      : '';

  return (
    <svg
      className="ec-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
      style={{ color }}
    >
      {pts.length > 1 ? (
        <>
          {fill ? <path d={area} fill="currentColor" fillOpacity={0.14} /> : null}
          <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------- AreaChart

export type AreaSeries = {
  id: string;
  label: string;
  color?: string;
  values: number[];
};

export type AreaChartProps = {
  series: AreaSeries[];
  xLabels: string[];
  height?: number;
  yFormat?: (value: number) => string;
  tooltipFormat?: (value: number, seriesId: string, xLabel: string) => string;
  smooth?: boolean;
  stacked?: boolean;
  ariaLabel: string;
};

const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

export function AreaChart({
  series,
  xLabels,
  height = 220,
  yFormat,
  tooltipFormat,
  smooth = true,
  stacked = false,
  ariaLabel,
}: AreaChartProps) {
  const { locale } = useI18n();
  const tu = useUiText();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(Math.floor(el.clientWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setWidth(Math.floor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = Math.max(xLabels.length, 0, ...series.map((s) => s.values.length));
  const innerW = Math.max(0, width - PAD_L - PAD_R);
  const innerH = Math.max(0, height - PAD_T - PAD_B);
  const bottom = PAD_T + innerH;
  const bounds: [number, number] = [PAD_T, bottom];

  if (n === 0 || series.length === 0) {
    return (
      <div className="ec-area-chart ec-area-chart--empty" style={{ height }} role="img" aria-label={ariaLabel}>
        {tu('ui.noData')}
      </div>
    );
  }

  // Lower and upper edges per series. Non-stacked series sit on the zero baseline.
  const running = new Array<number>(n).fill(0);
  const lower: number[][] = [];
  const upper: number[][] = [];
  series.forEach((s, k) => {
    lower[k] = running.slice();
    upper[k] = Array.from({ length: n }, (_, i) => {
      const v = s.values[i] ?? 0;
      return stacked ? running[i] + v : v;
    });
    if (stacked) for (let i = 0; i < n; i++) running[i] += s.values[i] ?? 0;
  });
  const yMax = niceCeil(Math.max(0, ...upper.flat()));
  const yAt = (v: number) => PAD_T + innerH - (v / yMax) * innerH;
  const xAt = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const yFmt = yFormat ?? ((v: number) => formatCompactNumber(v, locale));
  const tipFmt = tooltipFormat ?? ((v: number) => formatCompactNumber(v, locale));

  const pointsOf = (edge: number[]): Pt[] => edge.map((v, i) => ({ x: xAt(i), y: yAt(v) }));

  const ticks = [0, 1, 2, 3, 4].map((k) => yMax * (k / 4));
  const maxLabels = Math.max(2, Math.floor(innerW / 72));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (innerW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left - PAD_L) / innerW, 0, 1);
    setActive(Math.round(frac * (n - 1)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null;
    switch (e.key) {
      case 'ArrowRight':
        next = Math.min(n - 1, (active ?? -1) + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, (active ?? n) - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'Escape':
        setActive(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setActive(next);
  };

  const hasLayout = width > 0;
  const activeX = active !== null ? xLabels[active] ?? '' : '';

  return (
    <div
      ref={wrapRef}
      className="ec-area-chart"
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      style={{ height }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setActive(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      {hasLayout ? (
        <svg
          className="ec-area-chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {series.map((s, k) => (
              <linearGradient key={s.id} id={`${uid}-g${k}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" style={{ stopColor: s.color ?? DEFAULT_COLOR, stopOpacity: 0.28 }} />
                <stop offset="100%" style={{ stopColor: s.color ?? DEFAULT_COLOR, stopOpacity: 0.02 }} />
              </linearGradient>
            ))}
          </defs>

          {ticks.map((v, k) => (
            <g key={`tick-${k}`}>
              <line
                className={k === 0 ? 'ec-chart__axis' : 'ec-chart__grid'}
                x1={PAD_L}
                x2={PAD_L + innerW}
                y1={yAt(v)}
                y2={yAt(v)}
              />
              <text className="ec-chart__tick" x={PAD_L - 8} y={yAt(v) + 4} textAnchor="end">
                {yFmt(v)}
              </text>
            </g>
          ))}

          {xLabels.map((label, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={`x-${i}`}
                className="ec-chart__tick"
                x={xAt(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              >
                {label}
              </text>
            ) : null,
          )}

          {series.map((s, k) => {
            const top = pointsOf(upper[k]);
            const base = pointsOf(lower[k]).reverse();
            const color = s.color ?? DEFAULT_COLOR;
            const areaD = `${segments(top, smooth, bounds, true)}${segments(base, smooth, bounds, false)}Z`;
            const lineD = segments(top, smooth, bounds, true);
            return (
              <g key={s.id}>
                <path d={areaD} fill={`url(#${uid}-g${k})`} />
                <path d={lineD} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: color }} />
              </g>
            );
          })}

          {active !== null ? (
            <g>
              <line
                className="ec-area-chart__cross"
                x1={xAt(active)}
                x2={xAt(active)}
                y1={PAD_T}
                y2={bottom}
              />
              {series.map((s, k) => (
                <circle
                  key={s.id}
                  className="ec-area-chart__dot"
                  cx={xAt(active)}
                  cy={yAt(upper[k][active] ?? 0)}
                  r={3.5}
                  style={{ stroke: s.color ?? DEFAULT_COLOR, fill: 'var(--ec-raised)' }}
                />
              ))}
            </g>
          ) : null}
        </svg>
      ) : null}

      {active !== null && hasLayout ? (
        <div
          className="ec-area-chart__tip"
          aria-live="polite"
          style={{
            left: xAt(active),
            transform: xAt(active) > width * 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          <div className="ec-area-chart__tip-x">{activeX}</div>
          {series.map((s) => {
            const value = s.values[active] ?? 0;
            return (
              <div key={s.id} className="ec-area-chart__tip-row">
                <span className="ec-area-chart__swatch" style={{ background: s.color ?? DEFAULT_COLOR }} aria-hidden="true" />
                <span>{s.label}</span>
                <span className="ec-area-chart__tip-v">{tipFmt(value, s.id, activeX)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- HBar

export type HBarRow = {
  id: string;
  label: ReactNode;
  value: number;
  color?: string;
  valueLabel?: ReactNode;
  onClick?: () => void;
};

export type HBarProps = {
  rows: HBarRow[];
  max?: number;
  ariaLabel: string;
};

export function HBar({ rows, max, ariaLabel }: HBarProps) {
  const { locale } = useI18n();
  const largest = Math.max(0, ...rows.map((r) => r.value));
  const scale = max ?? (largest > 0 ? largest : 1);

  return (
    <ul className="ec-hbar" aria-label={ariaLabel}>
      {rows.map((row) => {
        const pct = clamp((row.value / scale) * 100, 0, 100);
        const content = (
          <>
            <span className="ec-hbar__label">{row.label}</span>
            <span className="ec-hbar__track" aria-hidden="true">
              <span className="ec-hbar__fill" style={{ width: `${pct}%`, background: row.color ?? DEFAULT_COLOR }} />
            </span>
            <span className="ec-hbar__value">{row.valueLabel ?? formatCompactNumber(row.value, locale)}</span>
          </>
        );
        return (
          <li key={row.id} className="ec-hbar__row">
            {row.onClick ? (
              <button type="button" className="ec-hbar__btn" onClick={row.onClick}>
                {content}
              </button>
            ) : (
              <div className="ec-hbar__line">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- ChartLegend

export type ChartLegendItem = { label: ReactNode; color: string };

export type ChartLegendProps = {
  items: ChartLegendItem[];
};

export function ChartLegend({ items }: ChartLegendProps) {
  return (
    <ul className="ec-chart-legend">
      {items.map((item, i) => (
        <li key={i} className="ec-chart-legend__item">
          <span className="ec-chart-legend__swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
