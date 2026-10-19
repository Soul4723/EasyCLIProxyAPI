import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { SegmentedControl } from '../../../ui';
import { useRoute } from '../../../shell/router';
import { resolveSettingField } from '../../../services/settingsNavigation';
import { useReportDirty } from '../ui';
import { AliasesPanel } from '../models/AliasesPanel';
import { SensitiveWordsPanel } from '../models/SensitiveWordsPanel';
import { TemplateSection, type TemplateSectionId } from '../models/TemplateSection';
import './ModelsTab.css';

type View = 'aliases' | 'words' | 'defaults';

/**
 * Settings → Models: aliases (each change is written straight to the core config), sensitive words (draft + save bar)
 * and the extended-config template groups (each group has its own save). Panels stay mounted while hidden so drafts
 * survive switching the in-tab view; template groups mount lazily the first time they are expanded.
 */
export function ModelsTab() {
  const { t } = useI18n();
  const [view, setView] = useState<View>('aliases');
  const [visited, setVisited] = useState<Record<View, boolean>>({ aliases: true, words: false, defaults: false });
  const [aliasDirty, setAliasDirty] = useState(false);
  const [wordsDirty, setWordsDirty] = useState(false);
  const [templateDirty, setTemplateDirty] = useState<Partial<Record<TemplateSectionId, number>>>({});

  const onTemplateDirty = useCallback((section: TemplateSectionId, count: number) => {
    setTemplateDirty((current) => (current[section] === count ? current : { ...current, [section]: count }));
  }, []);
  const defaultsDirty = Boolean(templateDirty.requests || templateDirty.oauth);
  useReportDirty('models', aliasDirty || wordsDirty || defaultsDirty);

  // A `?field=` deep link into the template groups opens the Defaults view and expands the block holding the field.
  const linkedField = useRoute().params.get('field');
  const linked = linkedField ? resolveSettingField(linkedField)?.group ?? null : null;
  useEffect(() => { if (linked === 'requests' || linked === 'oauth') choose('defaults'); }, [linked]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (next: View) => {
    setView(next);
    setVisited((current) => (current[next] ? current : { ...current, [next]: true }));
  };
  const label = (key: Parameters<typeof t>[0], dirty: boolean) => (
    <>{t(key)}{dirty ? <span className="ec-models-dirty-dot" role="img" aria-label={t('sec.settings.unsavedDot')} /> : null}</>
  );
  const options = useMemo(() => ([
    { value: 'aliases' as const, label: label('sec.settings.models.view.aliases', aliasDirty) },
    { value: 'words' as const, label: label('sec.settings.models.view.words', wordsDirty) },
    { value: 'defaults' as const, label: label('sec.settings.models.view.defaults', defaultsDirty) },
  ]), [aliasDirty, wordsDirty, defaultsDirty, t]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ec-models-tab">
      <div className="ec-models-views">
        <SegmentedControl<View> ariaLabel={t('sec.settings.models.views')} value={view} onChange={choose} options={options} />
      </div>
      <div className="ec-models-view" hidden={view !== 'aliases'}>
        <AliasesPanel onDirtyChange={setAliasDirty} />
      </div>
      <div className="ec-models-view" hidden={view !== 'words'}>
        {visited.words ? <SensitiveWordsPanel onDirtyChange={setWordsDirty} /> : null}
      </div>
      <div className="ec-models-view" hidden={view !== 'defaults'}>
        {visited.defaults ? (
          <>
            <TemplateSection section="requests" reveal={linked === 'requests'} onDirtyChange={onTemplateDirty} />
            <TemplateSection section="oauth" reveal={linked === 'oauth'} onDirtyChange={onTemplateDirty} />
          </>
        ) : null}
      </div>
    </div>
  );
}
