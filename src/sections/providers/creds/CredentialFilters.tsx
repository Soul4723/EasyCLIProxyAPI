import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { FilterChips, SearchInput, providerInfo, statusColor, type FilterOption } from '../../../ui';
import {
  CREDENTIAL_STATUSES,
  filterCredentials,
  providerFilterCounts,
  statusFilterCounts,
  type CredentialFilterValue,
  type CredentialStatusFilter,
} from './model';
import type { CredentialsCore } from './useCredentials';
import './creds.css';

export type CredentialFiltersProps = {
  controller: Pick<CredentialsCore, 'rows'>;
  value: CredentialFilterValue;
  onChange: (next: CredentialFilterValue) => void;
  /** Hide the provider chips (single-provider page). */
  hideProvider?: boolean;
};

/** Search + provider chips with counts + status chips (incl. a "Problems" bucket). Chip counts follow the other filters. */
export function CredentialFilters({ controller, value, onChange, hideProvider = false }: CredentialFiltersProps) {
  const { t } = useI18n();
  const set = (patch: Partial<CredentialFilterValue>) => onChange({ ...value, ...patch });

  const providerOptions = useMemo<FilterOption<string>[]>(() => {
    // Counts respect the search text and status so the numbers match what the list will show.
    const scoped = filterCredentials(controller.rows, { query: value.query, status: value.status });
    return [
      { value: 'all', label: t('ui.filter.all'), count: scoped.length },
      ...providerFilterCounts(scoped).map(({ provider, count }) => ({
        value: provider, label: providerInfo(provider).name, count, color: providerInfo(provider).colorVar,
      })),
    ];
  }, [controller.rows, value.query, value.status, t]);

  const statusOptions = useMemo<FilterOption<CredentialStatusFilter>[]>(() => {
    const scoped = filterCredentials(controller.rows, { query: value.query, provider: value.provider });
    const counts = statusFilterCounts(scoped);
    const labels = {
      available: t('sec.providers.creds.status.available'),
      cooldown: t('sec.providers.creds.status.cooldown'),
      disabled: t('sec.providers.creds.status.disabled'),
      expired: t('sec.providers.creds.status.expired'),
      error: t('sec.providers.creds.status.error'),
    } as const;
    return [
      { value: 'all', label: t('ui.filter.all'), count: counts.all },
      ...(counts.problems > 0 ? [{ value: 'problems' as const, label: t('sec.providers.creds.status.problems'), count: counts.problems }] : []),
      ...CREDENTIAL_STATUSES.filter((status) => counts[status] > 0 || value.status === status).map((status) => ({
        value: status, label: labels[status], count: counts[status], color: statusColor(status),
      })),
    ];
  }, [controller.rows, value.query, value.provider, value.status, t]);

  // Nothing to filter yet (first load, empty list, load error): the list shows its own state.
  if (controller.rows.length === 0 && !value.query) return null;

  return (
    <div className="ec-cred-filters">
      <div className="ec-cred-filters__search">
        <SearchInput value={value.query} onChange={(query) => set({ query })} placeholder={t('authFiles.searchPlaceholder')} />
      </div>
      {hideProvider ? null : (
        <FilterChips<string> ariaLabel={t('authFiles.filter.allProviders')} value={value.provider}
          onChange={(provider) => set({ provider })} options={providerOptions} />
      )}
      <FilterChips<CredentialStatusFilter> ariaLabel={t('authFiles.filter.allStatuses')} value={value.status}
        onChange={(status) => set({ status })} options={statusOptions} />
    </div>
  );
}
