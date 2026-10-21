import { useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { modelSearchText, type ModelOption } from '../../../services/modelService';
import { Button, Dialog, IconButton, SearchInput } from '../../../ui';
import { ErrorLine } from './fields';

/** One side of the transfer: filterable list; clicking a row (or "add all") moves models to the other side. */
function ModelPanel({ models, selected, loading, onMove }: {
  models: ModelOption[];
  selected: boolean;
  loading: boolean;
  onMove: (models: ModelOption[], selected: boolean) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const query = search.trim().toLowerCase();
  const visible = useMemo(() => models.filter((model) => modelSearchText(model).includes(query)), [models, query]);
  const searchLabel = t(selected ? 'apiAccess.modelDialog.searchSelected' : 'apiAccess.modelDialog.searchUnselected');
  return (
    <section className="ec-api-transfer__panel" aria-labelledby={titleId} aria-busy={loading}>
      <header className="ec-api-transfer__head">
        <h3 id={titleId}>{t(selected ? 'apiAccess.modelDialog.selected' : 'apiAccess.modelDialog.unselected')}</h3>
        <span className="ec-api-transfer__count ec-num">{query ? `${visible.length} / ${models.length}` : models.length}</span>
        <Button size="xs" disabled={loading || visible.length === 0} onClick={() => onMove(visible, !selected)}>
          {t(selected
            ? query ? 'apiAccess.modelDialog.removeResults' : 'apiAccess.modelDialog.removeAll'
            : query ? 'apiAccess.modelDialog.addResults' : 'apiAccess.modelDialog.addAll')}
        </Button>
      </header>
      <SearchInput value={search} onChange={setSearch} placeholder={searchLabel} ariaLabel={searchLabel} />
      <div className="ec-api-transfer__list" ref={listRef}>
        {visible.length ? visible.map((model) => (
          <button
            type="button"
            className="ec-api-transfer__row"
            key={model.name}
            disabled={loading}
            aria-label={t(selected ? 'apiAccess.modelDialog.removeModel' : 'apiAccess.modelDialog.addModel', { name: model.name })}
            onClick={(event) => {
              if (event.detail === 0) {
                const next = event.currentTarget.nextElementSibling ?? event.currentTarget.previousElementSibling;
                if (next instanceof HTMLElement) next.focus();
              }
              onMove([model], !selected);
            }}
          >
            <span className="ec-api-transfer__name">
              <strong title={model.name}>{model.name}</strong>
              {model.alias || model.displayName ? <small title={model.alias || model.displayName}>{model.alias || model.displayName}</small> : null}
            </span>
            {selected ? <X size={14} aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
          </button>
        )) : (
          <div className="ec-api-transfer__empty">
            {t(query ? 'apiAccess.modelDialog.noMatch' : loading ? 'apiAccess.modelDialog.fetching' : selected ? 'apiAccess.modelDialog.emptySelected' : 'apiAccess.modelDialog.emptyUnselected')}
          </div>
        )}
      </div>
    </section>
  );
}

/** Model discovery: models found upstream on the left, the ones this config will expose on the right. */
export function ModelTransferDialog({ providerLabel, found, unselected, selected, loading, error, onMove, onRefresh, onApply, onClose, onDismissError }: {
  providerLabel: string;
  found: number;
  unselected: ModelOption[];
  selected: ModelOption[];
  loading: boolean;
  error: string;
  onMove: (models: ModelOption[], selected: boolean) => void;
  onRefresh: () => void;
  onApply: () => void;
  onClose: () => void;
  onDismissError: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={<>{t('apiAccess.modelDialog.title')} <span className="ec-api-subtitle">{providerLabel}</span></>}
      footer={(
        <>
          {selected.length === 0 ? <span className="ec-api-footer-note">{t('apiAccess.modelDialog.chooseOne')}</span> : null}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={onApply} disabled={loading || selected.length === 0}>
            {t('apiAccess.modelDialog.apply', { count: selected.length })}
          </Button>
        </>
      )}
    >
      <div className="ec-api-transfer">
        <div className="ec-api-transfer__summary">
          <span role="status">{t('apiAccess.modelDialog.summary', { found, selected: selected.length })}</span>
          <IconButton size="sm" label={t('common.refresh')} icon={<RefreshCw size={14} className={loading ? 'ec-api-spin' : undefined} />} onClick={onRefresh} disabled={loading} />
        </div>
        {error ? <ErrorLine title={t('apiAccess.modelDialog.fetchFailed')} message={error} onDismiss={onDismissError} /> : null}
        <div className="ec-api-transfer__panels">
          <ModelPanel models={unselected} selected={false} loading={loading} onMove={onMove} />
          <ModelPanel models={selected} selected loading={loading} onMove={onMove} />
        </div>
      </div>
    </Dialog>
  );
}
