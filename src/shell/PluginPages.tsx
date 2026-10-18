import { useLayoutEffect, useRef, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Modifier } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AppWindow, ChevronRight, GripVertical, Lock } from 'lucide-react';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { pluginText } from '../i18n/plugins';
import {
  findPluginEntryForPage, mergePluginNavOrder, orderPluginNavEntries, pluginNavLayout, pluginPagePath, readPluginNavOrder, resolvePluginNavLayout,
  writePluginNavOrder, type PluginNavEntry, type PluginNavLayout, type PluginNavOverride,
} from '../services/pluginNavigation';
import { usePluginNav } from './PluginNav';
import { routeHref, useRoute } from './router';
import './PluginPages.css';

export const PLUGIN_GROUP_ID = 'ec-plugin-pages';
/** Icon rail (see Sidebar.css): no labels or group header, so the list is always expanded. */
const RAIL_QUERY = '(min-width: 721px) and (max-width: 1100px)';

/**
 * Expanded/collapsed from the free sidebar height: the group collapses when every row no longer fits (the same pure
 * rule as before the shell rewrite); a manual toggle holds until the automatic result or the page count changes.
 */
function usePluginGroupLayout(group: HTMLElement | null, count: number) {
  const [auto, setAuto] = useState<PluginNavLayout>('expanded');
  const [override, setOverride] = useState<PluginNavOverride | null>(null);
  useLayoutEffect(() => {
    const sidebar = group?.closest<HTMLElement>('.ec-sidebar');
    const nav = group?.closest<HTMLElement>('.ec-nav');
    if (!group || !sidebar || !nav || count === 0) { setAuto('expanded'); return undefined; }
    const rail = window.matchMedia(RAIL_QUERY);
    const measure = () => {
      const row = nav.querySelector<HTMLElement>('.ec-nav-item:not(.ec-plugin-entry)');
      const chrome = (sidebar.querySelector<HTMLElement>('.ec-brand')?.offsetHeight ?? 0) + (sidebar.querySelector<HTMLElement>('.ec-sidebar-foot')?.offsetHeight ?? 0);
      const staticRows = nav.querySelectorAll('.ec-nav-item:not(.ec-plugin-entry)').length;
      const gap = Number.parseFloat(getComputedStyle(nav).rowGap) || 0;
      // The group header counts as one more static row; separators and padding are covered by the fixed allowance.
      setAuto(pluginNavLayout({
        available: sidebar.clientHeight - chrome - 44, rowHeight: row?.offsetHeight ?? 0, gap, padding: 0,
        staticCount: staticRows + 1, pluginCount: count, compact: rail.matches,
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    rail.addEventListener('change', measure);
    return () => { observer.disconnect(); rail.removeEventListener('change', measure); };
  }, [group, count]);
  const layout = resolvePluginNavLayout(auto, count, override);
  const toggle = () => setOverride({ layout: layout === 'expanded' ? 'collapsed' : 'expanded', auto, count });
  return { layout, toggle };
}

function PluginEntryLink({ entry, active, locked, sortable, onActiveClick }: {
  entry: PluginNavEntry; active: boolean; locked: boolean; sortable: boolean; onActiveClick: () => void;
}) {
  const { t, locale } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: entry.route, disabled: locked || !sortable });
  const icon = <AppWindow size={16} strokeWidth={1.75} aria-hidden="true" />;
  return (
    <div ref={setNodeRef} className={`ec-plugin-row${isDragging ? ' is-dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      {locked ? (
        <button type="button" className="ec-nav-item ec-plugin-entry is-locked" disabled data-plugin-route={entry.route}
          aria-label={entry.label} title={t('app.nav.lockedHint')}>
          {icon}<span className="ec-nav-label">{entry.label}</span><Lock size={12} className="ec-nav-lock" aria-hidden="true" />
        </button>
      ) : (
        <a href={routeHref('plugin', entry.pluginID, entry.menuIndex > 0 ? { menu: String(entry.menuIndex) } : undefined)}
          className={`ec-nav-item ec-plugin-entry${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}
          data-plugin-route={entry.route} aria-label={entry.label} title={entry.description || entry.label}
          onClick={(event) => { if (active) { event.preventDefault(); onActiveClick(); } }}>
          {icon}<span className="ec-nav-label">{entry.label}</span>
        </a>
      )}
      {sortable && !locked && (
        <button ref={setActivatorNodeRef} type="button" className="ec-plugin-drag" {...attributes} {...listeners}
          aria-label={`${pluginText('reorderPage', locale)}: ${entry.label}`} title={pluginText('reorderPage', locale)}>
          <GripVertical size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Sidebar group below the secondary nav: one entry per enabled plugin menu (route `#/plugin/<id>`), drag/keyboard
 * ordering persisted by the existing pluginNavigation order service, collapsible, locked while the core is not ready.
 * In the icon rail the group shows only icons.
 */
export function PluginPages() {
  const { t, locale } = useI18n();
  const route = useRoute();
  const { status } = useCoreRuntime();
  const { entries, reload } = usePluginNav();
  const activeRoute = route.page === 'plugin' ? findPluginEntryForPage(entries, route.sub, route.params.get('menu'))?.route ?? null : null;
  const [order, setOrder] = useState(readPluginNavOrder);
  const [groupEl, setGroupEl] = useState<HTMLDivElement | null>(null);
  const { layout, toggle } = usePluginGroupLayout(groupEl, entries.length);
  const dragBounds = useRef<DOMRect | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  if (entries.length === 0) return null;
  const locked = !status?.ready;
  const sorted = orderPluginNavEntries(entries, order);
  const expanded = layout === 'expanded';
  const childActive = sorted.some((entry) => entry.route === activeRoute);
  const constrainDrag: Modifier = ({ transform, activeNodeRect }) => {
    const bounds = dragBounds.current;
    if (!bounds || !activeNodeRect) return transform;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    return { ...transform, x: 0, y: clamp(transform.y, bounds.top - activeNodeRect.top, bounds.bottom - activeNodeRect.bottom) };
  };
  return (
    <div className="ec-plugin-group" data-plugin-layout={layout}>
      <div className="ec-plugin-head">
        <span className="ec-plugin-title" id="ec-plugin-pages-title">{t('app.nav.pluginPages')}</span>
        <button type="button" className="ec-plugin-toggle" aria-expanded={expanded} aria-controls={PLUGIN_GROUP_ID}
          aria-label={t('app.nav.pluginPages')} data-active-child={!expanded && childActive ? 'true' : undefined} onClick={toggle}>
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[constrainDrag]} autoScroll={false}
          accessibility={{ screenReaderInstructions: { draggable: pluginText('reorderHint', locale) } }}
          onDragStart={() => {
            const rects = Array.from(groupEl?.querySelectorAll<HTMLElement>('.ec-plugin-row') ?? []).map((row) => row.getBoundingClientRect());
            if (!rects.length) return;
            const top = Math.min(...rects.map((rect) => rect.top));
            dragBounds.current = new DOMRect(0, top, 0, Math.max(...rects.map((rect) => rect.bottom)) - top);
          }}
          onDragEnd={({ active, over }) => {
            if (locked || !over || active.id === over.id) return;
            const from = sorted.findIndex((entry) => entry.route === active.id);
            const to = sorted.findIndex((entry) => entry.route === over.id);
            if (from < 0 || to < 0) return;
            const next = mergePluginNavOrder(order, arrayMove(sorted, from, to).map((entry) => entry.route));
            setOrder(next);
            writePluginNavOrder(next);
          }}>
          <SortableContext items={sorted.map((entry) => entry.route)} strategy={verticalListSortingStrategy}>
            <div ref={setGroupEl} id={PLUGIN_GROUP_ID} className="ec-plugin-list" role="group" aria-labelledby="ec-plugin-pages-title">
              {sorted.map((entry) => (
                <PluginEntryLink key={entry.route} entry={entry} active={entry.route === activeRoute} locked={locked}
                  sortable={sorted.length > 1} onActiveClick={reload} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : <div ref={setGroupEl} id={PLUGIN_GROUP_ID} hidden />}
    </div>
  );
}
