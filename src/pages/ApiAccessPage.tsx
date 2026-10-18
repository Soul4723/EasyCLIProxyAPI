import { useConfirmation } from '../components/ConfirmationDialog';
import { AdvancedSettingsGroup } from '../components/api-access/AdvancedSettingsGroup';
import { normalizeProviderModels } from '../services/providerModels';
import { ModelSelectionPanel } from '../components/ModelSelectionPanel';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import {
  type CSSProperties,
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS as DndCss } from '@dnd-kit/utilities';
import {
  Edit3,
  Filter,
  GripVertical,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import deepseekIcon from '../assets/icons/deepseek.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import metaIcon from '../assets/icons/meta.svg';
import openaiIcon from '../assets/icons/openai-light.svg';
import vertexIcon from '../assets/icons/vertex.svg';
import grokIcon from '../assets/icons/grok.svg';
import {
  isRecord,
  managementApi,
  maskSecret,
  readBoolean,
  readNumber,
  readString,
} from '../services/managementApi';
import {
  DEEPSEEK_BASE_URL,
  fetchModels,
  mergeModelOptions,
  modelSearchText,
  modelsFromRecord,
  normalizeBaseUrl,
  reconcileModelSelection,
  usableModelAlias,
  type ModelOption,
  type ModelProvider,
} from '../services/modelService';
import {
  checkProviderModelHealth,
  checkProviderModelsHealth,
  mergeProviderHealthModels,
  PROVIDER_HEALTH_TIMEOUT_MS,
  type ProviderHealthCheckOptions,
  type ProviderModelHealthResult,
} from '../services/providerHealthCheck';
import { modelMatchesRule } from '../services/oauthModels';
import { normalizeProviderProxyUrl } from '../services/providerProxy';
import { ProviderGroupKeysEditor } from '../components/ProviderGroupKeysEditor';
import { ProviderGroupTemplateFields, ProviderKeyTemplateFields, ProviderModelFields } from '../components/ProviderTemplateFields';
import { providerText } from '../i18n/providerTemplate';
import {
  cleanProviderGroup, effectiveProviderKey, providerGroupIdentity, providerGroupKeys, providerGroupStatus,
  providerKeyDraft, providerKeyIsDisabled, serializeProviderKey, validateProviderGroupKeys, validateProviderTemplateRecord, type ProviderKeyDraft,
} from '../services/providerGroups';
import { providerGroupsApi } from '../services/managementApi';
import {
  appendProviderEntry, locateProviderEntry, providerEntries, removeProviderEntry,
  reorderProviderEntries, updateProviderEntry, type ProviderEntrySource,
} from '../services/providerEntries';
import { getCurrentLocale, translate, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { MessageNotice, FloatingNotice, useAppNotice } from '../appNotice';

import {
  type ProviderCategory, type ProviderDraft, type ProviderRow, type ProviderSection, type ProviderDefinition,
  type ProviderSaveResult, type ApiAccessRemarkLocator,
  apiAccessRemarkLocatorFromRecord, apiAccessRemarkLocatorFromRow, applyProviderPreset, applyProviderRemarkIdentity,
  buildProviderGroupRecord, buildProviderKeyRecord, createProviderDraft, definitionFor, draftFromRow, emptyProviderDraft,
  emptyRecords, hasDuplicateProviderRecord, parseProviderApiKeys, parseProviderHeaders, providerDragId,
  providerDefinitions, providerDraftConnection, providerHeadersFromRecord, providerHealthIdentity, providerLabel,
  providerLoadDefinitions, providerModelType, providerRecordWithDisabledState, providerRemarkIdentity,
  providerRowsFromGroups, requestErrorMessage, exclusionsForModelSelection, modelSelectionForDiscovery, stripResponseFields,
} from '../sections/providers/api/logic';
export * from '../sections/providers/api/logic';

const SELECTED_CATEGORY_KEY = 'cpa-gui.api-access-selected-category.v1';

const readSelectedCategory = (): ProviderCategory => {
  const fallback = providerDefinitions[0].id;
  if (typeof window === 'undefined') return fallback;
  try {
    const saved = window.localStorage.getItem(SELECTED_CATEGORY_KEY);
    return providerDefinitions.find((definition) => definition.id === saved)?.id ?? fallback;
  } catch {
    return fallback;
  }
};

const writeSelectedCategory = (category: ProviderCategory) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SELECTED_CATEGORY_KEY, category);
  } catch { /* Keep category navigation available when storage is unavailable. */ }
};

function SortableProviderRow({
  row,
  disabled,
  dragLabel,
  isDragOver,
  children,
}: {
  row: ProviderRow;
  disabled: boolean;
  dragLabel: string;
  isDragOver: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: providerDragId(row),
    disabled,
    transition: {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    },
  });
  const renderedTransform = transform
    ? {
      ...transform,
      scaleX: isDragging ? 1.012 : transform.scaleX,
      scaleY: isDragging ? 1.012 : transform.scaleY,
    }
    : transform;
  const style: CSSProperties = {
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
    transform: DndCss.Transform.toString(renderedTransform),
    transition: isDragging ? undefined : transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`real-provider-row${isDragging ? ' dragging' : ''}${isDragOver && !isDragging ? ' drag-over' : ''}${row.disabled ? ' disabled' : ''}`}
    >
      <button
        type="button"
        className="icon-button quiet provider-drag-handle"
        disabled={disabled}
        aria-label={dragLabel}
        title={dragLabel}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} aria-hidden="true" />
      </button>
      {children}
    </article>
  );
}


export function ApiAccessPage() {
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const { t } = useI18n();
  const [records, setRecords] = useState(emptyRecords);
  const [activeCategory, setActiveCategory] = useState<ProviderCategory>(readSelectedCategory);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedback = useAppNotice();
  const { showNotice: setNotice } = feedback;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ProviderRow | null>(null);
  const [dialogDraft, setDialogDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const [apiAccessRemarks, setApiAccessRemarks] = useState<Record<string, string>>({});
  const [healthDialogRow, setHealthDialogRow] = useState<ProviderRow | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const activeDefinition = definitionFor(activeCategory);
  const activeSection = activeDefinition.section;
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadProviders = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    try {
      const responses = await Promise.allSettled(
        providerLoadDefinitions.map(async (definition) => ({
          section: definition.section,
          records: await providerGroupsApi.get(definition.section),
        })),
      );
      const failures: string[] = [];
      setRecords((current) => {
        const next = { ...current };
        responses.forEach((result, index) => {
          const definition = providerLoadDefinitions[index];
          if (result.status === 'fulfilled') {
            next[result.value.section] = result.value.records;
          } else {
            failures.push(`${providerLabel(definition)}: ${String(result.reason)}`);
          }
        });
        return next;
      });
      if (failures.length > 0) {
        setError(t('apiAccess.error.partialLoad', { errors: failures.join('; ') }));
      }
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    const providerRows = (Object.entries(records) as [ProviderSection, Record<string, unknown>[]][])
      .flatMap(([section, items]) => providerRowsFromGroups(section, items));
    if (providerRows.length === 0) {
      setApiAccessRemarks({});
      return;
    }
    let disposed = false;
    void invoke<string[]>('resolve_api_access_remarks', {
      queries: providerRows.flatMap((row) => [{
        providerSection: row.section,
        ...apiAccessRemarkLocatorFromRow(row),
      }, {
        providerSection: row.section,
        ...apiAccessRemarkLocatorFromRecord(row.section, row.source?.group ?? row.record),
      }]),
    }).then((remarks) => {
      if (disposed) return;
      setApiAccessRemarks(Object.fromEntries(providerRows.map((row, index) => [
        providerRemarkIdentity(row.section, apiAccessRemarkLocatorFromRow(row)),
        remarks[index * 2] || remarks[index * 2 + 1] || '',
      ])));
    }).catch(() => {
      if (!disposed) setApiAccessRemarks({});
    });
    return () => {
      disposed = true;
    };
  }, [records]);

  const rows = useMemo(
    () =>
      providerRowsFromGroups(activeSection, records[activeSection])
        .map((row) => ({
          ...row,
          remark: apiAccessRemarks[
            providerRemarkIdentity(row.section, apiAccessRemarkLocatorFromRow(row))
          ] ?? '',
        }))
        .filter((row) => row.category === activeCategory)
        .filter((row) => {
          const query = filter.trim().toLowerCase();
          if (!query) return true;
          return [row.remark, row.name, ...row.apiKeys, row.baseUrl, row.models.map(modelSearchText).join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(query);
        }),
    [activeCategory, activeSection, apiAccessRemarks, filter, records, t],
  );

  const openCreate = () => {
    feedback.clearNotice();
    setError('');
    setEditingRow(null);
    setDialogDraft({ ...createProviderDraft(activeCategory), ...(activeDefinition.openAi ? { groupKeys: [providerKeyDraft({ 'api-key': '' })] } : {}) });
    setDialogOpen(true);
  };

  const openEdit = (row: ProviderRow) => {
    feedback.clearNotice();
    setError('');
    setEditingRow(row);
    const draft = draftFromRow(row);
    setDialogDraft(draft);
    setDialogOpen(true);
  };

  const persistEntryRemarks = async (
    section: ProviderSection, previous: Record<string, unknown>[], next: Record<string, unknown>[],
    edited?: { row: ProviderRow; remark: string },
  ) => {
    const previousRows = providerRowsFromGroups(section, previous);
    const previousLocators = previousRows.flatMap((row) => [
      apiAccessRemarkLocatorFromRow(row), apiAccessRemarkLocatorFromRecord(section, row.source!.group),
    ]);
    const resolved = await invoke<string[]>('resolve_api_access_remarks', {
      queries: previousLocators.map((locator) => ({ providerSection: section, ...locator })),
    });
    const previousRemarks = new Map(previousRows.map((row, index) => [
      providerRemarkIdentity(section, apiAccessRemarkLocatorFromRow(row)), resolved[index * 2] || resolved[index * 2 + 1] || '',
    ]));
    const nextRows = providerRowsFromGroups(section, next);
    const allRecords = nextRows.map(apiAccessRemarkLocatorFromRow);
    const byRemark = new Map<string, ApiAccessRemarkLocator[]>();
    for (const row of nextRows) {
      const locator = apiAccessRemarkLocatorFromRow(row);
      const identity = providerRemarkIdentity(section, locator);
      const isEdited = edited && row.source?.groupIndex === edited.row.source?.groupIndex && row.source?.keyIndex === edited.row.source?.keyIndex;
      const remark = isEdited ? edited.remark : previousRemarks.get(identity) ?? '';
      byRemark.set(remark, [...(byRemark.get(remark) ?? []), locator]);
    }
    if (!byRemark.size) byRemark.set('', []);
    let first = true;
    for (const [remark, updatedRecords] of byRemark) {
      await invoke('save_api_access_remark', { update: {
        providerSection: section, previousRecords: first ? previousLocators : [],
        records: updatedRecords, allRecords, remark,
      } });
      first = false;
    }
  };

  const saveProvider = async (
    nextDraft: ProviderDraft,
  ): Promise<ProviderSaveResult> => {
    const definition = activeDefinition;
    const preparedDraft = applyProviderRemarkIdentity(
      activeCategory,
      applyProviderPreset(activeCategory, nextDraft),
    );
    const preparedDraftForSave = {
      ...preparedDraft,
      models: preparedDraft.models.filter((model) => model.name.trim()),
    };
    const baseUrlRequired = definition.openAi || definition.section === 'codex-api-key';
    const parsedApiKeys = definition.openAi
      ? (preparedDraft.groupKeys ?? []).map(({ value }) => readString(value, 'api-key').trim())
      : parseProviderApiKeys(preparedDraft.apiKey);
    if (definition.openAi && (!preparedDraft.name.trim() || preparedDraft.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(preparedDraft.name))) {
      return { saved: false, target: 'form', error: t('apiAccess.entries.nameRequired') };
    }
    const invalidKey = validateProviderGroupKeys(preparedDraft.groupKeys ?? []);
    if (invalidKey) return { saved: false, target: 'form', error: t('apiAccess.groups.invalidKey', { field: invalidKey }) };
    if (
      (!definition.openAi && parsedApiKeys.length !== 1)
      || (baseUrlRequired && !preparedDraft.baseUrl.trim())
    ) {
      return {
        saved: false,
        target: 'form',
        error: definition.openAi
          ? t('apiAccess.error.requiredAll')
          : baseUrlRequired
            ? t('apiAccess.error.requiredBaseKey')
            : t('apiAccess.error.requiredKey'),
      };
    }
    if (
      activeCategory === 'deepseek'
      && preparedDraftForSave.models.length === 0
    ) {
      return {
        saved: false,
        target: 'models',
        error: t('apiAccess.error.modelsRequired'),
      };
    }
    if (Array.from(preparedDraft.remark.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(preparedDraft.remark)) {
      return { saved: false, target: 'form', error: t('apiAccess.error.remarkInvalid') };
    }
    let baseUrl = preparedDraft.baseUrl.trim();
    let proxyUrl = preparedDraft.proxyUrl ?? '';
    let providerHeaders: Record<string, string> = {};
    try {
      if (baseUrl) baseUrl = normalizeBaseUrl(baseUrl);
      if (preparedDraft.proxyUrlEdited !== false) {
        try {
          proxyUrl = normalizeProviderProxyUrl(proxyUrl);
        } catch {
          throw new Error(t('apiAccess.error.proxyUrlInvalid'));
        }
      }
      if (baseUrlRequired && !baseUrl) throw new Error(t('apiAccess.error.baseRequired', { provider: providerLabel(definition) }));
      providerHeaders = parseProviderHeaders(preparedDraft.headersText ?? '');
    } catch (requestError) {
      return { saved: false, target: 'form', error: requestErrorMessage(requestError) };
    }
    setBusy(true);
    setError('');
    try {
      let draftToSave: ProviderDraft = { ...preparedDraftForSave, baseUrl, proxyUrl };
      if (
        definition.openAi
        && activeCategory !== 'deepseek'
        && !editingRow && draftToSave.models.length === 0
      ) {
        let fetchedModels: ModelOption[];
        try {
          fetchedModels = await fetchModels(
            'openai',
            baseUrl,
            parsedApiKeys[0],
            undefined,
            preparedDraft.groupKeys?.[0]
              ? providerHeadersFromRecord(effectiveProviderKey({ headers: providerHeaders }, serializeProviderKey(preparedDraft.groupKeys[0])))
              : providerHeaders,
            undefined,
            readString(providerDraftConnection(draftToSave, preparedDraft.groupKeys?.[0]), 'proxy-url'),
          );
          if (fetchedModels.length === 0) {
            throw new Error(t('apiAccess.error.noModels'));
          }
        } catch (requestError) {
          return {
            saved: false,
            target: 'models',
            error: requestErrorMessage(requestError),
          };
        }
        draftToSave = applyProviderPreset(activeCategory, {
          ...draftToSave,
          models: fetchedModels,
        });
      }
      const current = await providerGroupsApi.get(activeSection);
      let nextList: Record<string, unknown>[];
      const location = editingRow?.source ? locateProviderEntry(current, editingRow.source) : undefined;
      const currentRecord = editingRow?.record;
      const savedRecord = definition.openAi
        ? buildProviderGroupRecord(activeSection, draftToSave, currentRecord)
        : buildProviderKeyRecord(activeSection, draftToSave, currentRecord);
      const currentEntries = providerRowsFromGroups(activeSection, current);
      const targetIndex = location ? currentEntries.findIndex((row) => {
        return row.source?.groupIndex === location.groupIndex && row.source?.keyIndex === location.keyIndex;
      }) : -1;
      if (hasDuplicateProviderRecord(activeSection, currentEntries.map((row) => row.record), [savedRecord], targetIndex)) {
        throw new Error(t('apiAccess.error.duplicate'));
      }
      nextList = editingRow?.source
        ? updateProviderEntry(current, editingRow.source, editingRow.record, savedRecord)
        : appendProviderEntry(current, activeCategory === 'deepseek' ? 'deepseek' : activeSection, savedRecord);

      await providerGroupsApi.put(activeSection, nextList.map(stripResponseFields));
      const detached = location && nextList.length > current.length;
      const savedGroupIndex = location ? location.groupIndex + (detached ? 1 : 0) : nextList.length - 1;
      const savedKeyIndex = definition.openAi ? undefined : location && !detached ? location.keyIndex : 0;
      const savedRow = providerRowsFromGroups(activeSection, nextList).find((row) => row.source?.groupIndex === savedGroupIndex && row.source?.keyIndex === savedKeyIndex)!;
      await persistEntryRemarks(activeSection, current, nextList, { row: savedRow, remark: draftToSave.remark });
      setNotice(editingRow ? t('apiAccess.notice.updated') : t('apiAccess.notice.added'));
      await loadProviders();
      return { saved: true };
    } catch (requestError) {
      return { saved: false, target: 'form', error: requestErrorMessage(requestError) };
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: ProviderRow) => {
    if (!await askConfirmation({ title: t('common.delete'), message: t('apiAccess.deleteConfirm', { remark: row.remark || row.name }), confirmText: t('common.delete'), variant: 'danger' })) return;
    feedback.clearNotice();
    setBusy(true);
    setError('');
    try {
      const current = await providerGroupsApi.get(row.section);
      if (!row.source) throw new Error(t('apiAccess.error.stale'));
      const remainingRecords = removeProviderEntry(current, row.source);
      await providerGroupsApi.put(row.section, remainingRecords);
      await persistEntryRemarks(row.section, current, remainingRecords);
      setNotice({ key: 'apiAccess.notice.deleted' });
      await loadProviders();
    } catch (requestError) {
      setNotice(requestErrorMessage(requestError), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleProvider = async (row: ProviderRow) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const latestRows = await providerGroupsApi.get(row.section);
      if (!row.source) throw new Error(t('apiAccess.error.stale'));
      const nextRecord = providerRecordWithDisabledState(row.section, row.record, !row.disabled);
      const nextRows = updateProviderEntry(latestRows, row.source, row.record, nextRecord);
      await providerGroupsApi.put(row.section, nextRows);
      await persistEntryRemarks(row.section, latestRows, nextRows);
      await loadProviders(false);
    } catch (requestError) {
      setNotice(requestErrorMessage(requestError), 'error');
    } finally {
      setBusy(false);
    }
  };

  const reorderProviders = async (source: ProviderRow, target: ProviderRow) => {
    if (source.section !== target.section || source.index === target.index) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const latestRows = await providerGroupsApi.get(source.section);
      if (!source.source || !target.source) throw new Error(t('apiAccess.error.stale'));
      const nextRows = reorderProviderEntries(latestRows, source.section, source.source, target.source, rows.map((row) => row.source!));
      await providerGroupsApi.put(source.section, nextRows);
      await persistEntryRemarks(source.section, latestRows, nextRows);
      await loadProviders(false);
    } catch (requestError) {
      await loadProviders(false);
      setNotice(requestErrorMessage(requestError), 'error');
    } finally {
      setDragOverId(null);
      setBusy(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragOverId(null);
    const source = rows.find((row) => providerDragId(row) === String(event.active.id));
    const target = rows.find((row) => providerDragId(row) === String(event.over?.id ?? ''));
    if (!source || !target || source.index === target.index) return;

    void reorderProviders(source, target);
  };

  const countForDefinition = (definition: ProviderDefinition) =>
    providerRowsFromGroups(definition.section, records[definition.section]).filter((row) => row.category === definition.id).length;

  return (
    <section className="page management-page api-access-page">
      {confirmationDialog}
      {error ? <MessageNotice message={error} onDismiss={() => setError('')} /> : null}
      <div className="provider-workbench real-provider-workbench">
        <aside className="panel provider-category-panel">
          {providerDefinitions.map((definition) => (
            <button
              type="button"
              key={definition.id}
              className={definition.id === activeCategory ? 'active' : ''}
              aria-pressed={definition.id === activeCategory}
              onClick={() => {
                setActiveCategory(definition.id);
                writeSelectedCategory(definition.id);
                feedback.clearNotice();
              }}
              disabled={busy}
            >
              <img src={definition.icon} alt="" className="provider-logo" />
              <span title={providerLabel(definition)}>{providerLabel(definition)}</span>
              <strong>{countForDefinition(definition)}</strong>
            </button>
          ))}
        </aside>

        <section className="panel provider-resource-panel">
          <div className="management-panel-heading">
            <div>
              <h2 title={providerLabel(activeDefinition)}>{providerLabel(activeDefinition)}</h2>
              <span>{t(activeDefinition.openAi ? 'apiAccess.entries.summaryProviders' : 'apiAccess.entries.summaryKeys', { count: rows.length })}</span>
            </div>
            <div className="management-toolbar compact-toolbar api-access-search">
              <Search size={16} aria-hidden="true" />
              <input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder={t('apiAccess.search')} aria-label={t('apiAccess.search')} />
            </div>
            <div className="api-access-heading-tools">
              <button type="button" className="secondary-button compact-button" onClick={() => void loadProviders()} disabled={loading || busy}>
                <RefreshCw size={16} aria-hidden="true" />
                {t('common.refresh')}
              </button>
              <button type="button" className="primary-button compact-button" onClick={openCreate} disabled={loading || busy}>
                <Plus size={16} aria-hidden="true" />
                {t(activeDefinition.openAi ? 'apiAccess.entries.addProvider' : 'apiAccess.entries.addKey')}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('apiAccess.loading')}</div>
          ) : rows.length === 0 ? (
            <div className="management-empty">
              <Filter size={24} aria-hidden="true" />
              <strong>{filter ? t('apiAccess.empty.filtered') : t('apiAccess.empty.none')}</strong>
              <span>{filter ? t('apiAccess.empty.tryKeyword') : t('apiAccess.empty.addFirst', {
                action: t(activeDefinition.openAi ? 'apiAccess.entries.addProvider' : 'apiAccess.entries.addKey'),
              })}</span>
            </div>
          ) : (
            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              onDragStart={() => setNotice('')}
              onDragOver={({ over }) => setDragOverId(over ? String(over.id) : null)}
              onDragCancel={() => setDragOverId(null)}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rows.map(providerDragId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="real-provider-list">
                  {rows.map((row) => (
                    <SortableProviderRow
                      key={providerDragId(row)}
                      row={row}
                      disabled={busy || rows.length < 2}
                      dragLabel={t('apiAccess.dragHandle', { remark: row.remark || row.name })}
                      isDragOver={dragOverId === providerDragId(row)}
                    >
                  <div className="provider-row-main">
                    <div className="provider-row-title">
                      <strong title={row.name}>{row.name}</strong>
                      {Array.isArray(row.record.keys) && providerGroupStatus(row.record) === 'partial'
                        ? <span className="state-pill">{t('apiAccess.groups.partial')}</span>
                        : null}
                      {row.remark ? <span title={row.remark}>{row.remark}</span> : null}
                    </div>
                    <span className="provider-row-url" title={row.baseUrl || undefined}>{row.baseUrl || t('apiAccess.defaultUrl')}</span>
                    <div className="provider-row-meta">
                      <code title={t('apiAccess.keys.count', { count: row.apiKeys.length })}>
                        {row.apiKeys.length > 1
                          ? t('apiAccess.keys.summary', { key: maskSecret(row.apiKey), count: row.apiKeys.length })
                          : maskSecret(row.apiKey)}
                      </code>
                      {row.models.length > 0 ? <span className="provider-row-models">{t('apiAccess.models.summary', { count: row.models.length })}</span> : null}
                      {row.priority === null ? null : <span>{t('apiAccess.priorityValue', { priority: row.priority })}</span>}
                    </div>
                  </div>
                  <div className="provider-row-actions">
                    <button
                      type="button"
                      className="secondary-button provider-health-button"
                      onClick={() => setHealthDialogRow(row)}
                      disabled={busy}
                    >
                      {t('apiAccess.health.action')}
                    </button>
                    <label className="provider-enabled-control">
                      <span>{t(row.disabled ? 'apiAccess.status.disabled' : 'apiAccess.status.enabled')}</span>
                      <span className="switch-control">
                        <input
                          type="checkbox"
                          checked={!row.disabled}
                          onChange={() => void toggleProvider(row)}
                          disabled={busy}
                          aria-label={t('apiAccess.toggleAria', { remark: row.remark || row.name, action: row.disabled ? t('common.enable') : t('common.disable') })}
                        />
                        <span className="switch-track" />
                      </span>
                    </label>
                    <button type="button" className="icon-button quiet" onClick={() => openEdit(row)} disabled={busy} title={t('common.edit')} aria-label={t('common.edit')}>
                      <Edit3 size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => void deleteRow(row)} disabled={busy} title={t('common.delete')} aria-label={t('common.delete')}>
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                    </SortableProviderRow>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </section>
      </div>

      {dialogOpen ? (
        <ApiProviderDialog
          activeCategory={activeCategory}
          editingRow={editingRow}
          initialDraft={dialogDraft}
          busy={busy}
          onClose={() => setDialogOpen(false)}
          onSave={saveProvider}
        />
      ) : null}
      {healthDialogRow ? (
        <ProviderGroupHealthDialog
          key={providerHealthIdentity(healthDialogRow)}
          row={healthDialogRow}
          onClose={() => setHealthDialogRow(null)}
        />
      ) : null}
      <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
    </section>
  );
}

type ProviderHealthDialogProps = {
  row: ProviderRow;
  onClose: () => void;
  keySelector?: ReactNode;
};

function ProviderGroupHealthDialog({ row, onClose }: ProviderHealthDialogProps) {
  const { t } = useI18n();
  const keys = providerGroupKeys(row.record);
  const [selected, setSelected] = useState(0);
  const key = keys[selected];
  const effectiveRow = useMemo(() => {
    if (!key) return row;
    const record = effectiveProviderKey(row.record, key);
    return { ...row, record, apiKey: readString(key, 'api-key'), apiKeys: [readString(key, 'api-key')],
      authIndex: readString(key, 'auth-index', 'authIndex'), models: modelsFromRecord(record.models) };
  }, [row, key]);
  return <ProviderHealthDialog key={selected} row={effectiveRow} onClose={onClose} keySelector={keys.length ?
    <label className="provider-health-key-selector"><span>{t('apiAccess.groups.healthKey')}</span>
      <select value={selected} onChange={(event) => setSelected(Number(event.currentTarget.value))}>
        {keys.map((entry, index) => <option key={index} value={index}>{t('apiAccess.groups.keyNumber', { number: index + 1 })} · {maskSecret(readString(entry, 'api-key'))}</option>)}
      </select></label> : undefined} />;
}

type ProviderModelHealthState = { status: 'checking' } | ProviderModelHealthResult;

function ProviderHealthDialog({ row, onClose, keySelector }: ProviderHealthDialogProps) {
  const { t } = useI18n();
  const configuredModels = useMemo(
    () => mergeProviderHealthModels([], row.models),
    [row.models],
  );
  const [models, setModels] = useState<ModelOption[]>(configuredModels);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, ProviderModelHealthState>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const healthControllerRef = useRef<AbortController | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLElement>({ onEscape: onClose });

  useEffect(() => {
    const controller = new AbortController();
    healthControllerRef.current = controller;
    return () => controller.abort();
  }, []);

  const healthOptions = useMemo<ProviderHealthCheckOptions>(() => ({
    provider: row.category === 'deepseek' ? 'deepseek' : providerModelType(row.section, row.record),
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys,
    authIndex: row.authIndex,
    customHeaders: providerHeadersFromRecord(row.record),
    proxyUrl: readString(row.record, 'proxy-url'),
    timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
  }), [row]);

  useEffect(() => {
    let disposed = false;
    setModelLoading(true);
    setModelError('');
    void fetchModels(
      healthOptions.provider,
      healthOptions.baseUrl,
      row.apiKeys.find((key) => key.trim()) ?? '',
      healthOptions.authIndex,
      healthOptions.customHeaders,
      healthOptions.timeoutMs,
      healthOptions.proxyUrl,
    ).then((discovered) => {
      if (!disposed) setModels(mergeProviderHealthModels(discovered, row.models));
    }).catch((requestError) => {
      if (!disposed) setModelError(String(requestError).replace(/^Error:\s*/i, ''));
    }).finally(() => {
      if (!disposed) setModelLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [healthOptions, row.apiKeys, row.models]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => modelSearchText(model).includes(query));
  }, [models, search]);

  const resultValues = Object.values(results);
  const checkedCount = resultValues.filter((result) => result.status !== 'checking').length;
  const healthyCount = resultValues.filter((result) => result.status === 'healthy').length;
  const failedCount = resultValues.filter((result) => result.status === 'failed').length;
  const hasCheckingModel = resultValues.some((result) => result.status === 'checking');

  const saveResult = (result: ProviderModelHealthResult) => {
    setResults((current) => ({
      ...current,
      [result.model.toLowerCase()]: result,
    }));
  };

  const checkOneModel = async (model: ModelOption) => {
    const signal = healthControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    const key = model.name.toLowerCase();
    setResults((current) => ({ ...current, [key]: { status: 'checking' } }));
    const result = await checkProviderModelHealth(healthOptions, model.name);
    if (!signal.aborted) saveResult(result);
  };

  const checkAllModels = async () => {
    const signal = healthControllerRef.current?.signal;
    if (models.length === 0 || checkingAll || !signal || signal.aborted) return;
    setCheckingAll(true);
    setResults(Object.fromEntries(models.map((model) => [
      model.name.toLowerCase(),
      { status: 'checking' } satisfies ProviderModelHealthState,
    ])));
    try {
      await checkProviderModelsHealth(healthOptions, models, saveResult, undefined, signal);
    } finally {
      if (!signal.aborted) setCheckingAll(false);
    }
  };

  const statusLabel = (state: ProviderModelHealthState | undefined) => {
    if (!state) return t('apiAccess.health.notChecked');
    if (state.status === 'checking') return t('apiAccess.health.checking');
    return state.status === 'healthy'
      ? t('apiAccess.health.healthy')
      : t('apiAccess.health.failed');
  };

  return (
    <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section ref={dialogRef} className="model-discovery-dialog provider-health-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-health-title">
        <div className="model-discovery-header">
          <div>
            <h2 id="provider-health-title">{t('apiAccess.health.title')}</h2>
            <span>{t('apiAccess.health.description', { provider: row.remark || row.name })}</span>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {keySelector}
        <div className="model-discovery-search">
          <Search size={16} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t('apiAccess.health.search')} />
        </div>

        <div className="provider-health-overview">
          <p>{t('apiAccess.health.warning')}</p>
          <span>{t('apiAccess.health.summary', {
            checked: checkedCount,
            total: models.length,
            healthy: healthyCount,
            failed: failedCount,
          })}</span>
          {modelError ? (
            <MessageNotice message={t('apiAccess.health.modelLoadFailed', { error: modelError })} onDismiss={() => setModelError('')} />
          ) : modelLoading ? (
            <small>{t('apiAccess.health.loadingModels')}</small>
          ) : null}
        </div>

        <div className="model-discovery-list provider-health-model-list">
          {modelLoading && models.length === 0 ? (
            <div className="model-discovery-message"><LoaderCircle size={20} className="spin" /><strong>{t('apiAccess.health.loadingModels')}</strong></div>
          ) : visibleModels.length === 0 ? (
            <div className="model-discovery-message"><strong>{models.length ? t('apiAccess.health.noMatch') : t('apiAccess.health.noModel')}</strong></div>
          ) : visibleModels.map((model) => {
            const state = results[model.name.toLowerCase()];
            const checked = state && state.status !== 'checking' ? state : null;
            const error = checked?.status === 'failed'
              ? checked.errorCode === 'missing-direct-key'
                ? t('apiAccess.health.missingDirectKey')
                : checked.timedOut
                  ? t('apiAccess.health.timeout')
                  : checked.error || t('apiAccess.health.failed')
              : '';
            const latencyTitle = checked?.firstTokenLatencyMs !== undefined
              ? t('apiAccess.health.firstTokenLatencyResult', { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? t('apiAccess.health.responseLatencyResult', { latency: checked.responseLatencyMs })
                : error || undefined;
            const latencyInline = checked?.firstTokenLatencyMs !== undefined
              ? t('apiAccess.health.firstTokenInline', { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? t('apiAccess.health.responseInline', { latency: checked.responseLatencyMs })
                : '';
            return (
              <div className={`provider-health-model-row ${checked?.status === 'failed' ? 'failed' : ''}`} key={model.name}>
                <div className="provider-health-model-name">
                  <strong title={model.name}>{model.name}</strong>
                  {error
                    ? <small className="error" title={error}>{error}</small>
                    : model.alias || model.displayName
                      ? <small title={model.alias || model.displayName}>{model.alias || model.displayName}</small>
                      : null}
                </div>
                <span
                  className={`state-pill provider-health-pill ${state?.status === 'checking' ? 'checking' : checked?.status === 'healthy' ? 'success' : checked?.status === 'failed' ? 'error' : ''}`}
                  title={latencyTitle}
                >
                  {statusLabel(state)}
                  {latencyInline ? ` · ${latencyInline}` : ''}
                </span>
                <button
                  type="button"
                  className="secondary-button compact-button provider-health-single-button"
                  onClick={() => void checkOneModel(model)}
                  disabled={modelLoading || checkingAll || state?.status === 'checking'}
                >
                  {checked ? t('apiAccess.health.retryOne') : t('apiAccess.health.checkOne')}
                </button>
              </div>
            );
          })}
        </div>

        <div className="model-discovery-actions provider-health-actions">
          <button type="button" className="secondary-button compact-button" onClick={onClose}>{t('common.close')}</button>
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => void checkAllModels()}
            disabled={modelLoading || models.length === 0 || hasCheckingModel}
          >
            {checkingAll
              ? t('apiAccess.health.checkingProgress', { checked: checkedCount, total: models.length })
              : t('apiAccess.health.checkAll')}
          </button>
        </div>
      </section>
    </div>
  );
}

type ApiProviderDialogProps = {
  activeCategory: ProviderCategory;
  editingRow: ProviderRow | null;
  initialDraft: ProviderDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => Promise<ProviderSaveResult>;
};

export function ApiProviderDialog({
  activeCategory,
  editingRow,
  initialDraft,
  busy,
  onClose,
  onSave,
}: ApiProviderDialogProps) {
  const { t } = useI18n();
  const definition = definitionFor(activeCategory);
  const activeSection = definition.section;
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  const grouped = Boolean(draft.groupKeys);
  const [keyVisible, setKeyVisible] = useState(false);
  const [discoveryKeyId, setDiscoveryKeyId] = useState(initialDraft.groupKeys?.[0]?.id ?? '');
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [formError, setFormError] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([]);
  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [thinkingLevelInput, setThinkingLevelInput] = useState('');
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(
    () => new Set(mergeModelOptions(initialDraft.models).map((model) => model.name.toLowerCase())),
  );
  const modelCardRef = useRef<HTMLDivElement>(null);
  const discoverySelectionInitializedRef = useRef(false);
  const discoveryRequestRef = useRef(0);

  const closeModelDiscovery = useCallback(() => {
    discoveryRequestRef.current += 1;
    setModelLoading(false);
    setModelDiscoveryOpen(false);
  }, []);
  const providerDialogRef = useDialogFocusTrap<HTMLFormElement>({
    onEscape: busy ? undefined : onClose,
    preventEscape: busy,
  });
  const modelDialogRef = useDialogFocusTrap<HTMLElement>({
    active: modelDiscoveryOpen,
    onEscape: closeModelDiscovery,
  });

  useEffect(() => () => { discoveryRequestRef.current += 1; }, []);

  const modelOptions = useMemo(
    () => mergeModelOptions(discoveredModels, draft.models),
    [discoveredModels, draft.models],
  );

  const configuredModels = useMemo(
    () => draft.models.filter((model) => model.name.trim()),
    [draft.models],
  );

  const selectedModels = useMemo(() => modelOptions.filter((model) =>
    selectedModelNames.has(model.name.toLowerCase()),
  ), [modelOptions, selectedModelNames]);
  const unselectedModels = useMemo(() => modelOptions.filter((model) =>
    !selectedModelNames.has(model.name.toLowerCase()),
  ), [modelOptions, selectedModelNames]);

  const updateTextField = (
    field: 'name' | 'apiKey' | 'remark' | 'baseUrl' | 'proxyUrl' | 'priority' | 'prefix' | 'headersText' | 'excludedModelsText' | 'cloakMode' | 'cloakSensitiveWordsText',
    value: string,
  ) => {
    setFormError('');
    if (field === 'apiKey' || field === 'baseUrl' || field === 'headersText') {
      discoveryRequestRef.current += 1;
      setModelLoading(false);
      setModelError('');
    }
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === 'proxyUrl' ? { proxyUrlEdited: true, proxyUrlMixed: false } : {}),
      ...(field === 'excludedModelsText' ? { modelSelectionCatalog: undefined } : {}),
    }));
  };

  const updateBooleanField = (
    field: 'websockets' | 'cloakStrictMode',
    value: boolean,
  ) => {
    setFormError('');
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateOptionalBooleanField = (field: 'disableCooling' | 'cloakCacheUserId', value: string) => {
    setFormError('');
    setDraft((current) => ({ ...current, [field]: value === '' ? null : value === 'true' }));
  };

  const updateModels = (update: (models: ModelOption[]) => ModelOption[]) => {
    setDraft((current) => {
      const models = update(current.models);
      return {
        ...current,
        models,
        excludedModelsText: current.modelSelectionCatalog && models.some((model) => model.name.trim())
          ? exclusionsForModelSelection(current.excludedModelsText ?? '', current.modelSelectionCatalog, models)
          : current.excludedModelsText,
      };
    });
  };

  const updateModel = (index: number, patch: Partial<ModelOption>) => {
    updateModels((models) => models.map((model, modelIndex) =>
      modelIndex === index ? { ...model, ...patch } : model,
    ));
  };

  const addModel = () => {
    updateModels((models) => [...models, { name: '', alias: '' }]);
  };

  const removeModel = (index: number) => {
    updateModels((models) => models.filter((_, modelIndex) => modelIndex !== index));
  };

  const addThinkingLevel = () => {
    const level = thinkingLevelInput.trim().toLowerCase();
    if (!level) return;
    setDraft((current) => {
      const levels = current.thinkingLevels ?? [];
      if (levels.some((item) => item.toLowerCase() === level)) return current;
      return {
        ...current,
        thinkingLevels: [...levels, level],
        thinkingLevelsEdited: true,
      };
    });
    setThinkingLevelInput('');
  };

  const removeThinkingLevel = (level: string) => {
    setDraft((current) => ({
      ...current,
      thinkingLevels: (current.thinkingLevels ?? []).filter((item) => item !== level),
      thinkingLevelsEdited: true,
    }));
  };

  const discoverModels = async () => {
    const baseUrlRequired =
      activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(t('apiAccess.error.enterBaseUrl'));
      return;
    }
    const requestId = ++discoveryRequestRef.current;
    setModelLoading(true);
    setModelError('');
    try {
      const provider: ModelProvider = activeCategory === 'deepseek' ? 'deepseek' : providerModelType(definition.section);
      const selectedKey = draft.groupKeys?.find((key) => key.id === discoveryKeyId) ?? draft.groupKeys?.[0];
      const connection = selectedKey ? providerDraftConnection(draft, selectedKey) : null;
      const modelApiKey = connection ? readString(connection, 'api-key') : draft.apiKey.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? '';
      const fetchedModels = await fetchModels(
        provider,
        draft.baseUrl,
        modelApiKey,
        connection ? readString(selectedKey!.value, 'auth-index', 'authIndex') || undefined : editingRow?.authIndex,
        connection ? providerHeadersFromRecord(connection) : parseProviderHeaders(draft.headersText ?? ''),
        undefined,
        connection ? readString(connection, 'proxy-url') : draft.proxyUrl,
      );
      if (requestId !== discoveryRequestRef.current) return;
      const models = applyProviderPreset(
        activeCategory,
        { ...draft, models: fetchedModels },
      ).models;
      const initialized = discoverySelectionInitializedRef.current;
      setDiscoveredModels(models);
      setSelectedModelNames((current) =>
        initialized
          ? reconcileModelSelection(models, draft.models, current, 'refresh')
          : modelSelectionForDiscovery(draft.models, models, draft.excludedModelsText ?? ''));
      discoverySelectionInitializedRef.current = true;
      if (!models.length) setModelError(t('apiAccess.error.noAvailableModels'));
    } catch (requestError) {
      if (requestId === discoveryRequestRef.current) setModelError(requestErrorMessage(requestError));
    } finally {
      if (requestId === discoveryRequestRef.current) setModelLoading(false);
    }
  };

  const openModelDiscovery = () => {
    const baseUrlRequired =
      activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(t('apiAccess.error.baseBeforeModels'));
      return;
    }
    discoverySelectionInitializedRef.current = false;
    setSelectedModelNames(modelSelectionForDiscovery(draft.models, discoveredModels, draft.excludedModelsText ?? ''));
    setModelDiscoveryOpen(true);
    void discoverModels();
  };

  const moveModels = (models: ModelOption[], selected: boolean) => {
    discoverySelectionInitializedRef.current = true;
    setSelectedModelNames((current) => {
      const next = new Set(current);
      models.forEach((model) => {
        const key = model.name.toLowerCase();
        if (selected) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  };

  const applyModelSelection = () => {
    if (modelLoading || selectedModels.length === 0) return;
    setDraft((current) => ({
      ...current,
      models: selectedModels.flatMap((selected) => {
        const existing = current.models.filter((model) => model.name.toLowerCase() === selected.name.toLowerCase());
        return existing.length ? existing : [selected];
      }),
      modelSelectionCatalog: activeSection === 'openai-compatibility' ? undefined : discoveredModels,
      excludedModelsText: activeSection === 'openai-compatibility'
        ? current.excludedModelsText
        : exclusionsForModelSelection(
            current.excludedModelsText ?? '',
            discoveredModels,
            selectedModels,
          ),
    }));
    closeModelDiscovery();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const result = await onSave(draft);
    if (result.saved) {
      onClose();
      return;
    }
    if (result.target === 'models') {
      setModelError(result.error);
      window.requestAnimationFrame(() => {
        modelCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }
    setFormError(result.error);
  };

  const hasModelExclusions = activeSection !== 'openai-compatibility'
    && Boolean(draft.excludedModelsText?.trim());
  const modelSummaryTitle = configuredModels.length > 0
    ? t('apiAccess.models.selected', { count: configuredModels.length })
    : activeCategory === 'deepseek'
      ? t('apiAccess.models.selectionRequired')
    : hasModelExclusions
      ? t('apiAccess.models.restricted')
      : activeSection === 'openai-compatibility'
        ? t('apiAccess.models.autoAll')
        : t('apiAccess.models.upstreamDefault');
  const modelSummaryDetail = configuredModels.length > 0
    ? configuredModels.slice(0, 3).map((model) => model.name).join('、')
    : activeCategory === 'deepseek'
      ? t('apiAccess.models.selectionRequiredHint')
    : hasModelExclusions
      ? t('apiAccess.models.hiddenHint')
      : activeSection === 'openai-compatibility'
        ? t('apiAccess.models.autoHint')
        : t('apiAccess.models.allHint');

  const content = (
    <>
      <div className="config-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && onClose()}>
      <form ref={providerDialogRef} className="config-dialog management-dialog api-provider-dialog" role="dialog" aria-modal="true" aria-labelledby="api-provider-dialog-title" onSubmit={(event) => void submit(event)}>
        <div className="config-dialog-heading">
          <div>
            <Plus size={19} aria-hidden="true" />
            <h2 id="api-provider-dialog-title">{t(definition.openAi
              ? editingRow ? 'apiAccess.entries.editProvider' : 'apiAccess.entries.addProvider'
              : editingRow ? 'apiAccess.entries.editKey' : 'apiAccess.entries.addKey')}</h2>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} disabled={busy} title={t('common.close')} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <section className="provider-dialog-section">
        <h3>{t('apiAccess.entries.basic')} · {providerLabel(definition)}</h3>
        <div className="provider-dialog-basic-grid">
        {definition.openAi ? <label><span>{t('apiAccess.entries.name')}</span><input autoFocus value={draft.name} maxLength={80} onChange={(event) => updateTextField('name', event.currentTarget.value)} placeholder={t('apiAccess.entries.namePlaceholder')} /></label> : null}
        <label><span>{t('apiAccess.field.remark')}</span><input value={draft.remark} maxLength={80} onChange={(event) => updateTextField('remark', event.currentTarget.value)} placeholder={t('apiAccess.remarkPlaceholder')} /></label>
        <label><span>{t('apiAccess.field.baseUrl')}</span><input value={draft.baseUrl} onChange={(event) => updateTextField('baseUrl', event.currentTarget.value)} placeholder={activeSection === 'codex-api-key' || activeSection === 'openai-compatibility' ? t('apiAccess.baseRequiredPlaceholder') : t('apiAccess.baseOptionalPlaceholder')} /></label>
        </div>
        {!definition.openAi ? <div className="provider-dialog-secret">
          <label><span>{t('apiAccess.field.key')}</span><input autoFocus type={keyVisible ? 'text' : 'password'} autoComplete="off" spellCheck={false}
            value={draft.apiKey} onChange={(event) => updateTextField('apiKey', event.currentTarget.value)} placeholder="sk-..." /></label>
          <button type="button" className="secondary-button compact-button" aria-pressed={keyVisible} onClick={() => setKeyVisible((value) => !value)}>
            {t(keyVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
          </button>
        </div> : null}
        {draft.groupKeys ? <ProviderGroupKeysEditor keys={draft.groupKeys} disabled={busy} onChange={(groupKeys) => {
            discoveryRequestRef.current += 1; setModelLoading(false); setModelError(''); setFormError('');
            setDraft((current) => ({ ...current, groupKeys }));
          }} /> : null}
        </section>
        <div className="model-config-card" ref={modelCardRef}>
          <div className="model-config-heading">
            <div><span>{t('apiAccess.models.title')}</span><small>{t('apiAccess.models.description')}</small></div>
            <button type="button" className="secondary-button compact-button" onClick={openModelDiscovery} disabled={busy}>
              <RefreshCw size={15} />{t('apiAccess.models.fetch')}
            </button>
          </div>
          {(draft.groupKeys?.length ?? 0) > 1 ? <label><span>{t('apiAccess.entries.discoveryKey')}</span><select value={draft.groupKeys!.some((key) => key.id === discoveryKeyId) ? discoveryKeyId : draft.groupKeys![0].id}
            onChange={(event) => { discoveryRequestRef.current += 1; setModelLoading(false); setDiscoveryKeyId(event.currentTarget.value); }}>
            {draft.groupKeys!.map((key, index) => <option value={key.id} key={key.id}>{t('apiAccess.entries.keyNumber', { number: index + 1 })} · {maskSecret(readString(key.value, 'api-key'))}</option>)}
          </select></label> : null}
          <div className={`model-config-summary ${configuredModels.length || hasModelExclusions ? 'has-models' : ''}`}>
            <strong>{modelSummaryTitle}</strong>
            <span>{modelSummaryDetail}</span>
          </div>
          <div className="model-config-entries">
            {draft.models.map((model, index) => (
              <div className="provider-model-config" key={index}><div className="model-config-entry">
                <input
                  value={model.name}
                  onChange={(event) => updateModel(index, { name: event.currentTarget.value })}
                  placeholder={t('apiAccess.models.namePlaceholder')}
                  aria-label={t('apiAccess.models.namePlaceholder')}
                  disabled={busy}
                />
                <input
                  value={model.alias ?? ''}
                  onChange={(event) => updateModel(index, { alias: event.currentTarget.value })}
                  placeholder={t('apiAccess.models.aliasPlaceholder')}
                  aria-label={t('apiAccess.models.aliasPlaceholder')}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-button quiet danger"
                  onClick={() => removeModel(index)}
                  disabled={busy}
                  title={t('apiAccess.models.remove')}
                  aria-label={t('apiAccess.models.remove')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
                <ProviderModelFields section={activeSection} value={model.config ?? { ...(model.thinking ? { thinking: model.thinking } : {}) }} onChange={(config) => updateModel(index, { config, thinking: isRecord(config.thinking) ? config.thinking : undefined })} />
              </div>
            ))}
            <button type="button" className="secondary-button compact-button model-config-add" onClick={addModel} disabled={busy}>
              <Plus size={14} />{t('apiAccess.models.add')}
            </button>
          </div>
          {modelError && !modelDiscoveryOpen ? <MessageNotice message={modelError} onDismiss={() => setModelError('')} /> : null}
        </div>
        <details className="provider-advanced-settings">
          <summary>{t('apiAccess.advanced')}</summary>
          <div className="provider-advanced-fields">
            <AdvancedSettingsGroup title={providerText('modelRules')}>
            <label><span>{t('apiAccess.field.prefix')}</span><input value={draft.prefix ?? ''} onChange={(event) => updateTextField('prefix', event.currentTarget.value)} placeholder={t('apiAccess.prefixPlaceholder')} /></label>
            {activeSection !== 'openai-compatibility' ? (
              <label className="multiline-field">
                <span>{t('apiAccess.field.excludedModels')}</span>
                <textarea value={draft.excludedModelsText ?? ''} onChange={(event) => updateTextField('excludedModelsText', event.currentTarget.value)} rows={3} placeholder={'model-old-*\nmodel-preview'} />
              </label>
            ) : null}
        {activeCategory === 'openai-compatibility' ? (
          <div className="thinking-level-config">
            <div className="thinking-level-heading">
              <strong>{t('apiAccess.thinking.title')}</strong>
              <span>{t('apiAccess.thinking.description')}</span>
            </div>
            <div className="thinking-level-entry">
              <input
                value={thinkingLevelInput}
                onChange={(event) => setThinkingLevelInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addThinkingLevel();
                  }
                }}
                placeholder={t('apiAccess.thinking.placeholder')}
              />
              <button type="button" className="secondary-button compact-button" onClick={addThinkingLevel} disabled={!thinkingLevelInput.trim()}>
                <Plus size={14} />{t('apiAccess.thinking.add')}
              </button>
            </div>
            {(draft.thinkingLevels?.length ?? 0) > 0 ? (
              <div className="thinking-level-tags">
                {draft.thinkingLevels?.map((level) => (
                  <span key={level}>
                    {level}
                    <button type="button" onClick={() => removeThinkingLevel(level)} title={t('apiAccess.thinking.delete', { level })} aria-label={t('apiAccess.thinking.deleteAria', { level })}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : <small className="thinking-level-empty">{t('apiAccess.thinking.empty')}</small>}
            </div>
        ) : null}
            </AdvancedSettingsGroup>
            <AdvancedSettingsGroup title={providerText('connectionRouting')}>
            <label><span>{t('apiAccess.field.priority')}</span><input type="number" step="1" value={draft.priority} onChange={(event) => updateTextField('priority', event.currentTarget.value)} placeholder={t('common.optional')} /></label>
            {!definition.openAi ? <>
              <label><span>{t('apiAccess.field.proxyUrl')}</span><input value={draft.proxyUrl ?? ''} onChange={(event) => updateTextField('proxyUrl', event.currentTarget.value)} placeholder="socks5://127.0.0.1:1080" /></label>
              <label><span>{t('apiAccess.entries.weight')}</span><input type="number" step="1" max="1000000" value={draft.weight ?? ''} placeholder="1" onChange={(event) => { const weight = event.currentTarget.value; setDraft((current) => ({ ...current, weight })); }} /></label>
            </> : null}
            </AdvancedSettingsGroup>
            <AdvancedSettingsGroup title={providerText('requestBehavior')}>
            {!definition.openAi ? <ProviderKeyTemplateFields section={activeSection} value={draft.templateFields ?? {}} inherited={{}} onChange={(templateFields) => setDraft((current) => ({ ...current, templateFields }))} /> : null}
            <ProviderGroupTemplateFields section={activeSection} includeErrors={definition.openAi} value={draft.templateFields ?? {}} onChange={(templateFields) => setDraft((current) => ({ ...current, templateFields }))} />
            <label className="multiline-field">
              <span>{t('apiAccess.field.headers')}</span>
              <textarea value={draft.headersText ?? ''} onChange={(event) => updateTextField('headersText', event.currentTarget.value)} rows={3} placeholder={'X-Team: production\nAuthorization: Bearer ...'} />
              <small>{providerText('headersHint')}</small>
            </label>
            {!grouped && activeSection === 'claude-api-key' ? (
              <div className="provider-cloak-settings">
                <label>
                  <span>{t('apiAccess.cloak.mode')}</span>
                  <select value={draft.cloakMode ?? ''} onChange={(event) => updateTextField('cloakMode', event.currentTarget.value)}>
                    <option value="">{t('apiAccess.cloak.default')}</option>
                    <option value="auto">{t('apiAccess.cloak.auto')}</option>
                    <option value="always">{t('apiAccess.cloak.always')}</option>
                    <option value="never">{t('apiAccess.cloak.never')}</option>
                  </select>
                </label>
                <label className="multiline-field">
                  <span>{t('apiAccess.cloak.words')}</span>
                  <textarea value={draft.cloakSensitiveWordsText ?? ''} onChange={(event) => updateTextField('cloakSensitiveWordsText', event.currentTarget.value)} rows={3} placeholder={'internal-name\nworkspace-id'} />
                </label>
                <div className="provider-advanced-toggle">
                  <div><strong>{t('apiAccess.cloak.strict')}</strong><span>{t('apiAccess.cloak.strictDescription')}</span></div>
                  <label className="switch-control" title={t('apiAccess.cloak.enableStrict')}><input type="checkbox" checked={Boolean(draft.cloakStrictMode)} onChange={(event) => updateBooleanField('cloakStrictMode', event.currentTarget.checked)} /><span className="switch-track" /></label>
                </div>
                <div className="provider-advanced-toggle">
                  <div><strong>{t('apiAccess.cloak.cacheUser')}</strong><span>{t('apiAccess.cloak.cacheUserDescription')}</span></div>
                  <select aria-label={t('apiAccess.cloak.cacheUser')} value={draft.cloakCacheUserId == null ? '' : String(draft.cloakCacheUserId)} onChange={(event) => updateOptionalBooleanField('cloakCacheUserId', event.currentTarget.value)}>
                    <option value="">{t('apiAccess.option.inherit')}</option>
                    <option value="true">{t('common.enabled')}</option>
                    <option value="false">{t('common.disabled')}</option>
                  </select>
                </div>
              </div>
            ) : null}
            {!grouped && (activeSection === 'codex-api-key' || activeSection === 'xai-api-key') ? (
              <div className="provider-advanced-toggle">
                <div><strong>WebSocket</strong><span>{t('apiAccess.websocket.description')}</span></div>
                <label className="switch-control" title={t('apiAccess.websocket.enable')}><input type="checkbox" checked={Boolean(draft.websockets)} onChange={(event) => updateBooleanField('websockets', event.currentTarget.checked)} /><span className="switch-track" /></label>
              </div>
            ) : null}
            <div className="provider-advanced-toggle">
              <div><strong>{t('apiAccess.cooling.title')}</strong><span>{t('apiAccess.cooling.description')}</span></div>
              <select aria-label={t('apiAccess.cooling.title')} value={draft.disableCooling == null ? '' : String(draft.disableCooling)} onChange={(event) => updateOptionalBooleanField('disableCooling', event.currentTarget.value)}>
                <option value="">{t('apiAccess.option.inherit')}</option>
                <option value="true">{t('apiAccess.cooling.disable')}</option>
                <option value="false">{t('apiAccess.cooling.enable')}</option>
              </select>
            </div>
            </AdvancedSettingsGroup>
          </div>
        </details>
        {formError ? (
          <MessageNotice message={formError} onDismiss={() => setFormError('')} />
        ) : null}
        <div className="config-dialog-actions two-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>
        </div>
      </form>
      </div>

      {modelDiscoveryOpen ? (
        <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && closeModelDiscovery()}>
          <section ref={modelDialogRef} className="model-discovery-dialog model-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="model-discovery-title">
            <div className="model-discovery-header">
              <div><h2 id="model-discovery-title">{t('apiAccess.modelDialog.title')}</h2><span>{providerLabel(definition)}</span></div>
              <button type="button" className="icon-button quiet" onClick={closeModelDiscovery} title={t('common.close')} aria-label={t('common.close')}><X size={18} aria-hidden="true" /></button>
            </div>

            <div className="model-transfer-summary">
              <span role="status">{t('apiAccess.modelDialog.summary', { found: modelOptions.length, selected: selectedModels.length })}</span>
              <button type="button" className="secondary-button compact-button" onClick={() => void discoverModels()} disabled={modelLoading}>
                <RefreshCw size={15} className={modelLoading ? 'spin' : ''} />{t('common.refresh')}
              </button>
            </div>

            {modelError ? (
              <MessageNotice source="apiAccess.modelDialog.fetchFailed" message={modelError} onDismiss={() => setModelError('')} />
            ) : null}

            <div className="model-transfer-panels">
              <ModelSelectionPanel models={unselectedModels} selected={false} loading={modelLoading} onMove={moveModels} />
              <ModelSelectionPanel models={selectedModels} selected loading={modelLoading} onMove={moveModels} />
            </div>

            <div className="model-discovery-actions model-transfer-actions">
              {selectedModels.length === 0 ? <span>{t('apiAccess.modelDialog.chooseOne')}</span> : null}
              <button type="button" className="secondary-button" onClick={closeModelDiscovery}>{t('common.cancel')}</button>
              <button type="button" className="primary-button" onClick={applyModelSelection} disabled={modelLoading || selectedModels.length === 0}>{t('apiAccess.modelDialog.apply', { count: selectedModels.length })}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
  // Keep both dialogs outside the page's query container, which can contain fixed elements in WebKit.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
