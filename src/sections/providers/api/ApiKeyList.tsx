import { useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCss } from '@dnd-kit/utilities';
import { Activity, GripVertical, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { maskSecret } from '../../../services/managementApi';
import { modelSearchText } from '../../../services/modelService';
import { providerGroupStatus } from '../../../services/providerGroups';
import {
  Badge, Button, Chip, EmptyState, ErrorState, IconButton, Masked, Popover, PopoverItem, ProviderLogo, Skeleton, StatusPill,
  Toggle, cx,
} from '../../../ui';
import { ErrorLine } from './fields';
import { API_KINDS, kindLabel, kindsOfBrand } from './kinds';
import { providerDragId, type ProviderCategory } from './logic';
import type { ApiProvidersController, ApiRow } from './useApiProviders';

function useRowMatcher(query: string | undefined) {
  return useMemo(() => {
    const needle = (query ?? '').trim().toLowerCase();
    if (!needle) return null;
    return (row: ApiRow) => [row.remark, row.name, ...row.apiKeys, row.baseUrl, row.models.map(modelSearchText).join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  }, [query]);
}

/**
 * "Add API key" action: opens the form directly when the scope has one kind, otherwise a small kind picker.
 * Used by the list's empty state; the page may reuse it.
 */
export function AddKeyButton({ controller, brand, variant = 'primary', size = 'sm' }: {
  controller: Pick<ApiProvidersController, 'openCreate' | 'busy' | 'loading'>;
  brand?: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const kinds = brand ? kindsOfBrand(brand) : API_KINDS;
  const single = kinds.length === 1 ? kinds[0] : undefined;
  const label = t(single?.openAi ? 'apiAccess.entries.addProvider' : 'apiAccess.entries.addKey');
  return (
    <>
      <span ref={anchor} className="ec-api-addanchor">
        <Button
          variant={variant}
          size={size}
          icon={<Plus size={14} />}
          disabled={controller.busy || controller.loading || kinds.length === 0}
          aria-haspopup={single ? undefined : 'menu'}
          onClick={() => (single ? controller.openCreate(single.id) : setOpen((value) => !value))}
          data-testid="api-add-key"
        >
          {label}
        </Button>
      </span>
      {single ? null : (
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor as RefObject<HTMLElement>} width={240} label={label}>
          {kinds.map((kind) => (
            <PopoverItem key={kind.id} icon={<ProviderLogo provider={kind.brand} size={16} />} onClick={() => { setOpen(false); controller.openCreate(kind.id); }}>
              {kind.label}
            </PopoverItem>
          ))}
        </Popover>
      )}
    </>
  );
}

function RowStatus({ row }: { row: ApiRow }) {
  const { t } = useI18n();
  if (row.disabled) return <StatusPill size="sm" status="disabled" label={t('apiAccess.status.disabled')} />;
  if (row.health === 'checking') return <StatusPill size="sm" status="cooldown" label={t('apiAccess.health.checking')} />;
  if (row.health === 'error') return <StatusPill size="sm" status="error" label={t('apiAccess.health.failed')} />;
  if (row.health === 'ok') return <StatusPill size="sm" status="available" label={t('apiAccess.health.healthy')} />;
  return <StatusPill size="sm" status="available" label={t('apiAccess.status.enabled')} />;
}

function SortableRow({ row, controller, dragDisabled, isDragOver }: {
  row: ApiRow;
  controller: ApiProvidersController;
  dragDisabled: boolean;
  isDragOver: boolean;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: providerDragId(row),
    disabled: dragDisabled,
    transition: { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  });
  const renderedTransform = transform
    ? { ...transform, scaleX: isDragging ? 1.012 : transform.scaleX, scaleY: isDragging ? 1.012 : transform.scaleY }
    : transform;
  const style: CSSProperties = {
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
    transform: DndCss.Transform.toString(renderedTransform),
    transition: isDragging ? undefined : transition,
  };
  const display = row.remark || row.name;
  const partial = Array.isArray(row.record.keys) && providerGroupStatus(row.record) === 'partial';
  const dragLabel = t('apiAccess.dragHandle', { remark: display });
  const busy = controller.busy;
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cx('ec-api-row', row.disabled && 'is-disabled', isDragging && 'is-dragging', isDragOver && !isDragging && 'is-drag-over')}
      data-testid="api-key-row"
      data-brand={row.brand}
    >
      <button type="button" className="ec-api-grip" disabled={dragDisabled} aria-label={dragLabel} title={dragLabel} {...attributes} {...listeners}>
        <GripVertical size={15} aria-hidden="true" />
      </button>
      <div className="ec-api-row__main">
        <div className="ec-api-row__title">
          <strong className="ec-api-row__name" title={display}><Masked value={display} /></strong>
          {row.remark && row.remark !== row.name ? <span className="ec-api-row__provider ec-trunc" title={row.name}><Masked value={row.name} /></span> : null}
          {partial ? <Chip size="sm" tone="warn">{t('apiAccess.groups.partial')}</Chip> : null}
        </div>
        <div className="ec-api-row__sub">
          <span className="ec-api-row__url ec-mono" title={row.baseUrl || undefined}>{row.baseUrl || t('apiAccess.defaultUrl')}</span>
          {row.apiKey ? (
            <span className="ec-api-keysummary" title={t('apiAccess.keys.count', { count: row.apiKeys.length })}>
              <KeyRound size={11} aria-hidden="true" />
              <Masked kind="identifier" mono value={maskSecret(row.apiKey)} />
              {row.apiKeys.length > 1 ? <span className="ec-api-keysummary__more">+{row.apiKeys.length - 1}</span> : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className="ec-api-row__meta">
        {row.models.length > 0 ? <Chip size="sm">{row.models.length === 1 ? t('sec.providers.api.row.modelOne') : t('apiAccess.models.summary', { count: row.models.length })}</Chip> : null}
        {row.priority === null ? null : <Chip size="sm" tone="outline">{t('apiAccess.priorityValue', { priority: row.priority })}</Chip>}
        <RowStatus row={row} />
      </div>
      <div className="ec-api-row__actions">
        <Toggle
          size="sm"
          checked={!row.disabled}
          disabled={busy}
          onChange={() => void controller.toggle(row)}
          label={t('apiAccess.toggleAria', { remark: display, action: row.disabled ? t('common.enable') : t('common.disable') })}
        />
        <IconButton size="sm" label={t('apiAccess.health.action')} icon={<Activity size={14} />} disabled={busy} onClick={() => controller.checkHealth(row)} />
        <IconButton size="sm" label={t('common.edit')} icon={<Pencil size={14} />} disabled={busy} onClick={() => controller.openEdit(row)} />
        <IconButton size="sm" label={t('common.delete')} icon={<Trash2 size={14} />} disabled={busy} onClick={() => controller.remove(row)} />
      </div>
    </article>
  );
}

/**
 * The API keys / provider configs of one brand (or all brands), grouped by kind when more than one kind is shown.
 * Rows drag-reorder inside their kind. `query` filters by remark, name, key, URL and model names.
 */
export function ApiKeyList({ controller, brand, query, compact = false }: {
  controller: ApiProvidersController;
  brand?: string;
  query?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const matches = useRowMatcher(query);
  const scoped = useMemo(() => controller.rows.filter((row) => !brand || row.brand === brand), [brand, controller.rows]);
  const visible = useMemo(() => (matches ? scoped.filter(matches) : scoped), [matches, scoped]);
  const groups = useMemo(() => {
    const byKind = new Map<ProviderCategory, ApiRow[]>();
    for (const row of visible) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
    return API_KINDS.filter((kind) => byKind.has(kind.id)).map((kind) => ({ kind, rows: byKind.get(kind.id)! }));
  }, [visible]);

  const handleDragEnd = (event: DragEndEvent) => {
    setDragOverId(null);
    const source = visible.find((row) => providerDragId(row) === String(event.active.id));
    const target = visible.find((row) => providerDragId(row) === String(event.over?.id ?? ''));
    if (!source || !target || source.index === target.index || source.kind !== target.kind) return;
    void controller.reorder(source, target);
  };

  if (controller.loading) {
    return (
      <div className={cx('ec-api-list', compact && 'ec-api-list--compact')} aria-busy="true">
        {[0, 1, 2].map((item) => (
          <div className="ec-api-row ec-api-row--skeleton" key={item}>
            <Skeleton width={28} height={28} radius="var(--ec-r-sm)" />
            <div className="ec-api-row__main"><Skeleton width="40%" height={14} /><Skeleton width="65%" height={11} /></div>
            <Skeleton width={120} height={22} radius="var(--ec-r-pill)" />
          </div>
        ))}
      </div>
    );
  }
  if (controller.error && scoped.length === 0) {
    return <ErrorState title={t('sec.providers.api.error.load')} message={controller.error} onRetry={() => void controller.reload()} />;
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound size={20} />}
        title={query?.trim()
          ? t('apiAccess.empty.filtered')
          : brand ? t('sec.providers.api.empty.brand', { provider: kindLabel(kindsOfBrand(brand)[0]?.id ?? 'codex-api-key') }) : t('apiAccess.empty.none')}
        action={query?.trim() ? undefined : <AddKeyButton controller={controller} brand={brand} />}
      />
    );
  }

  const showHeaders = groups.length > 1;
  return (
    <div className={cx('ec-api-list', compact && 'ec-api-list--compact')} data-testid="api-key-list">
      {controller.error ? <ErrorLine message={controller.error} /> : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragOver={({ over }) => setDragOverId(over ? String(over.id) : null)}
        onDragCancel={() => setDragOverId(null)}
        onDragEnd={handleDragEnd}
      >
        {groups.map(({ kind, rows }) => (
          <section className="ec-api-group" key={kind.id} aria-label={kind.label} data-kind={kind.id}>
            {showHeaders ? (
              <header className="ec-api-group__head">
                <ProviderLogo provider={kind.brand} size={20} />
                <h3>{kind.label}</h3>
                <Badge count={rows.length} />
              </header>
            ) : null}
            <SortableContext items={rows.map(providerDragId)} strategy={verticalListSortingStrategy}>
              <div className="ec-api-group__rows">
                {rows.map((row) => (
                  <SortableRow
                    key={providerDragId(row)}
                    row={row}
                    controller={controller}
                    dragDisabled={controller.busy || rows.length < 2}
                    isDragOver={dragOverId === providerDragId(row)}
                  />
                ))}
              </div>
            </SortableContext>
          </section>
        ))}
      </DndContext>
    </div>
  );
}
