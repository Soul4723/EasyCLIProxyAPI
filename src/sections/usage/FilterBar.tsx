import { X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { Button, Chip } from '../../ui';
import { providerInfo } from '../../ui/providers';
import { FilterSelect } from './FilterSelect';
import { useUsage } from './UsageContext';

/** One filter bar shared by Overview and Requests: model · agent · source · key · result (+ provider when deep-linked). */
export function FilterBar() {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const { filters, setFilter, resetFilters, activeFilterCount, options } = useUsage();
  const named = (items: { key: string; label: string }[]) => items.filter((i) => i.key && i.label);
  const sources = [...(options.upstreams ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="usage-filterbar" role="group" aria-label={t('sec.usage.filter.result')}>
      <FilterSelect ariaLabel={t('sec.usage.filter.model')} value={filters.model} onChange={(v) => setFilter('model', v)}
        options={[{ value: '', label: t('sec.usage.filter.allModels') }, ...named(options.models).map((m) => ({ value: m.key, label: m.label }))]} />
      <FilterSelect ariaLabel={t('sec.usage.filter.agent')} value={filters.agent} onChange={(v) => setFilter('agent', v)}
        options={[{ value: '', label: t('sec.usage.filter.allAgents') }, { value: 'codex', label: 'Codex' }, { value: 'claude-code', label: 'Claude Code' },
          { value: 'gemini-cli', label: 'Gemini CLI' }, { value: 'unknown', label: t('sec.usage.agent.unknown') }]} />
      <FilterSelect ariaLabel={t('sec.usage.filter.source')} value={filters.source} onChange={(v) => setFilter('source', v)}
        options={[{ value: '', label: t('sec.usage.filter.allSources') }, ...sources.map((s) => ({ value: s.key, label: mask.text(s.label) }))]} />
      <FilterSelect ariaLabel={t('sec.usage.filter.key')} value={filters.apiKeyHash} onChange={(v) => setFilter('apiKeyHash', v)}
        options={[{ value: '', label: t('sec.usage.filter.allKeys') }, ...named(options.apiKeys).map((k) => ({ value: k.key, label: mask.text(k.label) }))]} />
      <FilterSelect ariaLabel={t('sec.usage.filter.result')} value={filters.result} onChange={(v) => setFilter('result', v as typeof filters.result)}
        options={[{ value: 'all', label: t('sec.usage.filter.allResults') }, { value: 'success', label: t('sec.usage.result.success') },
          { value: 'failed', label: t('sec.usage.result.failed') }, { value: 'canceled', label: t('sec.usage.result.canceled') }]} />
      {filters.provider ? (
        <Chip tone="accent" onRemove={() => setFilter('provider', '')} removeLabel={t('sec.usage.filter.reset')}>{providerInfo(filters.provider).name}</Chip>
      ) : null}
      {filters.source ? (
        <Chip tone="accent" onRemove={() => setFilter('source', '')} removeLabel={t('sec.usage.filter.reset')}>
          {mask.text(sources.find((x) => x.key === filters.source)?.label ?? filters.source.replace(/^(auth|provider):/, ''))}
        </Chip>
      ) : null}
      {filters.range === 'custom' ? (
        <span className="usage-custom-range">
          <input type="datetime-local" value={filters.customStart} aria-label={t('sec.usage.filter.start')} onChange={(e) => setFilter('customStart', e.currentTarget.value)} />
          <span>{t('sec.usage.filter.to')}</span>
          <input type="datetime-local" value={filters.customEnd} aria-label={t('sec.usage.filter.end')} onChange={(e) => setFilter('customEnd', e.currentTarget.value)} />
        </span>
      ) : null}
      {activeFilterCount > 0 ? (
        <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={resetFilters}>{t('sec.usage.filter.reset')}</Button>
      ) : null}
    </div>
  );
}
