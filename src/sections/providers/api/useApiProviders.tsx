import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '../../../services/documentTarget';
import { useI18n } from '../../../i18n';
import { FloatingNotice, useAppNotice } from '../../../appNotice';
import { ConfirmDialog } from '../../../ui';
import { readString } from '../../../services/managementApi';
import { fetchModels, normalizeBaseUrl, type ModelOption } from '../../../services/modelService';
import { normalizeProviderProxyUrl } from '../../../services/providerProxy';
import {
  effectiveProviderKey, providerKeyDraft, serializeProviderKey, validateProviderGroupKeys,
} from '../../../services/providerGroups';
import {
  appendProviderEntry, locateProviderEntry, removeProviderEntry, reorderProviderEntries, updateProviderEntry,
} from '../../../services/providerEntries';
import { providerGroupsApi } from '../../../services/managementApi';
import { API_KINDS, brandOfKind } from './kinds';
import { quickCheckRow, type ApiHealth, type QuickCheck } from './health';
import {
  type ApiAccessRemarkLocator, type ProviderCategory, type ProviderDraft, type ProviderRow, type ProviderSaveResult,
  type ProviderSection,
  apiAccessRemarkLocatorFromRecord, apiAccessRemarkLocatorFromRow, applyProviderPreset, applyProviderRemarkIdentity,
  buildProviderGroupRecord, buildProviderKeyRecord, createProviderDraft, definitionFor, draftFromRow,
  emptyRecords, hasDuplicateProviderRecord, parseProviderApiKeys, parseProviderHeaders, providerDraftConnection,
  providerHeadersFromRecord, providerHealthIdentity, providerLabel, providerLoadDefinitions, providerRecordWithDisabledState,
  providerRemarkIdentity, providerRowsFromGroups, requestErrorMessage, stripResponseFields,
} from './logic';
import { ApiProviderForm } from './ApiProviderForm';
import { CheckAllDialog, ProviderHealthDialog, type CheckAllItem } from './HealthDialogs';

/** A provider config row (or one key of a native key group) as the Providers section shows it. */
export type ApiRow = ProviderRow & {
  kind: ProviderCategory;
  brand: string;
  health?: ApiHealth;
};

export type ApiProvidersController = {
  loading: boolean;
  error: string;
  busy: boolean;
  rows: ApiRow[];
  countByBrand: Record<string, number>;
  reload(): Promise<void>;
  openCreate(kindId: ProviderCategory): void;
  openEdit(row: ApiRow): void;
  toggle(row: ApiRow): Promise<void>;
  /** Asks for confirmation (dialog rendered in `dialogs`), then deletes. */
  remove(row: ApiRow): void;
  /** Opens the per-model health dialog of one config. */
  checkHealth(row: ApiRow): void;
  /** Probes every enabled config (of `brand`, or all) with one minimal request each and shows a results dialog. */
  checkAllHealth(brand?: string): void;
  /** Drag reorder inside one kind. */
  reorder(source: ApiRow, target: ApiRow): Promise<void>;
  /** Render once per page. */
  dialogs: ReactNode;
};

type FormState = { kind: ProviderCategory; editingRow: ApiRow | null; draft: ProviderDraft };

const rowKey = (row: ProviderRow) => providerHealthIdentity(row);

export function useApiProviders(): ApiProvidersController {
  const { t } = useI18n();
  const [records, setRecords] = useState(emptyRecords);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedback = useAppNotice();
  const { showNotice: setNotice } = feedback;
  const [form, setForm] = useState<FormState | null>(null);
  const [apiAccessRemarks, setApiAccessRemarks] = useState<Record<string, string>>({});
  const [healthRow, setHealthRow] = useState<ApiRow | null>(null);
  const [health, setHealth] = useState<Record<string, ApiHealth>>({});
  const [pendingDelete, setPendingDelete] = useState<ApiRow | null>(null);
  const [checkAll, setCheckAll] = useState<{ items: CheckAllItem[]; running: boolean } | null>(null);
  const checkAllRun = useRef(0);
  const loadRun = useRef(0);
  // Synchronous re-entrancy guard for the write actions: `busy` state lags a rapid second click by a render.
  const writing = useRef(false);

  const loadProviders = useCallback(async (showLoading = true) => {
    // Only the latest load may publish: an older, slower response must not overwrite newer records.
    const run = ++loadRun.current;
    if (showLoading) setLoading(true);
    setError('');
    try {
      const responses = await Promise.allSettled(
        providerLoadDefinitions.map(async (definition) => ({
          section: definition.section,
          records: await providerGroupsApi.get(definition.section),
        })),
      );
      // Failures are collected outside the state updater: the updater runs later, so reading them right after
      // setRecords (as the old page did) usually saw an empty list and the partial-load error never showed.
      if (run !== loadRun.current) return;
      const failures: string[] = [];
      const loaded = new Map<ProviderSection, Record<string, unknown>[]>();
      responses.forEach((result, index) => {
        const definition = providerLoadDefinitions[index];
        if (result.status === 'fulfilled') loaded.set(result.value.section, result.value.records);
        else failures.push(`${providerLabel(definition)}: ${String(result.reason).replace(/^Error:\s*/i, '')}`);
      });
      setRecords((current) => {
        const next = { ...current };
        loaded.forEach((sectionRecords, section) => { next[section] = sectionRecords; });
        return next;
      });
      if (loaded.size === 0 && failures.length > 0) {
        // Everything failed (core down, bad key): one distinct message instead of the same error per kind.
        setError([...new Set(failures.map((failure) => failure.replace(/^[^:]*:\s*/, '')))].join('; '));
      } else if (failures.length > 0) {
        setError(t('apiAccess.error.partialLoad', { errors: failures.join('; ') }));
      }
    } catch (requestError) {
      if (run === loadRun.current) setError(String(requestError));
    } finally {
      if (run === loadRun.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Rows of every kind, in kind display order (what the old page showed one category at a time).
  const rows = useMemo<ApiRow[]>(() => {
    const result: ApiRow[] = [];
    const seen = new Set<ProviderSection>();
    for (const definition of providerLoadDefinitions) {
      if (seen.has(definition.section)) continue;
      seen.add(definition.section);
      for (const row of providerRowsFromGroups(definition.section, records[definition.section])) {
        const kind = row.category ?? definition.section;
        result.push({
          ...row,
          kind,
          brand: brandOfKind(kind),
          remark: apiAccessRemarks[providerRemarkIdentity(row.section, apiAccessRemarkLocatorFromRow(row))] ?? '',
          health: health[rowKey(row)],
        });
      }
    }
    // Stable kind order (Codex, OpenAI-compatible, DeepSeek, Claude, Gemini, ...): the category order of the old page.
    const order = API_KINDS.map((kind) => kind.id);
    return result.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
  }, [apiAccessRemarks, health, records]);

  const countByBrand = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.brand] = (counts[row.brand] ?? 0) + 1;
    return counts;
  }, [rows]);

  const openCreate = (kind: ProviderCategory) => {
    feedback.clearNotice();
    setError('');
    setForm({
      kind,
      editingRow: null,
      draft: {
        ...createProviderDraft(kind),
        ...(definitionFor(kind).openAi ? { groupKeys: [providerKeyDraft({ 'api-key': '' })] } : {}),
      },
    });
  };

  const openEdit = (row: ApiRow) => {
    feedback.clearNotice();
    setError('');
    setForm({ kind: row.kind, editingRow: row, draft: draftFromRow(row) });
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
    activeCategory: ProviderCategory,
    editingRow: ApiRow | null,
    nextDraft: ProviderDraft,
  ): Promise<ProviderSaveResult> => {
    const definition = definitionFor(activeCategory);
    const activeSection = definition.section;
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
    if (writing.current) return { saved: false, target: 'form', error: '' };
    writing.current = true;
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
      writing.current = false;
      setBusy(false);
    }
  };

  const deleteRow = async (row: ApiRow) => {
    if (writing.current) return;
    writing.current = true;
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
      writing.current = false;
      setBusy(false);
    }
  };

  const toggleProvider = async (row: ApiRow) => {
    if (writing.current) return;
    writing.current = true;
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
      writing.current = false;
      setBusy(false);
    }
  };

  const reorderProviders = async (source: ApiRow, target: ApiRow) => {
    if (writing.current || source.section !== target.section || source.kind !== target.kind || source.index === target.index) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const latestRows = await providerGroupsApi.get(source.section);
      if (!source.source || !target.source) throw new Error(t('apiAccess.error.stale'));
      const scope = rows.filter((row) => row.kind === source.kind).map((row) => row.source!);
      const nextRows = reorderProviderEntries(latestRows, source.section, source.source, target.source, scope);
      await providerGroupsApi.put(source.section, nextRows);
      await persistEntryRemarks(source.section, latestRows, nextRows);
      await loadProviders(false);
    } catch (requestError) {
      await loadProviders(false);
      setNotice(requestErrorMessage(requestError), 'error');
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const setRowHealth = useCallback((row: ProviderRow, value: ApiHealth | undefined) => {
    setHealth((current) => {
      const key = rowKey(row);
      if (value === undefined) {
        const { [key]: _removed, ...rest } = current;
        return rest;
      }
      return current[key] === value ? current : { ...current, [key]: value };
    });
  }, []);

  const runCheckAll = (brand?: string) => {
    const targets = rows.filter((row) => !row.disabled && (!brand || row.brand === brand));
    const run = ++checkAllRun.current;
    const items: CheckAllItem[] = targets.map((row) => ({ row, state: 'checking' }));
    setCheckAll({ items, running: targets.length > 0 });
    targets.forEach((row) => setRowHealth(row, 'checking'));
    let next = 0;
    const settle = (index: number, outcome: QuickCheck | { status: 'error'; message: string }) => {
      if (run !== checkAllRun.current) return;
      const row = targets[index];
      const state: CheckAllItem['state'] = outcome.status === 'skipped' ? 'skipped' : outcome.status;
      setRowHealth(row, outcome.status === 'skipped' ? undefined : outcome.status);
      setCheckAll((current) => {
        if (!current || run !== checkAllRun.current) return current;
        const updated = current.items.map((item, itemIndex) => itemIndex === index ? {
          row: item.row,
          state,
          model: 'model' in outcome ? outcome.model : undefined,
          result: 'result' in outcome ? outcome.result : undefined,
          message: 'message' in outcome ? outcome.message : 'error' in outcome ? outcome.error : undefined,
        } satisfies CheckAllItem : item);
        return { items: updated, running: updated.some((item) => item.state === 'checking') };
      });
    };
    const worker = async () => {
      while (next < targets.length && run === checkAllRun.current) {
        const index = next++;
        try {
          settle(index, await quickCheckRow(targets[index]));
        } catch (checkError) {
          settle(index, { status: 'error', message: requestErrorMessage(checkError) });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  };

  const closeCheckAll = () => {
    checkAllRun.current += 1;
    setCheckAll(null);
    setHealth((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== 'checking')));
  };

  const dialogs = (
    <>
      {form ? (
        <ApiProviderForm
          kind={form.kind}
          editingRow={form.editingRow}
          initialDraft={form.draft}
          busy={busy}
          onClose={() => setForm(null)}
          onSave={(draft) => saveProvider(form.kind, form.editingRow, draft)}
        />
      ) : null}
      {healthRow ? (
        <ProviderHealthDialog
          key={providerHealthIdentity(healthRow)}
          row={healthRow}
          onClose={() => setHealthRow(null)}
          onSummary={(summary) => setRowHealth(healthRow, summary)}
        />
      ) : null}
      {checkAll ? (
        <CheckAllDialog
          items={checkAll.items}
          running={checkAll.running}
          onClose={closeCheckAll}
          onDetails={(row) => {
            closeCheckAll();
            setHealthRow(row as ApiRow);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t('common.delete')}
        message={pendingDelete ? t('apiAccess.deleteConfirm', { remark: pendingDelete.remark || pendingDelete.name }) : undefined}
        confirmLabel={t('common.delete')}
        danger
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const row = pendingDelete;
          setPendingDelete(null);
          if (row) void deleteRow(row);
        }}
      />
      <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
    </>
  );

  return {
    loading,
    error,
    busy,
    rows,
    countByBrand,
    reload: () => loadProviders(),
    openCreate,
    openEdit,
    toggle: toggleProvider,
    remove: (row) => setPendingDelete(row),
    checkHealth: (row) => setHealthRow(row),
    checkAllHealth: runCheckAll,
    reorder: reorderProviders,
    dialogs,
  };
}
