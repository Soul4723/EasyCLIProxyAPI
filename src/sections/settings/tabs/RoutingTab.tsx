import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Route } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { templateMessages, templateText } from '../../../i18n/templateConfig';
import { TemplateConfigSection } from '../../../components/TemplateConfigSection';
import { allSettingsTemplateGroups, settingsTemplateGroups } from '../../../services/settingsNavigation';
import { ErrorState, SegmentedControl, Skeleton, Toggle } from '../../../ui';
import { useCoreConfig, type CoreConfigSettings } from '../coreConfig';
import { SaveBar, SettingRow, SettingsGroup, useDraft, useReportDirty } from '../ui';
import './RoutingTab.css';

type Strategy = 'round-robin' | 'weighted-round-robin' | 'fill-first';
type RoutingDraft = {
  affinity: boolean;
  ttl: string;
  coolingEnabled: boolean;
  requestRetry: string;
  maxRetryCredentials: string;
  maxRetryInterval: string;
  streamingBootstrapRetries: string;
};
type RetryKey = 'requestRetry' | 'maxRetryCredentials' | 'maxRetryInterval' | 'streamingBootstrapRetries';

const toDraft = (settings: CoreConfigSettings): RoutingDraft => ({
  affinity: settings.routingSessionAffinity,
  ttl: settings.routingSessionAffinityTtl,
  coolingEnabled: !settings.disableCooling,
  requestRetry: String(settings.requestRetry),
  maxRetryCredentials: String(settings.maxRetryCredentials),
  maxRetryInterval: String(settings.maxRetryInterval),
  streamingBootstrapRetries: String(settings.streamingBootstrapRetries),
});
const sameDraft = (a: RoutingDraft, b: RoutingDraft) => JSON.stringify({ ...a, ttl: a.ttl.trim() }) === JSON.stringify({ ...b, ttl: b.ttl.trim() });
const sessionKeys = ['affinity', 'ttl'] as const;
const retryKeys = ['coolingEnabled', 'requestRetry', 'maxRetryCredentials', 'maxRetryInterval', 'streamingBootstrapRetries'] as const;
const routingGroupIds = settingsTemplateGroups.routing.map((group) => group.id);

export function RoutingTab() {
  const { t, locale } = useI18n();
  const { settings, loading, error, reload, apply } = useCoreConfig();
  const saved = useMemo(() => (settings ? toDraft(settings) : null), [settings]);
  const { draft, setDraft, reset } = useDraft<RoutingDraft>(saved, sameDraft);
  const [pendingStrategy, setPendingStrategy] = useState<Strategy | null>(null);
  const [strategyError, setStrategyError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [retryInvalid, setRetryInvalid] = useState(false);
  const [templateDirty, setTemplateDirty] = useState<readonly string[]>([]);
  const onTemplateDirty = useCallback((ids: readonly string[]) => setTemplateDirty(ids.filter((id) => routingGroupIds.includes(id))), []);

  const changed = (keys: readonly (keyof RoutingDraft)[]) => (draft && saved ? keys.filter((key) => (key === 'ttl' ? draft.ttl.trim() !== saved.ttl : draft[key] !== saved[key])) : []);
  const sessionDirty = changed(sessionKeys).length > 0;
  const retryDirty = changed(retryKeys).length > 0;
  const count = changed([...sessionKeys, ...retryKeys]).length;
  useReportDirty('routing', count > 0 || templateDirty.length > 0);

  const edit = (patch: Partial<RoutingDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setJustSaved(false); setSaveError(''); setRetryInvalid(false);
  };
  const editNumber = (key: RetryKey, raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 10);
    edit({ [key]: key === 'maxRetryInterval' && raw.startsWith('-') ? `-${digits}` : digits });
  };

  if (error && !settings) return <ErrorState title={t('sec.settings.routing.loadFailed')} message={error} onRetry={() => void reload()} />;
  if (loading && !settings || !settings || !draft) return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={5} /></div>;

  const strategy = (pendingStrategy ?? settings.routingStrategy) as Strategy;
  const changeStrategy = async (next: Strategy) => {
    if (next === settings.routingStrategy || busy || pendingStrategy) return;
    setPendingStrategy(next); setStrategyError('');
    try {
      apply(await invoke<CoreConfigSettings>('set_core_routing_strategy', { strategy: next }));
    } catch (cause) {
      setStrategyError(t('config.error.saveFailed', { error: String(cause) }));
      void reload();
    } finally { setPendingStrategy(null); }
  };

  const save = async () => {
    if (busy) return;
    setSaveError(''); setRetryInvalid(false);
    if (retryDirty) {
      const values = [draft.requestRetry, draft.maxRetryCredentials, draft.maxRetryInterval, draft.streamingBootstrapRetries];
      const numbers = values.map(Number);
      if (values.some((value) => value.length === 0)
        || numbers.some((value, index) => !Number.isInteger(value) || value < (index === 2 ? -2147483648 : 0) || value > (index === 2 ? 2147483647 : 4294967295))) {
        setRetryInvalid(true); setSaveError(t('sec.settings.routing.retryRange'));
        return;
      }
    }
    setBusy(true);
    try {
      if (sessionDirty) {
        apply(await invoke<CoreConfigSettings>('save_session_routing_settings', {
          settings: { routingSessionAffinity: draft.affinity, routingSessionAffinityTtl: draft.ttl.trim() },
        }));
      }
      if (retryDirty) {
        const [requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries] = [draft.requestRetry, draft.maxRetryCredentials, draft.maxRetryInterval, draft.streamingBootstrapRetries].map(Number);
        apply(await invoke<CoreConfigSettings>('save_retry_settings', {
          settings: { disableCooling: !draft.coolingEnabled, requestRetry, maxRetryCredentials, maxRetryInterval, streamingBootstrapRetries },
        }));
      }
      setJustSaved(true);
    } catch (cause) {
      setSaveError(t('config.error.saveFailed', { error: String(cause) }));
      void reload();
    } finally { setBusy(false); }
  };

  const numberRow = (key: RetryKey, label: string, hint: string) => (
    <SettingRow label={label} hint={hint} htmlFor={`routing-${key}`}>
      <input
        id={`routing-${key}`}
        className="ec-set-input is-short"
        type="text"
        inputMode="numeric"
        maxLength={key === 'maxRetryInterval' ? 11 : 10}
        value={draft[key]}
        disabled={busy}
        aria-invalid={retryInvalid || undefined}
        onChange={(event) => editNumber(key, event.currentTarget.value)}
      />
    </SettingRow>
  );

  return (
    <div className="ec-routing">
      <SettingsGroup title={t('sec.settings.routing.groupSelect')} icon={<Route size={16} />}>
        <div id="routing-strategy" className="ec-routing-anchor">
          <SettingRow label={t('config.routing.title')} hint={t('sec.settings.routing.strategyHint')} effect="instant" error={strategyError || undefined}>
            <SegmentedControl<Strategy>
              ariaLabel={t('config.routing.title')}
              value={strategy}
              onChange={(next) => void changeStrategy(next)}
              options={[
                { value: 'round-robin', label: t('config.routing.roundRobin'), title: 'round-robin' },
                { value: 'weighted-round-robin', label: templateText(templateMessages.weighted, locale), title: 'weighted-round-robin' },
                { value: 'fill-first', label: t('config.routing.fillFirst'), title: 'fill-first' },
              ]}
            />
          </SettingRow>
        </div>
        <SettingRow label={t('config.network.sessionAffinity')} hint={t('config.network.sessionAffinityHint')}>
          <Toggle checked={draft.affinity} label={t('config.network.sessionAffinity')} disabled={busy} onChange={(next) => edit({ affinity: next })} />
        </SettingRow>
        <SettingRow label={t('config.network.sessionTtl')} hint={t('config.network.sessionTtlHint')} htmlFor="routing-ttl">
          <input
            id="routing-ttl"
            className="ec-set-input is-short"
            type="text"
            value={draft.ttl}
            disabled={busy}
            placeholder={t('sec.settings.routing.ttlPlaceholder')}
            onChange={(event) => edit({ ttl: event.currentTarget.value })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('sec.settings.routing.groupRetry')} icon={<RefreshCw size={16} />}>
        <SettingRow label={t('config.network.enableCooling')} hint={t('config.network.enableCoolingHint')}>
          <Toggle checked={draft.coolingEnabled} label={t('config.network.enableCooling')} disabled={busy} onChange={(next) => edit({ coolingEnabled: next })} />
        </SettingRow>
        {numberRow('requestRetry', t('config.network.requestRetry'), templateText(templateMessages.retryHint, locale))}
        {numberRow('maxRetryCredentials', t('config.network.maxRetryCredentials'), templateText(templateMessages.credentialsHint, locale))}
        {numberRow('maxRetryInterval', t('config.network.maxRetryInterval'), templateText(templateMessages.waitHint, locale))}
        {numberRow('streamingBootstrapRetries', t('config.network.streamingBootstrapRetries'), t('config.network.streamingBootstrapRetriesHint'))}
      </SettingsGroup>

      <SaveBar
        count={count}
        busy={busy}
        error={saveError}
        saved={justSaved}
        onSave={() => void save()}
        onDiscard={() => { reset(); setSaveError(''); setRetryInvalid(false); setJustSaved(false); }}
      />

      <div className="ec-routing-more">
        <TemplateConfigSection groups={allSettingsTemplateGroups} visibleGroups={routingGroupIds} onDirtyGroupsChange={onTemplateDirty} />
      </div>
    </div>
  );
}
