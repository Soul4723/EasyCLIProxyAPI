/**
 * ModelExclusions: provider-scope excluded models for OAuth credentials (config/oauth/excluded-models).
 * One card per provider that has credentials (or existing rules), with the rule chips and an editor dialog
 * (rules text + model checklist) that saves through saveOAuthModelSettings like the old "OAuth credential model exclusions".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Pencil, ShieldOff } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import {
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  ProviderLogo,
  ProviderName,
  Skeleton,
  providerInfo,
} from '../../../ui';
import { normalizeOAuthProvider, oauthModelProvidersFromAuthFiles } from '../../../services/authFiles';
import { isRecord, managementApi } from '../../../services/managementApi';
import { normalizeOAuthExcludedRules, oauthExcludedRulesFromPayload } from '../../../services/oauthModels';
import {
  loadOAuthModelSettings,
  saveOAuthModelSettings,
  type OAuthModelSettings,
} from '../../../services/oauthModelSettings';
import { ModelRules } from './ModelRules';
import type { CredentialsCore } from './useCredentials';
import './creds.css';

const MAX_CHIPS = 8;

type Exclusions = Record<string, unknown>;

async function readExclusions(): Promise<Exclusions> {
  try {
    const value = await managementApi.get('/config/oauth/excluded-models');
    return isRecord(value) ? value : {};
  } catch (error) {
    // The core answers 404 until the first rule is written.
    if ((error instanceof Error ? error.message : error) === 'Management API error (404): not_found') return {};
    throw error;
  }
}

export function ModelExclusions({ controller }: { controller: Pick<CredentialsCore, 'rows' | 'notify' | 'loading'> }) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [exclusions, setExclusions] = useState<Exclusions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [settings, setSettings] = useState<OAuthModelSettings | null>(null);
  const [rulesText, setRulesText] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setExclusions(await readExclusions());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const providers = useMemo(() => {
    const ids = new Set(oauthModelProvidersFromAuthFiles(controller.rows.map((row) => row.file)));
    Object.keys(exclusions ?? {}).forEach((key) => { const id = normalizeOAuthProvider(key); if (id) ids.add(id); });
    return [...ids]
      .map((id) => ({
        id,
        name: providerInfo(id).name,
        credentials: controller.rows.filter((row) => row.editable && normalizeOAuthProvider(row.provider) === id).length,
        rules: exclusions ? oauthExcludedRulesFromPayload(exclusions, id) : [],
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [controller.rows, exclusions]);

  const openEditor = async (id: string) => {
    const requestId = ++requestRef.current;
    setTarget(id);
    setSettings(null);
    setRulesText('');
    setEditError('');
    setEditLoading(true);
    try {
      const loaded = await loadOAuthModelSettings({ scope: 'provider', provider: id, label: providerInfo(id).name });
      if (requestRef.current !== requestId) return;
      setSettings(loaded);
      setRulesText(loaded.excludedRules.join('\n'));
    } catch (reason) {
      if (requestRef.current === requestId) setEditError(String(reason));
    } finally {
      if (requestRef.current === requestId) setEditLoading(false);
    }
  };
  const close = () => { if (!saving) { requestRef.current += 1; setTarget(null); setSettings(null); } };
  const rules = normalizeOAuthExcludedRules(rulesText.split(/\r?\n/));
  const save = async () => {
    if (!settings || saving || editLoading) return;
    setSaving(true);
    setEditError('');
    try {
      await saveOAuthModelSettings(settings, rules);
      controller.notify(t('authFiles.models.updated', { provider: settings.target.label }));
      setSaving(false);
      close();
      await load();
    } catch (reason) {
      setEditError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ErrorState message={mask.text(error)} onRetry={() => void load()} />;
  if (loading || controller.loading) {
    return <div className="ec-cred-exclusions">{[0, 1, 2].map((key) => <Card key={key}><Skeleton lines={3} /></Card>)}</div>;
  }
  if (providers.length === 0) {
    return <EmptyState icon={<ShieldOff size={20} />} title={t('sec.providers.creds.exclusions.empty')} />;
  }

  return (
    <>
      <div className="ec-cred-exclusions">
        {providers.map((provider) => (
          <Card key={provider.id} as="article" className="ec-cred-excl" aria-label={provider.name}>
            <header className="ec-cred-excl__head">
              <ProviderLogo provider={provider.id} size={32} />
              <div className="ec-cred-excl__title">
                <strong><ProviderName provider={provider.id} /></strong>
                <span className="ec-muted">{t('sec.providers.creds.exclusions.accounts', { count: provider.credentials })}</span>
              </div>
              <Button size="sm" variant="outline" icon={<Pencil size={13} />} onClick={() => void openEditor(provider.id)}>
                {t('sec.providers.creds.exclusions.edit')}
              </Button>
            </header>
            <div className="ec-cred-excl__rules">
              {provider.rules.length === 0 ? (
                <span className="ec-muted ec-cred-excl__none"><Boxes size={13} aria-hidden="true" />{t('sec.providers.creds.exclusions.none')}</span>
              ) : (
                <>
                  {provider.rules.slice(0, MAX_CHIPS).map((rule) => <Chip key={rule} size="sm" tone="danger"><span className="ec-mono">{rule}</span></Chip>)}
                  {provider.rules.length > MAX_CHIPS ? <Chip size="sm" tone="outline">+{provider.rules.length - MAX_CHIPS}</Chip> : null}
                </>
              )}
            </div>
          </Card>
        ))}
      </div>
      <Dialog
        open={target !== null}
        onClose={close}
        dismissible={!saving}
        size="lg"
        title={t('authFiles.models.globalButton')}
        footer={(
          <>
            <Button variant="ghost" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={editLoading || saving || !settings} onClick={() => void save()}>
              {saving ? t('common.saving') : t('authFiles.models.save', { count: rules.length })}
            </Button>
          </>
        )}
      >
        <div className="ec-cred-excl__dialog">
          {target ? (
            <p className="ec-cred-excl__lead">
              <ProviderLogo provider={target} size={20} /> <ProviderName provider={target} />
              <span className="ec-muted"> · {t('authFiles.models.globalDescription', { provider: providerInfo(target).name })}</span>
            </p>
          ) : null}
          {editError ? <p className="ec-cred-note ec-cred-note--error" role="alert">{mask.text(editError)}</p> : null}
          <ModelRules
            models={settings?.models ?? []}
            rulesText={rulesText}
            onRulesText={setRulesText}
            loading={editLoading}
            catalogError={settings?.catalogError ?? ''}
            disabled={saving || editLoading || !settings}
          />
        </div>
      </Dialog>
    </>
  );
}
