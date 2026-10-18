/**
 * ModelRules: the excluded-model editor shared by the credential panel and the provider-scope exclusions dialog.
 * `rulesText` is the one-rule-per-line draft; the checklist toggles exact model ids in it (wildcard rules block their
 * matches, as before). Controlled: the parent owns the text and the catalog.
 */
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { Button, Chip, CopyButton, SearchInput, Skeleton } from '../../../ui';
import {
  modelMatchesRule,
  normalizeOAuthExcludedRules,
  oauthModelCandidates,
  setOAuthModelsExcluded,
  type OAuthModelDefinition,
} from '../../../services/oauthModels';
import './creds.css';

export type ModelRulesProps = {
  models: OAuthModelDefinition[];
  rulesText: string;
  onRulesText: (text: string) => void;
  loading?: boolean;
  /** Catalog load error text; rules stay editable by hand. */
  catalogError?: string;
  disabled?: boolean;
  /** Read-only list (no checkboxes, no rules): the supported models of a non-editable credential. */
  readOnly?: boolean;
};

export function ModelRules({ models, rulesText, onRulesText, loading = false, catalogError = '', disabled = false, readOnly = false }: ModelRulesProps) {
  const { t, formatNumber } = useI18n();
  const [search, setSearch] = useState('');
  const rules = normalizeOAuthExcludedRules(rulesText.split(/\r?\n/));
  const candidates = oauthModelCandidates(models, rules);
  const query = search.trim().toLowerCase();
  const visible = candidates.filter((model) => `${model.id} ${model.displayName ?? ''}`.toLowerCase().includes(query));
  const excludedCount = candidates.filter((model) => rules.some((rule) => modelMatchesRule(model.id, rule))).length;
  const setExcluded = (list: OAuthModelDefinition[], excluded: boolean) =>
    onRulesText(setOAuthModelsExcluded(rules, list, excluded).join('\n'));

  return (
    <div className="ec-cred-rules">
      <div className="ec-cred-rules__bar">
        <SearchInput value={search} onChange={setSearch} placeholder={t('authFiles.models.search')} />
        {readOnly ? null : (
          <>
            <Button size="sm" variant="outline" disabled={disabled || loading || candidates.length === 0}
              title={t('authFiles.models.excludeAllHint')} onClick={() => setExcluded(candidates, true)}>
              {t('authFiles.models.excludeAll')}
            </Button>
            <Button size="sm" variant="outline" disabled={disabled || loading || candidates.length === 0}
              title={t('authFiles.models.clearHint')} onClick={() => setExcluded(candidates, false)}>
              {t('authFiles.models.clearSelected')}
            </Button>
          </>
        )}
      </div>
      <div className="ec-cred-rules__summary">
        <Chip size="sm">{t('authFiles.models.summary', { total: formatNumber(candidates.length), excluded: formatNumber(excludedCount) })}</Chip>
        {catalogError ? <Chip size="sm" tone="warn">{t('authFiles.models.catalogUnavailable')}</Chip> : null}
      </div>
      <div className="ec-cred-rules__list" role="list">
        {loading ? (
          <Skeleton lines={4} />
        ) : visible.length === 0 ? (
          <p className="ec-cred-rules__empty">{candidates.length ? t('authFiles.models.noMatch') : t(readOnly ? 'authFiles.models.viewEmpty' : 'authFiles.models.empty')}</p>
        ) : visible.map((model) => {
          const wildcard = rules.find((rule) => rule.includes('*') && modelMatchesRule(model.id, rule));
          const checked = rules.some((rule) => modelMatchesRule(model.id, rule));
          return (
            <label key={model.id} role="listitem" className={`ec-cred-model${checked ? ' is-excluded' : ''}`}
              title={wildcard ? t('authFiles.models.wildcardBlocked', { rule: wildcard }) : model.displayName}>
              {readOnly ? null : (
                <input type="checkbox" checked={checked} disabled={disabled || Boolean(wildcard)}
                  aria-label={`${t('authFiles.models.excludeButton')}: ${model.id}`}
                  onChange={(event) => setExcluded([model], event.currentTarget.checked)} />
              )}
              <span className="ec-cred-model__text">
                <span className="ec-cred-model__id">{model.id}</span>
                {model.displayName ? <span className="ec-cred-model__name">{model.displayName}</span> : null}
              </span>
              {checked ? <Chip size="sm" tone="danger">{t('sec.providers.creds.models.excluded')}</Chip> : null}
              <CopyButton value={model.id} size="sm" label={t('authFiles.models.copyModel')} />
            </label>
          );
        })}
      </div>
      {readOnly ? null : (
        <label className="ec-cred-field">
          <span className="ec-cred-field__label">{t('authFiles.models.rulesLabel')}</span>
          <textarea className="ec-cred-input ec-cred-input--area" rows={3} spellCheck={false} disabled={disabled}
            value={rulesText} placeholder={t('authFiles.models.rulesPlaceholder')} onChange={(event) => onRulesText(event.currentTarget.value)} />
          <span className="ec-cred-field__hint">{t('authFiles.models.rulesHint')}</span>
        </label>
      )}
    </div>
  );
}
