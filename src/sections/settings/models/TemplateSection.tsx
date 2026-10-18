import { useCallback, useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { TemplateConfigSection } from '../../../components/TemplateConfigSection';
import { settingsTemplateGroups } from '../../../services/settingsNavigation';
import type { TemplateConfigGroup } from '../../../services/templateConfig';
import { Badge, Card, Chip } from '../../../ui';
import type { MessageKey } from '../../../i18n/resources';

export type TemplateSectionId = 'requests' | 'oauth' | 'extensions';

const SECTIONS: Record<TemplateSectionId, { titleKey: MessageKey; groups: readonly TemplateConfigGroup[] }> = {
  requests: { titleKey: 'sec.settings.models.tpl.requests', groups: settingsTemplateGroups.requests },
  oauth: { titleKey: 'sec.settings.models.tpl.oauth', groups: settingsTemplateGroups.oauth },
  extensions: { titleKey: 'sec.settings.models.tpl.extensions', groups: settingsTemplateGroups.extensions },
};

/**
 * One collapsible block of extended-config template groups. The (heavy) TemplateConfigSection mounts the first time the
 * block is expanded and then stays mounted so its drafts survive collapsing. Each group keeps its own save button.
 */
export function TemplateSection({ section, defaultOpen = false, onDirtyChange }: {
  section: TemplateSectionId;
  defaultOpen?: boolean;
  onDirtyChange: (section: TemplateSectionId, dirtyGroups: number) => void;
}) {
  const { t } = useI18n();
  const { titleKey, groups } = SECTIONS[section];
  const [open, setOpen] = useState(defaultOpen);
  const [everOpened, setEverOpened] = useState(defaultOpen);
  const [dirtyCount, setDirtyCount] = useState(0);
  const bodyId = useId();
  const visibleGroups = groups.map((group) => group.id);
  const handleDirty = useCallback((ids: readonly string[]) => {
    setDirtyCount(ids.length);
    onDirtyChange(section, ids.length);
  }, [onDirtyChange, section]);
  const toggle = () => {
    setOpen((current) => !current);
    setEverOpened(true);
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Card as="section" className="ec-models-collapsible" data-open={open ? 'true' : 'false'} padded={false}>
      <button type="button" className="ec-models-collapsible-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <Chevron size={16} aria-hidden="true" />
        <h3>{t(titleKey)}</h3>
        <Badge count={groups.length} />
        <span className="ec-set-spacer" />
        {dirtyCount > 0 ? <Chip size="sm" tone="warn">{t('config.network.unsaved')}</Chip> : null}
      </button>
      <div id={bodyId} className="ec-models-collapsible-body" hidden={!open}>
        {everOpened ? (
          <TemplateConfigSection groups={groups} visibleGroups={visibleGroups} onDirtyGroupsChange={handleDirty} />
        ) : null}
      </div>
    </Card>
  );
}
