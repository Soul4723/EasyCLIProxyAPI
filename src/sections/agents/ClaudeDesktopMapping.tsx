import { ArrowRight, CircleAlert, CircleHelp, Info, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentModelPicker } from '../../components/AgentModelPicker';
import { useI18n } from '../../i18n';
import {
  claudeDesktopAliasSuggestions, claudeDesktopDefaultAliases, desktopAliasNotice, desktopEntryValidation, desktopModelId,
  isClaudeDesktopModel,
} from '../../services/claudeDesktopModels';
import { Button, Card, CardHeader, Dialog, EmptyState, IconButton, Toggle } from '../../ui';
import { ClaudeModelError, useNarrowPanel } from './claudeShared';
import type { AgentsController } from './useAgentsController';
import './claude.css';

type Notice = { tone: 'info' | 'warn'; text: string };

/** Claude Desktop help: the three rules behind aliases (kit Dialog). */
function DesktopHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} size="md" title={t('agents.claudeDesktopMapping.help')}
      footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}>
      <ol className="ag-claude-help">
        <li>{t('agents.claudeDesktopMapping.description')}</li>
        <li>{t('agents.claudeDesktopMapping.collisionHint')}</li>
        <li>{t('agents.claudeDesktopMapping.idHint')}</li>
      </ol>
    </Dialog>
  );
}

/**
 * Claude Desktop model mapping (Setup tab): rows of original model → alias (editable, with suggestions) + 1M toggle +
 * remove, an Add action, the 'use model aliases' switch, collision / validation notices and the usage guide dialog.
 * Props: ctl (AgentsController). Entries are edited through ctl.editDesktopEntries / updateDesktopEntry.
 */
export function ClaudeDesktopMapping({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const [ref, narrow] = useNarrowPanel<HTMLDivElement>();
  const entries = ctl.desktopEntries;
  const resolved = ctl.resolvedDesktopEntries;
  const pickerDisabled = ctl.busy || ctl.loading || !ctl.activeStatus?.installed || !ctl.activeStatus.supportedPlatform;
  const fieldsDisabled = ctl.busy || ctl.loading;

  const notice = (index: number): Notice | null => {
    const entry = resolved[index];
    const entryError = entry.model.trim() ? desktopEntryValidation(entry) : null;
    const aliasNotice = desktopAliasNotice(entry, resolved, ctl.models, ctl.appliedDesktopEntries);
    const suffixed = entries[index].alias.trim().toLowerCase() !== entry.alias.trim().toLowerCase();
    if (suffixed) return { tone: 'info', text: t('agents.claudeDesktopMapping.aliasSuffixed', { alias: entry.alias.trim() }) };
    if (entryError && ctl.hasPendingChanges && !ctl.modelLoading) {
      return { tone: 'warn', text: t(`agents.claudeDesktopMapping.error.${entryError}`) };
    }
    if (aliasNotice === 'aliasExists') {
      return {
        tone: 'warn',
        text: t(claudeDesktopDefaultAliases.includes(entry.alias.trim().toLowerCase())
          ? 'agents.claudeDesktopMapping.defaultAliasExists' : 'agents.claudeDesktopMapping.error.aliasExists',
        { alias: entry.alias.trim() }),
      };
    }
    if (aliasNotice === 'sameModel') return { tone: 'info', text: t('agents.claudeDesktopMapping.sameModel') };
    if (isClaudeDesktopModel(entry.model)) return { tone: 'info', text: t('agents.claudeDesktopMapping.claudeDefault') };
    return null;
  };

  const noticeLine = (tone: Notice['tone'], text: ReactNode) => (
    <p className={`ag-claude-notice ag-claude-notice--${tone}`} role="status">
      {tone === 'warn' ? <CircleAlert size={13} aria-hidden /> : <Info size={13} aria-hidden />}
      <span>{text}</span>
    </p>
  );

  return (
    <Card as="section" className={`ag-claude${narrow ? ' ag-claude--narrow' : ''}`} aria-label={t('agents.claudeDesktopMapping.title')}>
      <div ref={ref}>
        <CardHeader
          title={t('agents.claudeDesktopMapping.title')}
          actions={(
            <>
              <label className="ag-claude-switch" title={t('agents.claudeDesktopMapping.customMappingHint')}>
                <span>{t('agents.claudeDesktopMapping.customMapping')}</span>
                <Toggle size="sm" label={t('agents.claudeDesktopMapping.customMapping')} checked={ctl.claudeCustomMapping}
                  disabled={ctl.busy || ctl.loading || ctl.modelLoading} onChange={ctl.changeClaudeCustomMapping} />
              </label>
              <IconButton size="sm" label={t('agents.claudeDesktopMapping.help')} icon={<CircleHelp size={15} />}
                onClick={() => ctl.setDesktopHelpOpen(true)} />
              <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={fieldsDisabled}
                onClick={() => ctl.editDesktopEntries([...entries, { model: '', alias: '', context1m: false }])}>
                {t('agents.claudeDesktopMapping.add')}
              </Button>
            </>
          )}
        />
        {ctl.modelError ? <ClaudeModelError loading={ctl.modelLoading} onRefresh={ctl.refreshModels} /> : null}
        {!entries.length ? (
          <EmptyState title={t('agents.claudeDesktopMapping.empty')} />
        ) : (
          <div className="ag-claude-table" role="group" aria-label={t('agents.claudeDesktopMapping.title')}>
            <div className="ag-claude-head ag-claude-head--desktop" aria-hidden>
              <span>{t('agents.claudeDesktopMapping.model')}</span>
              <span />
              <span>{t('sec.agents.claude.alias')}</span>
              <span>{t('sec.agents.claude.context')}</span>
              <span />
            </div>
            {resolved.map((entry, index) => {
              const line = notice(index);
              const isClaude = isClaudeDesktopModel(entry.model);
              const suggestions = claudeDesktopAliasSuggestions
                .filter((alias) => !resolved.some((other, i) => i !== index && other.model.trim() && desktopModelId(other).toLowerCase() === alias))
                .map((name) => ({ name, alias: t('agents.claudeDesktopMapping.suggestedAlias') }));
              return (
                <div className="ag-claude-entry" key={index}>
                  <div className="ag-claude-row ag-claude-row--desktop">
                    <div className="ag-claude-target" data-label={t('agents.claudeDesktopMapping.model')}>
                      <AgentModelPicker models={ctl.claudeMappingModels} value={entry.model} loading={ctl.modelLoading}
                        error={ctl.modelError} allowCustomValue disabled={pickerDisabled} onRefresh={ctl.refreshModels}
                        onChange={(model) => ctl.updateDesktopEntry(index, { model, ...(isClaudeDesktopModel(model) ? { alias: '' } : {}) })} />
                    </div>
                    <ArrowRight size={14} className="ag-claude-arrow" aria-hidden />
                    <div className="ag-claude-target" data-label={t('sec.agents.claude.alias')}>
                      <AgentModelPicker models={suggestions} value={entry.alias} loading={false} error="" disabled={fieldsDisabled}
                        editable={{
                          label: t('agents.claudeDesktopMapping.alias'),
                          placeholder: t(isClaude ? 'agents.claudeDesktopMapping.claudeDefault' : 'agents.claudeDesktopMapping.noRename'),
                          maxLength: 128,
                        }}
                        onChange={(alias) => ctl.updateDesktopEntry(index, { alias })} />
                    </div>
                    <span className="ag-claude-ctx" title={t('agents.claudeMapping.context1mHint')}>
                      <Toggle size="sm" label={`${entry.model || t('agents.claudeDesktopMapping.newModel')} 1M`} checked={entry.context1m}
                        disabled={fieldsDisabled} onChange={(on) => ctl.updateDesktopEntry(index, { context1m: on })} />
                      <span>{t('agents.claudeMapping.context1m')}</span>
                    </span>
                    <IconButton size="sm" label={t('agents.claudeDesktopMapping.remove')} icon={<Trash2 size={14} />}
                      disabled={fieldsDisabled} onClick={() => ctl.editDesktopEntries(entries.filter((_, i) => i !== index))} />
                  </div>
                  {line ? noticeLine(line.tone, line.text) : null}
                </div>
              );
            })}
          </div>
        )}
        {ctl.desktopValidation === 'duplicate' && !ctl.modelLoading && ctl.hasPendingChanges
          ? noticeLine('warn', t(`agents.claudeDesktopMapping.error.${ctl.desktopValidation}`)) : null}
      </div>
      <DesktopHelpDialog open={ctl.desktopHelpOpen} onClose={() => ctl.setDesktopHelpOpen(false)} />
    </Card>
  );
}
