import { useEffect, useRef, useState } from 'react';
import { Folder, KeyRound, Lock, Plus, RotateCcw, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pluginText } from '../../i18n/plugins';
import { usePrivacyMask } from '../../privacy';
import { openSettingField } from '../../services/settingsNavigation';
import { isRecord } from '../../services/managementApi';
import { safePluginWebURL } from '../../services/pluginResources';
import { pluginsApi, type PluginSettings } from '../../services/plugins';
import { Badge, Button, Card, Chip, ErrorState, IconButton, Masked, Skeleton } from '../../ui';
import { Banner } from './parts';
import { errorMessage } from './usePlugins';

/**
 * Settings tab (the old PluginSettingsPanel, same getSettings/updateSettings diffing): plugin directory, store sources
 * (official + additional URLs), store authentication rules (JSON array of objects) and the GitHub token shortcut.
 * Props: onSaved (called after a successful write).
 */
export function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const { t, locale } = useI18n();
  const pt = (key: Parameters<typeof pluginText>[0]) => pluginText(key, locale);
  const [original, setOriginal] = useState<PluginSettings | null>(null);
  const [directory, setDirectory] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [draftSource, setDraftSource] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [auth, setAuth] = useState('[]');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirFocused, setDirFocused] = useState(false);
  const mask = usePrivacyMask();
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);

  const apply = (data: PluginSettings) => {
    setOriginal(data); setDirectory(data.dir); setSources(data.storeSources); setAuth(JSON.stringify(data.storeAuth, null, 2));
  };
  useEffect(() => {
    const current = ++generation.current;
    setError('');
    void pluginsApi.getSettings().then(data => {
      if (generation.current === current) apply(data);
    }).catch(reason => { if (generation.current === current) setError(errorMessage(reason)); });
    return () => { ++generation.current; };
  }, [attempt]);

  let ruleCount = 0;
  try { const parsed: unknown = JSON.parse(auth); ruleCount = Array.isArray(parsed) ? parsed.length : 0; } catch { ruleCount = 0; }
  const dirty = Boolean(original) && (directory.trim() !== original!.dir
    || JSON.stringify(sources) !== JSON.stringify(original!.storeSources)
    || auth !== JSON.stringify(original!.storeAuth, null, 2));

  const addSource = () => {
    const value = draftSource.trim();
    if (!value) return;
    if (!safePluginWebURL(value)) { setSourceError(t('sec.plugins.settings.invalidUrl')); return; }
    if (sources.includes(value)) { setSourceError(t('sec.plugins.settings.duplicateSource')); return; }
    setSources(previous => [...previous, value]); setDraftSource(''); setSourceError('');
  };
  const reset = () => { if (original) { apply(original); setSourceError(''); setDraftSource(''); setError(''); } };

  const save = async () => {
    if (pending.current || !original) return;
    setError('');
    let rules: unknown;
    try { rules = JSON.parse(auth); } catch { setError(pt('invalidSettings')); return; }
    if (!directory.trim() || sources.some(url => !safePluginWebURL(url)) || !Array.isArray(rules) || !rules.every(isRecord)) { setError(pt('invalidSettings')); return; }
    const changes: Partial<PluginSettings> = {};
    if (directory.trim() !== original.dir) changes.dir = directory.trim();
    if (JSON.stringify(sources) !== JSON.stringify(original.storeSources)) changes.storeSources = sources;
    if (JSON.stringify(rules) !== JSON.stringify(original.storeAuth)) changes.storeAuth = rules;
    pending.current = true; setBusy(true);
    const current = generation.current;
    try {
      if (Object.keys(changes).length) await pluginsApi.updateSettings(changes);
      if (current !== generation.current) return;
      setOriginal({ ...original, ...changes }); setDirectory(changes.dir ?? directory); setAuth(JSON.stringify(rules, null, 2)); onSaved();
    } catch (reason) { if (current === generation.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (current === generation.current) setBusy(false); }
  };

  if (!original) {
    return error
      ? <ErrorState title={t('sec.plugins.loadFailed')} message={<Masked value={error} />} onRetry={() => setAttempt(value => value + 1)} />
      : <Card aria-busy="true"><Skeleton lines={4} height={14} /></Card>;
  }

  return (
    <form className="pl-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Card padded={false} as="section">
        <fieldset className="pl-settings" disabled={busy}>
          <div className="pl-set-row">
            <div className="pl-set-label"><Folder size={14} aria-hidden /><span>{pt('directory')}</span></div>
            <div className="pl-set-control">
              <input className="pl-input pl-input--mono" value={dirFocused ? directory : mask.identifier(directory)} onChange={event => setDirectory(event.target.value)}
                onFocus={() => setDirFocused(true)} onBlur={() => setDirFocused(false)} aria-label={pt('directory')} spellCheck={false} />
            </div>
          </div>

          <div className="pl-set-row pl-set-row--top">
            <div className="pl-set-label"><span>{t('sec.plugins.settings.sources')}</span><Badge count={sources.length + 1} /></div>
            <div className="pl-set-control pl-sources">
              <div className="pl-source pl-source--official">
                <Lock size={13} aria-hidden /><span className="ec-trunc">{t('sec.plugins.settings.officialSource')}</span>
              </div>
              {sources.map(source => (
                <div className="pl-source" key={source}>
                  <Masked value={source} mono className="ec-trunc" />
                  <IconButton size="xs" icon={<X size={12} />} label={t('sec.plugins.settings.removeSource')}
                    onClick={() => setSources(previous => previous.filter(entry => entry !== source))} />
                </div>
              ))}
              <div className="pl-source-add">
                <input className="pl-input pl-input--mono" value={draftSource} aria-label={t('sec.plugins.settings.addSource')} aria-invalid={Boolean(sourceError)}
                  placeholder={t('sec.plugins.settings.sourcePlaceholder')} spellCheck={false}
                  onChange={event => { setDraftSource(event.target.value); setSourceError(''); }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addSource(); } }} />
                <Button variant="secondary" icon={<Plus size={14} />} disabled={!draftSource.trim()} onClick={addSource}>{t('sec.plugins.settings.addSource')}</Button>
              </div>
              {sourceError ? <small className="pl-field-error" role="alert">{sourceError}</small> : <small className="pl-field-hint">{pt('sourcesHint')}</small>}
            </div>
          </div>

          <div className="pl-set-row pl-set-row--top">
            <div className="pl-set-label"><span>{t('sec.plugins.settings.auth')}</span><Badge count={ruleCount} /></div>
            <div className="pl-set-control">
              <textarea className="pl-input pl-input--mono pl-textarea" rows={5} value={auth} onChange={event => setAuth(event.target.value)} aria-label={t('sec.plugins.settings.auth')} spellCheck={false} />
              <small className="pl-field-hint">{pt('authHint')}</small>
            </div>
          </div>

          <div className="pl-set-row">
            <div className="pl-set-label"><KeyRound size={14} aria-hidden /><span>{t('sec.plugins.settings.githubToken')}</span></div>
            <div className="pl-set-control pl-set-inline">
              <small className="pl-field-hint">{t('sec.plugins.settings.githubTokenHint')}</small>
              <Button variant="outline" size="sm" icon={<KeyRound size={14} />} onClick={() => openSettingField(['server', 'github-token'])}>{pt('configureToken')}</Button>
            </div>
          </div>
        </fieldset>
      </Card>

      {error ? <Banner tone="error"><Masked value={error} /></Banner> : null}
      <div className="pl-save-bar">
        {dirty ? <Chip tone="warn" size="sm">{t('sec.plugins.settings.unsaved')}</Chip> : null}
        <span className="pl-spacer" />
        <Button variant="ghost" icon={<RotateCcw size={14} />} disabled={!dirty || busy} onClick={reset}>{t('sec.plugins.settings.reset')}</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>{t('common.save')}</Button>
      </div>
    </form>
  );
}
