import { useEffect, useMemo, useState } from 'react';
import { invoke } from '../../services/usageApi';
import { Eye } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usagePreferences } from '../../services/usagePreferences';
import { Button, Chip, Dialog, SegmentedControl } from '../../ui';
import type { ModelPrice, ModelPriceSyncPreview, ModelPriceSyncResult, UsagePriceRow, UsageQuery } from './types';
import './Prices.css';

export const SYNC_SOURCE_KEY = 'cpa-gui.pricing-sync-source.v1';
type SyncSource = 'models-dev' | 'litellm';
const FIELDS = ['prompt', 'completion', 'cacheRead', 'cacheCreation'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, 'sec.usage.prices.col.prompt' | 'sec.usage.prices.col.completion' | 'sec.usage.prices.col.cacheRead' | 'sec.usage.prices.col.cacheWrite'> = {
  prompt: 'sec.usage.prices.col.prompt',
  completion: 'sec.usage.prices.col.completion',
  cacheRead: 'sec.usage.prices.col.cacheRead',
  cacheCreation: 'sec.usage.prices.col.cacheWrite',
};
const CONFIGURED: Record<Field, keyof ModelPrice> = {
  prompt: 'promptConfigured',
  completion: 'completionConfigured',
  cacheRead: 'cacheReadConfigured',
  cacheCreation: 'cacheCreationConfigured',
};

export type PriceDraft = { model: string; prompt: string; completion: string; cacheRead: string; cacheCreation: string };
export const emptyDraft = (): PriceDraft => ({ model: '', prompt: '', completion: '', cacheRead: '', cacheCreation: '' });
/** Edit drafts start from the configured fields only; an unconfigured field stays blank. */
export const draftFor = (model: string, price: ModelPrice | null): PriceDraft => {
  const draft = { ...emptyDraft(), model };
  if (price) for (const field of FIELDS) if (price[CONFIGURED[field]]) draft[field] = String(price[field]);
  return draft;
};

const parsePrice = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const validOptional = (value: string) => value.trim() === '' || (Number.isFinite(Number(value)) && Number(value) >= 0);

/** Add / edit one model price (model is read-only on edit). Saves with the same payload as the old Price Statistics tab. */
export function PriceEditorDialog({ draft, isEdit, onClose, onSaved }: {
  draft: PriceDraft | null;
  isEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<PriceDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (draft) { setValues(draft); setError(''); setBusy(false); }
  }, [draft]);

  const save = async () => {
    if (!values.model.trim()) { setError(t('sec.usage.prices.editor.modelRequired')); return; }
    if (!FIELDS.every((field) => validOptional(values[field]))) { setError(t('sec.usage.prices.editor.invalid')); return; }
    setBusy(true);
    setError('');
    try {
      await invoke('save_usage_model_price', {
        price: {
          model: values.model.trim(),
          prompt: parsePrice(values.prompt),
          completion: parsePrice(values.completion),
          cacheRead: parsePrice(values.cacheRead),
          cacheCreation: parsePrice(values.cacheCreation),
          promptConfigured: values.prompt.trim() !== '',
          completionConfigured: values.completion.trim() !== '',
          cacheReadConfigured: values.cacheRead.trim() !== '',
          cacheCreationConfigured: values.cacheCreation.trim() !== '',
          source: 'manual',
          sourceModelId: '',
          updatedAtMs: 0,
        } satisfies ModelPrice,
      });
      onSaved();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={draft !== null}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={t(isEdit ? 'sec.usage.prices.editor.editTitle' : 'sec.usage.prices.editor.addTitle')}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>{t('common.save')}</Button>
      </>}
    >
      <form className="prices-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="prices-field prices-field--wide">
          <span>{t('sec.usage.prices.editor.model')}</span>
          <input
            className="prices-input ec-mono"
            value={values.model}
            readOnly={isEdit}
            autoFocus={!isEdit}
            onChange={(event) => setValues({ ...values, model: event.currentTarget.value })}
          />
        </label>
        {FIELDS.map((field) => (
          <label className="prices-field" key={field}>
            <span>{t(FIELD_LABEL[field])} <small>{t('sec.usage.prices.perMillion')}</small></span>
            <input
              className="prices-input ec-num"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={values[field]}
              placeholder={field === 'cacheRead' || field === 'cacheCreation' ? '—' : undefined}
              title={field === 'cacheRead' || field === 'cacheCreation' ? t('sec.usage.prices.editor.optional') : undefined}
              autoFocus={isEdit && field === 'prompt'}
              onChange={(event) => setValues({ ...values, [field]: event.currentTarget.value })}
            />
          </label>
        ))}
        {error ? <p className="prices-error" role="alert">{error}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

type SyncDraft = { selected: boolean; price: ModelPrice; manual: boolean } & Record<Field, string>;

const SOURCES: { value: SyncSource; label: string }[] = [
  { value: 'models-dev', label: 'Models.dev' },
  { value: 'litellm', label: 'LiteLLM' },
];

/** Price sync: pick a source, preview matches, tweak and apply the selected ones. */
export function PriceSyncDialog({ open, query, rows, onClose, onApplied }: {
  open: boolean;
  query: UsageQuery;
  rows: UsagePriceRow[];
  onClose: () => void;
  onApplied: (imported: number) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<SyncSource>(() => {
    try { return usagePreferences.getItem(SYNC_SOURCE_KEY) === 'litellm' ? 'litellm' : 'models-dev'; } catch { return 'models-dev'; }
  });
  const [preview, setPreview] = useState<ModelPriceSyncPreview | null>(null);
  const [drafts, setDrafts] = useState<SyncDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) { setPreview(null); setDrafts([]); setError(''); setLoading(false); setApplying(false); }
  }, [open]);

  const changeSource = (next: SyncSource) => {
    setSource(next);
    try { usagePreferences.setItem(SYNC_SOURCE_KEY, next); } catch { /* preference only */ }
  };

  const runPreview = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await invoke<ModelPriceSyncPreview>('preview_usage_model_prices', { query, source });
      const existing = new Map(rows.map((row) => [row.model.toLowerCase(), row.price]));
      setPreview(result);
      setDrafts(result.matches.map((price) => {
        const manual = existing.get(price.model.toLowerCase())?.source === 'manual';
        return {
          selected: !manual, manual, price,
          prompt: String(price.prompt), completion: String(price.completion),
          cacheRead: String(price.cacheRead), cacheCreation: String(price.cacheCreation),
        };
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = useMemo(() => drafts.filter((item) => item.selected).length, [drafts]);
  const update = (index: number, patch: Partial<SyncDraft>) =>
    setDrafts((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const setAll = (selected: boolean) => setDrafts((current) => current.map((item) => ({ ...item, selected })));

  const apply = async () => {
    const selected = drafts.filter((item) => item.selected);
    if (!selected.length) return;
    const valid = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
    if (selected.some((item) => !valid(item.prompt) || !valid(item.completion) || !validOptional(item.cacheRead) || !validOptional(item.cacheCreation))) {
      setError(t('sec.usage.prices.sync.invalid'));
      return;
    }
    const prices = selected.map((item): ModelPrice => ({
      ...item.price,
      prompt: Number(item.prompt),
      completion: Number(item.completion),
      cacheRead: item.cacheRead.trim() === '' ? 0 : Number(item.cacheRead),
      cacheCreation: item.cacheCreation.trim() === '' ? 0 : Number(item.cacheCreation),
      cacheReadConfigured: item.cacheRead.trim() !== '',
      cacheCreationConfigured: item.cacheCreation.trim() !== '',
    }));
    setApplying(true);
    setError('');
    try {
      const result = await invoke<ModelPriceSyncResult>('apply_usage_model_prices', { prices });
      onApplied(result.imported);
    } catch (cause) {
      setError(String(cause));
      setApplying(false);
    }
  };

  const busy = loading || applying;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!applying}
      size="lg"
      title={t('sec.usage.prices.sync.title')}
      footer={<>
        <Button variant="ghost" disabled={applying} onClick={onClose}>{t('common.cancel')}</Button>
        {preview ? (
          <Button variant="primary" loading={applying} disabled={selectedCount === 0} onClick={() => void apply()}>
            {t('sec.usage.prices.sync.apply', { count: selectedCount })}
          </Button>
        ) : null}
      </>}
    >
      <div className="prices-sync">
        <div className="prices-sync-bar">
          <SegmentedControl<SyncSource>
            ariaLabel={t('sec.usage.prices.sync.source')}
            value={source}
            onChange={changeSource}
            options={SOURCES}
            size="sm"
          />
          <Button variant={preview ? 'secondary' : 'primary'} size="sm" icon={<Eye />} loading={loading} disabled={applying} onClick={() => void runPreview()}>
            {t(loading ? 'sec.usage.prices.sync.previewing' : 'sec.usage.prices.sync.preview')}
          </Button>
          {preview ? (
            <a className="prices-sync-source" href={preview.sourceUrl} target="_blank" rel="noreferrer">{preview.source}</a>
          ) : null}
        </div>

        {preview ? (
          <>
            <div className="prices-sync-bar">
              <span className="prices-sync-counts ec-muted">
                {t('sec.usage.prices.sync.counts', { matched: drafts.length, unmatched: preview.unmatched.length })}
              </span>
              <span className="prices-spacer" />
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => setAll(true)}>{t('sec.usage.prices.sync.selectAll')}</Button>
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => setAll(false)}>{t('sec.usage.prices.sync.selectNone')}</Button>
            </div>
            {drafts.length === 0 ? (
              <p className="prices-sync-empty ec-muted">{t('sec.usage.prices.sync.noMatches')}</p>
            ) : (
              <div className="prices-scroll prices-sync-scroll" tabIndex={0} role="region" aria-label={t('sec.usage.prices.sync.title')}>
                <table className="prices-sync-table">
                  <thead>
                    <tr>
                      <th scope="col"><span className="prices-sr">{t('sec.usage.prices.sync.selectAll')}</span></th>
                      <th scope="col">{t('sec.usage.prices.col.model')}</th>
                      {FIELDS.map((field) => <th scope="col" key={field}>{t(FIELD_LABEL[field])}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((item, index) => (
                      <tr key={item.price.model} data-selected={item.selected}>
                        <td>
                          <input
                            type="checkbox"
                            className="prices-check"
                            checked={item.selected}
                            disabled={applying}
                            aria-label={t('sec.usage.prices.sync.select', { model: item.price.model })}
                            onChange={(event) => update(index, { selected: event.currentTarget.checked })}
                          />
                        </td>
                        <td>
                          <div className="prices-model">
                            <span className="ec-mono ec-trunc" title={item.price.model}>{item.price.model}</span>
                            {item.manual ? <span title={t('sec.usage.prices.sync.manual')}><Chip size="sm" tone="warn">{t('sec.usage.prices.source.manual')}</Chip></span> : null}
                          </div>
                          {item.price.sourceModelId && item.price.sourceModelId !== item.price.model
                            ? <small className="ec-muted ec-mono ec-trunc prices-sub">{item.price.sourceModelId}</small> : null}
                        </td>
                        {FIELDS.map((field) => (
                          <td key={field}>
                            <input
                              type="number"
                              className="prices-input prices-input--cell ec-num"
                              min="0"
                              step="any"
                              value={item[field]}
                              disabled={applying}
                              aria-label={`${item.price.model} · ${t(FIELD_LABEL[field])}`}
                              onChange={(event) => update(index, { [field]: event.currentTarget.value })}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.unmatched.length > 0 ? (
              <details className="prices-sync-unmatched">
                <summary>{t('sec.usage.prices.sync.unmatched', { count: preview.unmatched.length })}</summary>
                <p className="ec-mono ec-muted">{preview.unmatched.join(', ')}</p>
              </details>
            ) : null}
          </>
        ) : null}
        {error ? <p className="prices-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
