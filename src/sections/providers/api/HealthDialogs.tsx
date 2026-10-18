import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CircleAlert } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { maskSecret, readString } from '../../../services/managementApi';
import { modelSearchText, type ModelOption } from '../../../services/modelService';
import {
  checkProviderModelHealth,
  checkProviderModelsHealth,
  mergeProviderHealthModels,
  type ProviderModelHealthResult,
} from '../../../services/providerHealthCheck';
import { providerGroupKeys } from '../../../services/providerGroups';
import { Button, Dialog, Masked, ProviderLogo, SearchInput, Skeleton, StatusPill } from '../../../ui';
import { discoverHealthModels, healthOptionsFor, healthRowForKey, type ApiHealth } from './health';
import type { ProviderRow } from './logic';
import { SelectInput } from './fields';
import { brandOfKind } from './kinds';

type ModelHealthState = { status: 'checking' } | ProviderModelHealthResult;

const failureText = (t: ReturnType<typeof useI18n>['t'], result: ProviderModelHealthResult) =>
  result.errorCode === 'missing-direct-key'
    ? t('apiAccess.health.missingDirectKey')
    : result.timedOut
      ? t('apiAccess.health.timeout')
      : result.error || t('apiAccess.health.failed');

function ResultPill({ state }: { state: ModelHealthState | undefined }) {
  const { t } = useI18n();
  if (!state) return <span className="ec-api-notchecked">{t('apiAccess.health.notChecked')}</span>;
  if (state.status === 'checking') return <StatusPill size="sm" status="cooldown" label={t('apiAccess.health.checking')} />;
  const latency = state.firstTokenLatencyMs !== undefined
    ? t('apiAccess.health.firstTokenInline', { latency: state.firstTokenLatencyMs })
    : state.responseLatencyMs !== undefined
      ? t('apiAccess.health.responseInline', { latency: state.responseLatencyMs })
      : '';
  return state.status === 'healthy'
    ? <StatusPill size="sm" status="available" label={`${t('apiAccess.health.healthy')}${latency ? ` · ${latency}` : ''}`} />
    : <StatusPill size="sm" status="error" label={t('apiAccess.health.failed')} />;
}

/** Per-model health of one config: model list (configured + upstream), check one / check all. */
export function ProviderHealthDialog({ row: baseRow, onClose, onSummary }: {
  row: ProviderRow;
  onClose: () => void;
  onSummary: (health: ApiHealth | undefined) => void;
}) {
  const { t } = useI18n();
  const keys = providerGroupKeys(baseRow.record);
  const [selectedKey, setSelectedKey] = useState(0);
  const row = useMemo(() => healthRowForKey(baseRow, selectedKey), [baseRow, selectedKey]);
  const configuredModels = useMemo(() => mergeProviderHealthModels([], row.models), [row.models]);
  const [models, setModels] = useState<ModelOption[]>(configuredModels);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, ModelHealthState>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const options = useMemo(() => healthOptionsFor(row), [row]);

  // A different key of a group is a different upstream identity: start from a clean slate
  // and stop any probe batch of the previous one, as closing the dialog does.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setResults({});
    setCheckingAll(false);
    setModels(configuredModels);
    let disposed = false;
    setModelLoading(true);
    setModelError('');
    discoverHealthModels(row).then((discovered) => {
      if (!disposed) setModels(discovered);
    }).catch((requestError) => {
      if (!disposed) setModelError(String(requestError).replace(/^Error:\s*/i, ''));
    }).finally(() => {
      if (!disposed) setModelLoading(false);
    });
    return () => {
      disposed = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? models.filter((model) => modelSearchText(model).includes(query)) : models;
  }, [models, search]);

  const values = Object.values(results);
  const checkedCount = values.filter((result) => result.status !== 'checking').length;
  const healthyCount = values.filter((result) => result.status === 'healthy').length;
  const failedCount = values.filter((result) => result.status === 'failed').length;
  const hasChecking = values.some((result) => result.status === 'checking');

  // The list pill follows the dialog: any failure = error, otherwise healthy once something passed.
  useEffect(() => {
    if (hasChecking) return;
    if (failedCount > 0) onSummary('error');
    else if (healthyCount > 0) onSummary('ok');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedCount, healthyCount, hasChecking]);

  const saveResult = (result: ProviderModelHealthResult) => {
    setResults((current) => ({ ...current, [result.model.toLowerCase()]: result }));
  };

  const checkOne = async (model: ModelOption) => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    setResults((current) => ({ ...current, [model.name.toLowerCase()]: { status: 'checking' } }));
    const result = await checkProviderModelHealth(options, model.name);
    if (!signal.aborted) saveResult(result);
  };

  const checkAll = async () => {
    const signal = controllerRef.current?.signal;
    if (models.length === 0 || checkingAll || !signal || signal.aborted) return;
    setCheckingAll(true);
    setResults(Object.fromEntries(models.map((model) => [model.name.toLowerCase(), { status: 'checking' } satisfies ModelHealthState])));
    try {
      await checkProviderModelsHealth(options, models, saveResult, undefined, signal);
    } finally {
      if (!signal.aborted) setCheckingAll(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={(
        <span className="ec-api-form-title">
          <Activity size={16} aria-hidden="true" />
          <span>{t('apiAccess.health.title')}</span>
          <span className="ec-api-subtitle">{baseRow.remark || baseRow.name}</span>
        </span>
      )}
      footer={(
        <>
          <span className="ec-api-footer-note">{t('sec.providers.api.health.cost')}</span>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" onClick={() => void checkAll()} disabled={modelLoading || models.length === 0 || hasChecking}
            loading={checkingAll}>
            {checkingAll
              ? t('apiAccess.health.checkingProgress', { checked: checkedCount, total: models.length })
              : t('apiAccess.health.checkAll')}
          </Button>
        </>
      )}
    >
      <div className="ec-api-health">
        {keys.length ? (
          <label className="ec-api-field">
            <span className="ec-api-field__label">{t('apiAccess.groups.healthKey')}</span>
            <SelectInput value={selectedKey} onChange={(event) => setSelectedKey(Number(event.currentTarget.value))}>
              {keys.map((entry, index) => (
                <option key={index} value={index}>{t('apiAccess.groups.keyNumber', { number: index + 1 })} · {maskSecret(readString(entry, 'api-key'))}</option>
              ))}
            </SelectInput>
          </label>
        ) : null}
        <div className="ec-api-health__bar">
          <SearchInput value={search} onChange={setSearch} placeholder={t('apiAccess.health.search')} />
          <span className="ec-api-health__summary ec-num">
            {t('apiAccess.health.summary', { checked: checkedCount, total: models.length, healthy: healthyCount, failed: failedCount })}
          </span>
        </div>
        {modelError ? (
          <p className="ec-api-error" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{t('apiAccess.health.modelLoadFailed', { error: modelError })}</span></p>
        ) : null}
        <div className="ec-api-health__list">
          {modelLoading && models.length === 0 ? (
            <div className="ec-api-health__loading" aria-busy="true"><Skeleton lines={3} height={14} /></div>
          ) : visibleModels.length === 0 ? (
            <div className="ec-api-transfer__empty">{models.length ? t('apiAccess.health.noMatch') : t('apiAccess.health.noModel')}</div>
          ) : visibleModels.map((model) => {
            const state = results[model.name.toLowerCase()];
            const checked = state && state.status !== 'checking' ? state : null;
            const error = checked?.status === 'failed' ? failureText(t, checked) : '';
            return (
              <div className={`ec-api-health__row${checked?.status === 'failed' ? ' is-failed' : ''}`} key={model.name}>
                <div className="ec-api-health__name">
                  <strong title={model.name}>{model.name}</strong>
                  {error ? <small className="is-error" title={error}>{error}</small>
                    : model.alias || model.displayName ? <small title={model.alias || model.displayName}>{model.alias || model.displayName}</small> : null}
                </div>
                <ResultPill state={state} />
                <Button size="xs" onClick={() => void checkOne(model)} disabled={modelLoading || checkingAll || state?.status === 'checking'}>
                  {checked ? t('apiAccess.health.retryOne') : t('apiAccess.health.checkOne')}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}

export type CheckAllItem = {
  row: ProviderRow;
  state: 'checking' | 'ok' | 'error' | 'skipped';
  model?: string;
  result?: ProviderModelHealthResult;
  message?: string;
};

/** Results of "check all": one line per enabled config with its probe model, latency or error. */
export function CheckAllDialog({ items, running, onClose, onDetails }: {
  items: CheckAllItem[];
  running: boolean;
  onClose: () => void;
  onDetails: (row: ProviderRow) => void;
}) {
  const { t } = useI18n();
  const ok = items.filter((item) => item.state === 'ok').length;
  const failed = items.filter((item) => item.state === 'error').length;
  const skipped = items.filter((item) => item.state === 'skipped').length;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={(
        <span className="ec-api-form-title">
          <Activity size={16} aria-hidden="true" />
          <span>{t('sec.providers.api.bulk.title')}</span>
        </span>
      )}
      footer={(
        <>
          <span className="ec-api-footer-note">{t('sec.providers.api.health.cost')}</span>
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </>
      )}
    >
      <div className="ec-api-health">
        <div className="ec-api-health__bar">
          <span className="ec-api-health__summary ec-num">
            {running ? t('sec.providers.api.bulk.running', { done: items.length - items.filter((item) => item.state === 'checking').length, total: items.length })
              : t('sec.providers.api.bulk.summary', { ok, failed, skipped })}
          </span>
        </div>
        <div className="ec-api-health__list">
          {items.length === 0 ? <div className="ec-api-transfer__empty">{t('sec.providers.api.bulk.none')}</div> : null}
          {items.map(({ row, state, model, result, message }) => {
            const key = `${row.section}:${row.index}:${row.name}:${row.apiKey}`;
            const error = state === 'error' && result ? failureText(t, result) : state === 'error' ? message : state === 'skipped' ? message || t('apiAccess.health.noModel') : '';
            return (
              <div className={`ec-api-health__row${state === 'error' ? ' is-failed' : ''}`} key={key}>
                <ProviderLogo provider={brandOfKind(row.category ?? row.section)} size={20} />
                <div className="ec-api-health__name">
                  <strong title={row.remark || row.name}><Masked value={row.remark || row.name} /></strong>
                  {error ? <small className="is-error" title={error}>{error}</small>
                    : model ? <small>{t('sec.providers.api.bulk.via', { model })}</small> : null}
                </div>
                {state === 'checking' ? <StatusPill size="sm" status="cooldown" label={t('apiAccess.health.checking')} />
                  : state === 'ok' ? <ResultPill state={result} />
                    : state === 'error' ? <StatusPill size="sm" status="error" label={t('apiAccess.health.failed')} />
                      : <span className="ec-api-notchecked">{t('sec.providers.api.bulk.skipped')}</span>}
                <Button size="xs" onClick={() => onDetails(row)}>{t('sec.providers.api.bulk.details')}</Button>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
