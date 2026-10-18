import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, Square, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { checkCoreModelsHealth, type CoreHealthModel, type CoreModelHealthResult } from '../../services/coreHealthCheck';
import { Button, Chip, Dialog, EmptyState, SearchInput } from '../../ui';

export type HealthDialogProps = {
  open: boolean;
  onClose: () => void;
  models: CoreHealthModel[];
  ready: boolean;
  /** Changes when the core target changes, which invalidates earlier results. */
  contextKey: string;
};

type Checked = CoreModelHealthResult & { at: number };

/** Core health check: sends one tiny request per exposed model through the core (core_health_probe) and lists the results. */
export function HealthDialog({ open, onClose, models, ready, contextKey }: HealthDialogProps) {
  const { t, formatNumber } = useI18n();
  const [results, setResults] = useState<Record<string, Checked>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    setResults({});
    setRunning(new Set());
  }, [contextKey]);
  useEffect(() => () => controller.current?.abort(), []);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter((model) => `${model.name} ${model.displayName ?? ''}`.toLowerCase().includes(query));
  }, [models, search]);

  const run = async (targets: CoreHealthModel[]) => {
    if (controller.current || targets.length === 0) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(new Set(targets.map((model) => model.name)));
    try {
      await checkCoreModelsHealth(targets, (result) => {
        if (abort.signal.aborted) return;
        setResults((current) => ({ ...current, [result.model]: { ...result, at: Date.now() } }));
        setRunning((current) => { const next = new Set(current); next.delete(result.model); return next; });
      }, abort.signal);
    } finally {
      if (controller.current === abort) controller.current = null;
      setRunning(new Set());
    }
  };
  const stop = () => { controller.current?.abort(); controller.current = null; setRunning(new Set()); };
  const busy = running.size > 0;
  const healthy = Object.values(results).filter((result) => result.success).length;
  const failed = Object.values(results).filter((result) => !result.success).length;
  const close = () => { stop(); onClose(); };

  return (
    <Dialog open={open} onClose={close} size="lg" title={t('sec.overview.healthCheck')}
      footer={busy
        ? <Button variant="secondary" icon={<Square size={13} />} onClick={stop}>{t('sec.overview.healthStop')}</Button>
        : <Button variant="primary" icon={<Play size={13} />} disabled={!ready || models.length === 0} onClick={() => void run(models)}>{t('sec.overview.healthAll')}</Button>}
    >
      <div className="ov-health">
        <div className="ov-health__bar">
          <SearchInput value={search} onChange={setSearch} ariaLabel={t('sec.overview.healthSearch')} placeholder={t('sec.overview.healthSearch')} />
          <Chip tone="ok" size="sm">{`${healthy} ✓`}</Chip>
          <Chip tone={failed ? 'danger' : 'neutral'} size="sm">{`${failed} ✗`}</Chip>
        </div>
        {!ready ? (
          <EmptyState compact title={t('sec.overview.healthOffline')} />
        ) : models.length === 0 ? (
          <EmptyState compact title={t('sec.overview.healthNoModels')} />
        ) : (
          <table className="ov-health__table">
            <thead><tr><th>{t('sec.overview.healthModel')}</th><th>{t('sec.overview.healthResult')}</th><th>{t('sec.overview.healthLatency')}</th><th /></tr></thead>
            <tbody>
              {visible.map((model) => {
                const result = results[model.name];
                const checking = running.has(model.name);
                return (
                  <tr key={model.name} data-model={model.name}>
                    <td className="ec-mono ec-trunc" title={model.name}>{model.name}</td>
                    <td>
                      {checking ? <LoaderCircle size={13} className="ec-spin" aria-label={t('sec.overview.healthChecking')} />
                        : !result ? <span className="ov-muted">—</span>
                          : result.success ? <span className="ov-ok"><Check size={13} aria-hidden="true" /> {t('sec.overview.healthOk')}</span>
                            : <span className="ov-bad" title={result.error}><X size={13} aria-hidden="true" /> {result.timedOut ? t('sec.overview.healthTimeout') : t('sec.overview.healthFailed')}</span>}
                    </td>
                    <td className="ec-num">{result?.success && result.responseLatencyMs !== undefined ? `${formatNumber(result.responseLatencyMs)} ms` : '—'}</td>
                    <td><Button size="xs" variant="ghost" disabled={busy} onClick={() => void run([model])}>{t('sec.overview.healthOne')}</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
