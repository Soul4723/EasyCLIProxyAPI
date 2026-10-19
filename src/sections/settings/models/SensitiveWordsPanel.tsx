import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { invoke } from '../../../services/documentTarget';
import { createSettingsRead } from '../../../services/settingsData';
import { Plus, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Chip, ConfirmDialog, ErrorState, IconButton, ProviderLogo, Skeleton } from '../../../ui';
import { SaveBar, SettingsGroup } from '../ui';

type SensitiveWordsSettings = { antigravitySensitiveWords: string[]; devinSensitiveWords: string[] };
type Provider = 'antigravity' | 'devin';
type WordEntry = { id: number; value: string };
type WordDraft = Record<Provider, WordEntry[]>;

const PROVIDERS: Provider[] = ['antigravity', 'devin'];
const DEFAULT_ANTIGRAVITY_WORDS = ['Claude', 'GPT-5', 'GPT-6', 'Codex', 'Anthropic'];
const normalizedWords = (entries: WordEntry[]) => entries.map(({ value }) => value.trim()).filter(Boolean);
const splitLines = (value: string) => value.split(/\r\n|\n|\r/).map((word) => word.trim()).filter(Boolean);

/** Words that are replaced in system prompts per provider. Draft + one save (`save_core_sensitive_words_settings`). */
const sensitiveWordsRead = createSettingsRead(() => invoke<SensitiveWordsSettings>('get_core_sensitive_words_settings'));

export function SensitiveWordsPanel({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const nextEntryId = useRef(0);
  const [saved, setSaved] = useState<SensitiveWordsSettings | null>(null);
  const [draft, setDraft] = useState<WordDraft>({ antigravity: [], devin: [] });
  const [composer, setComposer] = useState<Record<Provider, string>>({ antigravity: '', devin: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);

  const replaceDraft = useCallback((settings: SensitiveWordsSettings) => {
    const toEntries = (words: string[]) => words.map((value) => ({ id: nextEntryId.current++, value }));
    setDraft({ antigravity: toEntries(settings.antigravitySensitiveWords), devin: toEntries(settings.devinSensitiveWords) });
    setComposer({ antigravity: '', devin: '' });
  }, []);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await sensitiveWordsRead.read({ fresh });
      setSaved(result);
      replaceDraft({
        ...result,
        antigravitySensitiveWords: result.antigravitySensitiveWords.length ? result.antigravitySensitiveWords : DEFAULT_ANTIGRAVITY_WORDS,
      });
      setJustSaved(false);
      setSaveError('');
    } catch (cause) {
      setLoadError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [replaceDraft]);

  useEffect(() => { void load(); }, [load]);

  const words: SensitiveWordsSettings = {
    antigravitySensitiveWords: [...normalizedWords(draft.antigravity), ...(composer.antigravity.trim() ? [composer.antigravity.trim()] : [])],
    devinSensitiveWords: [...normalizedWords(draft.devin), ...(composer.devin.trim() ? [composer.devin.trim()] : [])],
  };
  const changed = (a: string[], b: string[]) => JSON.stringify(a) !== JSON.stringify(b);
  const changeCount = saved === null ? 0 : PROVIDERS.reduce((total, provider) => {
    const key = provider === 'antigravity' ? 'antigravitySensitiveWords' : 'devinSensitiveWords';
    if (!changed(words[key], saved[key])) return total;
    // An edited word is one change (one removed + one added); pure additions/removals count one each.
    const before = new Set(saved[key]);
    const after = new Set(words[key]);
    const added = [...after].filter((word) => !before.has(word)).length;
    const removed = [...before].filter((word) => !after.has(word)).length;
    return total + Math.max(1, added, removed);
  }, 0);
  const dirty = changeCount > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const touch = () => { setJustSaved(false); setSaveError(''); };
  const changeWord = (provider: Provider, id: number, value: string) => {
    setDraft((current) => ({ ...current, [provider]: current[provider].map((entry) => (entry.id === id ? { ...entry, value } : entry)) }));
    touch();
  };
  const compose = (provider: Provider, value: string) => { setComposer((current) => ({ ...current, [provider]: value })); touch(); };
  const addWords = (provider: Provider, value: string) => {
    const entries = splitLines(value).map((word) => ({ id: nextEntryId.current++, value: word }));
    if (entries.length === 0) return;
    setDraft((current) => ({ ...current, [provider]: [...current[provider], ...entries] }));
    setComposer((current) => ({ ...current, [provider]: '' }));
    touch();
  };
  const removeWord = (provider: Provider, id: number) => {
    setDraft((current) => ({ ...current, [provider]: current[provider].filter((entry) => entry.id !== id) }));
    touch();
  };
  const pasteWords = (provider: Provider, id: number, event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[\r\n]/.test(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const lines = pasted.split(/\r\n|\n|\r/).filter((line) => line.trim());
    if (lines.length === 0) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const entries = lines.map((value, index) => ({ id: index === 0 ? id : nextEntryId.current++, value }));
    entries[0].value = input.value.slice(0, start) + entries[0].value;
    entries[entries.length - 1].value += input.value.slice(end);
    setDraft((current) => ({ ...current, [provider]: current[provider].flatMap((entry) => (entry.id === id ? entries : [entry])) }));
    touch();
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await invoke<SensitiveWordsSettings>('save_core_sensitive_words_settings', { settings: words });
      sensitiveWordsRead.publish(result);
      setSaved(result);
      replaceDraft(result);
      setJustSaved(true);
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!saved) return;
    replaceDraft(saved);
    touch();
  };

  const refresh = () => {
    if (dirty) setConfirmRefresh(true);
    else void load(true);
  };

  if (loadError && saved === null) {
    return <ErrorState title={t('sec.settings.loadFailed')} message={loadError} onRetry={() => void load(true)} />;
  }
  if (loading && saved === null) {
    return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={5} /></div>;
  }

  return (
    <div className="ec-models-panel">
      {PROVIDERS.map((provider, groupIndex) => {
        const title = t(provider === 'antigravity' ? 'config.sensitiveWords.antigravity' : 'config.sensitiveWords.devin');
        const entries = draft[provider];
        return (
          <SettingsGroup
            key={provider}
            title={title}
            icon={<ProviderLogo provider={provider} size={20} />}
            status={<Chip size="sm" tone="neutral">{entries.length}</Chip>}
            actions={groupIndex === 0 ? (
              <IconButton size="sm" label={t('common.refresh')} icon={<RefreshCw size={14} />} disabled={loading || saving} onClick={refresh} />
            ) : undefined}
          >
            <div className="ec-models-words">
              <div className="ec-models-composer">
                <ShieldAlert size={14} aria-hidden="true" />
                <input
                  className="ec-set-input is-wide"
                  type="text"
                  aria-label={`${title} ${t('common.add')}`}
                  value={composer[provider]}
                  disabled={saving}
                  placeholder={t('config.sensitiveWords.addPlaceholder')}
                  onChange={(event) => compose(provider, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    addWords(provider, composer[provider]);
                  }}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData('text');
                    if (!/[\r\n]/.test(pasted)) return;
                    event.preventDefault();
                    const input = event.currentTarget;
                    const start = input.selectionStart ?? input.value.length;
                    const end = input.selectionEnd ?? start;
                    addWords(provider, input.value.slice(0, start) + pasted + input.value.slice(end));
                  }}
                />
                <IconButton size="md" variant="outline" label={`${t('common.add')} ${title}`} icon={<Plus size={14} />}
                  disabled={saving || !composer[provider].trim()} onClick={() => addWords(provider, composer[provider])} />
              </div>
              {entries.length === 0 ? (
                <p className="ec-models-empty">{t('config.sensitiveWords.empty')}</p>
              ) : (
                <ul className="ec-models-word-grid">
                  {entries.map((entry, index) => (
                    <li key={entry.id} className="ec-models-word">
                      <input
                        className="ec-set-input is-wide is-mono"
                        type="text"
                        aria-label={`${title} ${index + 1}`}
                        value={entry.value}
                        disabled={saving}
                        spellCheck={false}
                        onChange={(event) => changeWord(provider, entry.id, event.currentTarget.value)}
                        onPaste={(event) => pasteWords(provider, entry.id, event)}
                      />
                      <IconButton size="sm" label={`${t('common.delete')} ${title} ${index + 1}`} icon={<X size={13} />}
                        disabled={saving} onClick={() => removeWord(provider, entry.id)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SettingsGroup>
        );
      })}

      <SaveBar count={changeCount} busy={saving} saved={justSaved} error={saveError} onSave={() => void save()} onDiscard={discard} />

      <ConfirmDialog
        open={confirmRefresh}
        title={t('config.sensitiveWords.discardTitle')}
        message={t('config.sensitiveWords.discardMessage')}
        confirmLabel={t('common.refresh')}
        onCancel={() => setConfirmRefresh(false)}
        onConfirm={() => { setConfirmRefresh(false); void load(true); }}
      />
    </div>
  );
}
