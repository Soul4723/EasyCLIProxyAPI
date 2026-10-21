import { useMemo, useState } from 'react';
import { Cpu } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Card, Chip, EmptyState, ErrorState, FilterChips, Masked, SearchInput, Skeleton } from '../../ui';
import { routeHref } from '../../shell/router';
import { ClientLogo } from './ClientLogo';
import { clientState, clientVersion } from './clientState';
import { agentDefinitions } from './model';
import type { AgentsController } from './useAgentsController';

type Filter = 'all' | 'connected' | 'detected' | 'notInstalled';

/** Client grid: one card per supported client (logo, version, state chip, applied model). Click opens the client's detail. */
export function AgentsGrid({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const rows = useMemo(() => agentDefinitions.map((definition) => {
    const status = ctl.statuses.find((item) => item.id === definition.id);
    return { definition, status, state: clientState(definition, status) };
  }), [ctl.statuses]);
  const counts = {
    all: rows.length,
    connected: rows.filter((row) => row.state.kind === 'connected' || row.state.kind === 'nativeOauth').length,
    detected: rows.filter((row) => row.state.detected).length,
    notInstalled: rows.filter((row) => !row.state.detected).length,
  };
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (filter === 'connected' && !(row.state.kind === 'connected' || row.state.kind === 'nativeOauth')) return false;
    if (filter === 'detected' && !row.state.detected) return false;
    if (filter === 'notInstalled' && row.state.detected) return false;
    return !needle || row.definition.name.toLowerCase().includes(needle);
  });
  const firstLoad = ctl.loading && ctl.statuses.length === 0;
  return (
    <div className="ag-grid-page">
      <div className="ag-toolbar">
        <FilterChips<Filter> ariaLabel={t('sec.agents.filter.label')} value={filter} onChange={setFilter} options={[
          { value: 'all', label: t('sec.agents.filter.all'), count: counts.all },
          { value: 'connected', label: t('sec.agents.filter.connected'), count: counts.connected },
          { value: 'detected', label: t('sec.agents.filter.detected'), count: counts.detected },
          { value: 'notInstalled', label: t('sec.agents.filter.notInstalled'), count: counts.notInstalled },
        ]} />
        <div className="ag-toolbar-search">
          <SearchInput value={query} onChange={setQuery} placeholder={t('sec.agents.search')} />
        </div>
      </div>
      {ctl.detectionError ? (
        <ErrorState title={t('sec.agents.grid.error')} message={<Masked value={ctl.detectionError} />} onRetry={() => void ctl.refresh()} />
      ) : null}
      {firstLoad ? (
        <div className="ag-grid" aria-busy="true">
          {agentDefinitions.slice(0, 8).map((definition) => (
            <Card key={definition.id}><Skeleton lines={3} /></Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={<Cpu size={20} />} title={t('sec.agents.grid.empty')} />
      ) : (
        <ul className="ag-grid" aria-label={t('sec.agents.tab.clients')}>
          {visible.map(({ definition, status, state }) => {
            const model = status?.currentModel ?? status?.appliedModel ?? null;
            const version = clientVersion(status);
            const running = definition.id === 'deepseek-harness' && ctl.deepSeekHarnessProcessStatus.running;
            return (
              <li key={definition.id}>
                <a className="ag-card" href={routeHref('agents', null, { client: definition.id })}
                  data-client={definition.id} data-state={state.kind}
                  aria-label={`${definition.name} — ${t(state.labelKey)}`}>
                  <Card interactive className={state.detected ? undefined : 'ag-card--dim'}>
                    <div className="ag-card-head">
                      <ClientLogo definition={definition} size={36} />
                      <div className="ag-card-title">
                        <strong className="ec-trunc">{definition.name}</strong>
                        <span className="ec-mono ec-muted ec-trunc">{version ?? '—'}</span>
                      </div>
                    </div>
                    <div className="ag-card-chips">
                      <Chip tone={state.tone} size="sm">{t(state.labelKey)}</Chip>
                      {running ? <Chip tone="ok" size="sm">{t('sec.agents.card.running')}</Chip> : null}
                    </div>
                    <div className={`ag-card-model ec-mono${model ? '' : ' ec-muted'}`} title={model ?? undefined}>
                      <span className="ec-trunc">{model ?? (state.detected ? t('sec.agents.card.noModel') : t('sec.agents.card.install'))}</span>
                    </div>
                  </Card>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
