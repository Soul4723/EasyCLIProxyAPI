/**
 * CredentialPanel: the C2-style side panel for one credential file. Sections: overview, Routing, Models (availability +
 * excluded-model rules), Cooldown (records + clear), Advanced (aliases, Claude cloaking, timezone, headers, note).
 * Every field of the former settings/models dialogs is reachable here. Rendered by `controller.dialogs`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, LogIn, RotateCcw } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { routeHref } from '../../../shell/router';
import {
  Button,
  Chip,
  ConfirmDialog,
  Countdown,
  CopyButton,
  Masked,
  ProviderLogo,
  SidePanel,
  StatusPill,
  Toggle,
  providerInfo,
} from '../../../ui';
import { credentialProviderKey } from '../../../components/CredentialAdvancedFields';
import { formatDate, managementApi, readNumber, readString } from '../../../services/managementApi';
import {
  loadAuthFileSettings,
  saveAuthFileSettings,
  type AuthFileSettingsDraft,
} from '../../../services/authFileSettings';
import { cooldownReasonKey, normalizeAuthFileCooldowns, summarizeAuthFileCooldowns } from '../../../services/authFileHealth';
import { authFileCooldownResetIndex } from '../../../services/authFiles';
import { oauthModelsFromPayload, type OAuthModelDefinition } from '../../../services/oauthModels';
import { AdvancedFields, Field, HeadersEditor, OverrideField, TextField } from './fields';
import { ModelRules } from './ModelRules';
import { requestShare, type CredentialRow } from './model';
import type { CredentialsCore } from './useCredentials';
import './creds.css';

type PanelProps = {
  controller: CredentialsCore;
  suspended?: boolean;
  /** Shown as a prominent button for expired/error credentials; the lead opens the sign-in flow for the brand. */
  onReSignIn?: (provider: string) => void;
};

export function CredentialPanel({ controller, suspended = false, onReSignIn }: PanelProps) {
  const row = controller.selectedName ? controller.rows.find((item) => item.name === controller.selectedName) : undefined;
  if (!row) return null;
  return <PanelBody key={row.name} controller={controller} row={row} suspended={suspended} onReSignIn={onReSignIn} />;
}

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ec-cred-sec" data-section={id} aria-label={title}>
      <header className="ec-cred-sec__head"><h3>{title}</h3>{aside}</header>
      <div className="ec-cred-sec__body">{children}</div>
    </section>
  );
}

function PanelBody({ controller, row, suspended, onReSignIn }: PanelProps & { row: CredentialRow }) {
  const { t, formatNumber } = useI18n();
  const mask = usePrivacyMask();
  const name = row.name;
  const editable = row.editable;
  const provider = credentialProviderKey(name, row.provider);
  const bodyRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);

  const [original, setOriginal] = useState<AuthFileSettingsDraft | null>(null);
  const [draft, setDraft] = useState<AuthFileSettingsDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(editable);
  const [models, setModels] = useState<OAuthModelDefinition[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discardAsk, setDiscardAsk] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const fetchSettings = useCallback(async (isActive: () => boolean) => {
    try {
      const value = await loadAuthFileSettings(name);
      if (!isActive()) return;
      setOriginal(value);
      setDraft(value);
      setRevision((current) => current + 1);
    } catch (reason) {
      if (isActive()) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [name]);

  useEffect(() => {
    let active = true;
    const isActive = () => active;
    setError('');
    setCatalogError('');
    setCatalogLoading(true);
    if (editable) {
      setLoading(true);
      void fetchSettings(isActive).finally(() => { if (active) setLoading(false); });
    }
    void managementApi.get('/credentials/models', { name })
      .then((payload) => { if (active) setModels(oauthModelsFromPayload(payload)); })
      .catch((reason: unknown) => { if (active) setCatalogError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [name, editable, attempt, fetchSettings]);

  // Jump to the requested section once the content exists (menu items "Settings" / "Models").
  const section = controller.selectedSection;
  const ready = !loading;
  useEffect(() => {
    if (!section || !ready) return;
    const target = bodyRef.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: 'start' });
  }, [section, ready]);

  const dirty = draft !== null && (Boolean(draft.normalizeCloakMetadata?.length) || JSON.stringify(draft) !== JSON.stringify(original));
  const update = <K extends keyof AuthFileSettingsDraft>(key: K, value: AuthFileSettingsDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setError('');
  };

  const shown = mask.text(name, row.identities);
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty) setDiscardAsk(true); else controller.select(null);
  };
  const save = async () => {
    if (!draft || !original || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const changed = await saveAuthFileSettings(name, original, draft);
      if (changed) {
        controller.notify(t('authFiles.settings.updated', { name: shown }));
        void controller.refresh();
        await fetchSettings(() => true);
      } else {
        controller.select(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const modelIds = useMemo(() => models.map((model) => model.id), [models]);
  const showWebsockets = provider === 'codex' || provider === 'xai' || draft?.websockets === 'true' || draft?.websockets === 'false';
  const rulesCount = draft ? draft.excluded_models.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  const open = !suspended && !discardAsk;

  const header = (
    <span className="ec-cred-head">
      <ProviderLogo provider={row.provider} size={36} title={providerInfo(row.provider).name} />
      <span className="ec-cred-head__text">
        <span className="ec-cred-head__name"><Masked value={row.identity || row.name} identities={row.identities} /></span>
        <span className="ec-cred-head__meta">
          <StatusPill status={row.status} size="sm" />
          {row.plan ? <Chip size="sm">{row.plan}</Chip> : null}
          {row.runtimeOnly ? <Chip size="sm" tone="outline">{t('authFiles.runtime')}</Chip> : null}
        </span>
      </span>
    </span>
  );

  return (
    <>
      <SidePanel
        open={open}
        onClose={requestClose}
        width={560}
        ariaLabel={mask.text(row.identity || row.name, row.identities)}
        title={header}
        subtitle={(
          <span className="ec-cred-subtitle">
            {row.identity ? <Masked value={row.name} identities={row.identities} mono /> : <span>{providerInfo(row.provider).name}</span>}
            <CopyButton value={row.name} size="sm" />
          </span>
        )}
        actions={(
          <>
            {onReSignIn && (row.status === 'expired' || row.status === 'error') ? (
              <Button size="sm" variant="primary" icon={<LogIn size={13} />} onClick={() => onReSignIn(row.provider)}>
                {t('sec.providers.creds.signInAgain')}
              </Button>
            ) : null}
            {row.quotaProvider ? (
              <a className="ec-cred-link" href={routeHref('quota', null, { cred: row.name })}>
                {t('sec.providers.creds.quotaLink')}<ArrowUpRight size={12} aria-hidden="true" />
              </a>
            ) : null}
            <Toggle checked={!row.disabled} disabled={controller.busy || !editable}
            label={`${t(row.disabled ? 'common.enable' : 'common.disable')} ${shown}`} onChange={() => void controller.toggle(row)} />
          </>
        )}
        footer={editable ? (
          <div className="ec-cred-footer">
            {error ? <p className="ec-cred-footer__error" role="alert">{error}</p> : <span />}
            <div className="ec-cred-footer__actions">
              <Button variant="ghost" disabled={saving || !dirty} onClick={() => { setDraft(original); setRevision((value) => value + 1); setError(''); }}>
                {t('sec.providers.creds.discard')}
              </Button>
              {!loading && !draft
                ? <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}>{t('common.refresh')}</Button>
                : <Button variant="primary" loading={saving} disabled={!draft || loading || saving || !dirty} onClick={() => void save()}>
                  {t(saving ? 'common.saving' : 'common.save')}
                </Button>}
            </div>
          </div>
        ) : undefined}
      >
        <div className="ec-cred-panel" ref={bodyRef}>
          <Overview row={row} formatNumber={formatNumber} />
          {!editable ? (
            <p className="ec-cred-note">{t(row.runtimeOnly ? 'authFiles.settings.runtime' : 'authFiles.fileOnly')}</p>
          ) : null}

          {editable ? (
            <Section id="routing" title={t('authFiles.settings.routing')}>
              {loading ? <PanelSkeleton /> : draft ? (
                <fieldset className="ec-cred-fieldset" disabled={saving}>
                  <div className="ec-cred-grid">
                    <TextField label={t('authFiles.settings.priority')} hint={t('authFiles.settings.priorityHint')} numeric placeholder="0"
                      value={draft.priority} onChange={(value) => update('priority', value)} />
                    <TextField label={t('authFiles.settings.weight')} hint={t('authFiles.settings.weightHint')} numeric placeholder="1"
                      value={draft.weight} onChange={(value) => update('weight', value)} />
                    <TextField label={t('authFiles.settings.prefix')} hint={t('authFiles.settings.prefixHint')}
                      value={draft.prefix} onChange={(value) => update('prefix', value)} />
                    <TextField label={t('authFiles.settings.proxy_url')} hint={t('authFiles.settings.proxy_urlHint')} mono placeholder="socks5://127.0.0.1:1080"
                      value={draft.proxy_url} onChange={(value) => update('proxy_url', value)} />
                    <OverrideField label={t('authFiles.settings.disable_cooling')} hint={t('authFiles.settings.disable_coolingHint')}
                      value={draft.disable_cooling} onChange={(value) => update('disable_cooling', value)} />
                    {showWebsockets ? (
                      <OverrideField label={t('authFiles.settings.websockets')} hint={t('authFiles.settings.websocketsHint')}
                        value={draft.websockets} onChange={(value) => update('websockets', value)} />
                    ) : null}
                    <Field label={t('authFiles.settings.note')} span>
                      <textarea className="ec-cred-input ec-cred-input--area" rows={2} value={draft.note}
                        onChange={(event) => update('note', event.currentTarget.value)} />
                    </Field>
                  </div>
                </fieldset>
              ) : <p className="ec-cred-note ec-cred-note--error">{error}</p>}
            </Section>
          ) : null}

          <Section id="models" title={t(editable ? 'authFiles.settings.excluded_models' : 'authFiles.models.viewTitle')}
            aside={editable && rulesCount > 0 ? <Chip size="sm" tone="danger">{t('authFiles.models.save', { count: rulesCount })}</Chip> : undefined}>
            <fieldset className="ec-cred-fieldset" disabled={saving}>
              <ModelRules
                models={models}
                rulesText={draft?.excluded_models ?? ''}
                onRulesText={(text) => update('excluded_models', text)}
                loading={catalogLoading || (editable && loading)}
                catalogError={catalogError}
                disabled={!draft}
                readOnly={!editable}
              />
            </fieldset>
          </Section>

          <CooldownSection controller={controller} row={row} />

          {editable ? (
            <details className="ec-cred-sec ec-cred-sec--details" data-section="advanced">
              <summary className="ec-cred-sec__head"><h3>{t('sec.providers.creds.advanced')}</h3></summary>
              <div className="ec-cred-sec__body">
                {loading ? <PanelSkeleton /> : draft ? (
                  <fieldset className="ec-cred-fieldset" disabled={saving}>
                    <AdvancedFields provider={provider} advanced={draft.advanced} modelIds={modelIds} disabled={saving}
                      onChange={(advanced) => update('advanced', advanced)} />
                    <HeadersEditor key={revision} value={draft.headers} disabled={saving} onChange={(value) => update('headers', value)} />
                  </fieldset>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </SidePanel>
      <ConfirmDialog
        open={discardAsk}
        title={t('sec.providers.creds.discard.title')}
        message={t('sec.providers.creds.discard.message')}
        confirmLabel={t('sec.providers.creds.discard')}
        danger
        onConfirm={() => { setDiscardAsk(false); controller.select(null); }}
        onCancel={() => setDiscardAsk(false)}
      />
    </>
  );
}

function PanelSkeleton() {
  return <div className="ec-cred-skeleton" aria-busy="true"><span /><span /><span /></div>;
}

function Overview({ row, formatNumber }: { row: CredentialRow; formatNumber: (value: number) => string }) {
  const { t } = useI18n();
  const file = row.file;
  const size = readNumber(file, 'size');
  const updated = file.modtime ?? file.updated_at ?? file.last_refresh;
  const expiry = readString(file, 'subscription_active_until', 'subscriptionActiveUntil');
  const expiryMs = expiry ? Date.parse(expiry) : NaN;
  const share = requestShare(row.requests);
  return (
    <dl className="ec-cred-overview">
      <div>
        <dt>{t('authFiles.requests.title')}</dt>
        <dd>
          {share && row.requests ? (
            <>
              <span className="ec-cred-req__ok">{formatNumber(row.requests.ok)}</span>
              <span className="ec-muted"> / </span>
              <span className={row.requests.fail ? 'ec-cred-req__fail' : 'ec-cred-req__zero'}>{formatNumber(row.requests.fail)}</span>
            </>
          ) : '—'}
        </dd>
      </div>
      <div><dt>{t('authFiles.priority.label')}</dt><dd>{row.priority}</dd></div>
      <div><dt>{t('authFiles.list.updated')}</dt><dd>{formatDate(updated)}</dd></div>
      <div><dt>{t('authFiles.list.size')}</dt><dd>{size === null ? t('authFiles.unknownSize') : `${Math.ceil(size / 1024)} KB`}</dd></div>
      {Number.isFinite(expiryMs) ? (
        <div>
          <dt>{t('sec.providers.creds.subscription')}</dt>
          <dd title={formatDate(expiry)}>{expiryMs <= Date.now() ? t('authFiles.list.expired') : t('authFiles.list.daysRemaining', { count: Math.ceil((expiryMs - Date.now()) / 86_400_000) })}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function CooldownSection({ controller, row }: { controller: CredentialsCore; row: CredentialRow }) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const snapshot = useMemo(
    () => normalizeAuthFileCooldowns(row.file.cooldowns, controller.receivedAtMs),
    [row.file, controller.receivedAtMs],
  );
  const summary = summarizeAuthFileCooldowns(snapshot, Date.now());
  const index = authFileCooldownResetIndex(row.file);
  const resetting = Boolean(index && controller.cooldownBusy.has(index));
  const message = row.statusDetail ? mask.text(row.statusDetail, row.identities) : '';
  const scopeLine = summary.credentialWide
    ? (summary.modelCount ? t('authFiles.health.credentialModels', { count: summary.modelCount }) : t('authFiles.health.credential'))
    : summary.modelCount ? t('authFiles.health.models', { count: summary.modelCount }) : '';
  return (
    <Section id="cooldown" title={t('sec.providers.creds.cooldown')}
      aside={summary.rows.length > 0 && index ? (
        <Button size="sm" variant="outline" icon={<RotateCcw size={13} />} loading={resetting} disabled={controller.busy || resetting}
          title={t('authFiles.cooldown.resetHint')} onClick={() => controller.clearCooldown(row)}>
          {t(resetting ? 'authFiles.cooldown.resetting' : 'authFiles.cooldown.resetButton')}
        </Button>
      ) : undefined}>
      {snapshot === undefined ? <p className="ec-cred-note">{t('authFiles.health.missingCooldown')}</p>
        : snapshot.records === null ? <p className="ec-cred-note">{t('authFiles.health.unknownCooldown')}</p>
          : summary.rows.length === 0 ? <p className="ec-cred-note">{t('sec.providers.creds.cooldown.none')}</p>
            : (
              <>
                {scopeLine ? <p className="ec-cred-note">{scopeLine}</p> : null}
                <ul className="ec-cred-cooldowns">
                  {summary.rows.map(({ record, remainingSeconds }, position) => (
                    <li key={`${record.scope}:${record.model ?? ''}:${position}`}>
                      <div className="ec-cred-cooldowns__head">
                        <strong className="ec-mono">{record.scope === 'credential' ? t('authFiles.health.credentialScope') : record.model}</strong>
                        {remainingSeconds > 0
                          ? <span className="ec-cred-cooldowns__time"><Countdown to={controller.receivedAtMs + record.remainingSeconds * 1000} /></span>
                          : <span className="ec-muted">{t('authFiles.health.waiting')}</span>}
                      </div>
                      <div className="ec-cred-cooldowns__meta">
                        <Chip size="sm" tone="warn">{t(cooldownReasonKey(record.reason))}</Chip>
                        {record.httpStatus !== undefined ? <Chip size="sm" tone="outline">HTTP {record.httpStatus}</Chip> : null}
                        {record.backoffLevel !== undefined ? (
                          <span title={t('authFiles.health.backoffHint')}><Chip size="sm" tone="outline">{t('authFiles.health.backoff', { level: record.backoffLevel })}</Chip></span>
                        ) : null}
                        <time className="ec-muted" dateTime={record.retryAt}>{formatDate(record.retryAt)}</time>
                      </div>
                    </li>
                  ))}
                </ul>
                {summary.elapsed ? <p className="ec-cred-note">{t('authFiles.health.expiredHint')}</p> : null}
              </>
            )}
      {message ? <p className="ec-cred-note ec-cred-note--message" title={t('authFiles.health.coreMessage')}>{message}</p> : null}
    </Section>
  );
}
