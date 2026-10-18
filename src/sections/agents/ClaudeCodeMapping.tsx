import { ArrowRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { AgentModelPicker } from '../../components/AgentModelPicker';
import { useI18n } from '../../i18n';
import {
  claudeCodeModelBase, claudeCodeModelPreview, claudeCodeRoles, followClaudeCodeContextWindow,
  isKnownClaudeCodeModel,
} from '../../services/claudeCodeModels';
import { Card, CardHeader, Toggle } from '../../ui';
import { ClaudeModelError, useNarrowPanel } from './claudeShared';
import type { AgentsController } from './useAgentsController';
import './claude.css';

type Field = 'startupModel' | 'subagentModel';

const roleLabel = (role: string) => role[0].toUpperCase() + role.slice(1);

/**
 * Claude Code model mapping (Setup tab): "asks for → send to" rows per role with a 1M toggle, startup and subagent
 * model rows, the 'use model aliases' switch and the collapsible advanced context / auto-compact settings.
 * Props: ctl (AgentsController). All edits go through ctl handlers; nothing is saved until the Setup tab applies.
 */
export function ClaudeCodeMapping({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const [ref, narrow] = useNarrowPanel<HTMLDivElement>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const routes = ctl.claudeModelMappingsDraft;
  const rolesDisabled = ctl.busy || !ctl.activeStatus?.installed || !ctl.activeStatus.supportedPlatform;
  const fieldsDisabled = ctl.busy || ctl.loading;
  const advancedDisabled = ctl.busy || ctl.loading || ctl.modelLoading;

  const setField = (field: Field, value: string) => ctl.editClaudeModelMappings((current) => followClaudeCodeContextWindow(
    {
      ...current,
      [field]: value,
      [field === 'startupModel' ? 'manageDefaultModel' : 'manageSubagentModel']: value.trim().length > 0,
    },
    current.maxContextTokens,
    true,
  ));

  const fieldOptions = [
    ...claudeCodeRoles.map((role) => ({
      name: role,
      alias: t('agents.claudeCodeRuntime.followRole', { role, model: claudeCodeModelPreview(role, routes).model || '—' }),
    })),
    ...ctl.models.filter((model) => !claudeCodeRoles.some((role) => role === model.name.toLowerCase()))
      .map((model) => ({ ...model, alias: t('agents.claudeCodeRuntime.directOption') })),
  ];

  const maxTokens = routes.maxContextTokens;
  const maxTokensInvalid = !(maxTokens >= 100_000 && maxTokens <= 1_000_000);
  const pct = routes.autoCompactPct;
  const pctInvalid = !(pct >= 1 && pct <= 100);

  const fieldRow = (field: Field) => {
    const value = field === 'startupModel' ? routes.startupModel || 'opus' : routes.subagentModel;
    const preview = claudeCodeModelPreview(value, routes);
    const label = t(field === 'startupModel' ? 'sec.agents.claude.startupRow' : 'sec.agents.claude.subagentRow');
    const unknown = !ctl.modelLoading && !isKnownClaudeCodeModel(value, ctl.models);
    return (
      <div className="ag-claude-row" key={field} data-field={field}>
        <span className="ag-claude-name">{label}</span>
        <ArrowRight size={14} className="ag-claude-arrow" aria-hidden />
        <div className="ag-claude-target">
          <AgentModelPicker
            models={fieldOptions} value={value} disabled={fieldsDisabled} loading={ctl.modelLoading} allowCustomValue
            emptyOption={field === 'subagentModel' ? t('agents.claudeCodeRuntime.subagentModelPlaceholder') : undefined}
            editable={{
              label,
              placeholder: t(`agents.claudeCodeRuntime.${field}Placeholder`),
              maxLength: 240,
            }}
            onChange={(next) => setField(field, field === 'startupModel' ? next.trim() || 'opus' : next)}
          />
          {unknown ? <small className="ag-claude-hint ag-claude-hint--warn" role="status">{t('agents.claudeCodeRuntime.unverifiedModel')}</small> : null}
        </div>
        <span className="ag-claude-ctx" title={preview.role ? t('sec.agents.claude.followsRole', { role: roleLabel(preview.role) }) : t('agents.claudeMapping.context1mHint')}>
          <Toggle size="sm" label={`${label} 1M`} checked={preview.context1m}
            disabled={fieldsDisabled || !value.trim() || Boolean(preview.role)}
            onChange={(on) => setField(field, claudeCodeModelBase(value) + (on ? '[1m]' : ''))} />
          <span>{t('agents.claudeMapping.context1m')}</span>
        </span>
      </div>
    );
  };

  return (
    <Card as="section" className={`ag-claude${narrow ? ' ag-claude--narrow' : ''}`} aria-label={t('agents.claudeCodeMapping.title')}>
      <div ref={ref}>
        <CardHeader
          title={t('sec.agents.claude.mappingFor')}
          actions={(
            <label className="ag-claude-switch" title={t('agents.claudeDesktopMapping.customMappingHint')}>
              <span>{t('agents.claudeDesktopMapping.customMapping')}</span>
              <Toggle size="sm" label={t('agents.claudeDesktopMapping.customMapping')} checked={ctl.claudeCustomMapping}
                disabled={ctl.busy || ctl.loading || ctl.modelLoading} onChange={ctl.changeClaudeCustomMapping} />
            </label>
          )}
        />
        {ctl.modelError ? <ClaudeModelError loading={ctl.modelLoading} onRefresh={ctl.refreshModels} /> : null}
        <div className="ag-claude-table" role="group" aria-label={t('agents.claudeCodeRuntime.modelMappings')}>
          <div className="ag-claude-head" aria-hidden>
            <span>{t('sec.agents.claude.asksFor', { client: ctl.activeDefinition.name })}</span>
            <span />
            <span>{t('sec.agents.claude.sendTo')}</span>
            <span>{t('sec.agents.claude.context')}</span>
          </div>
          {claudeCodeRoles.map((role) => (
            <div className="ag-claude-row" key={role} data-role={role}>
              <span className="ag-claude-name">{roleLabel(role)}</span>
              <ArrowRight size={14} className="ag-claude-arrow" aria-hidden />
              <div className="ag-claude-target">
                <AgentModelPicker preserveValue models={ctl.claudeMappingModels} value={routes[role]}
                  loading={ctl.modelLoading} error={ctl.modelError} disabled={rolesDisabled}
                  onChange={(value) => ctl.selectClaudeModelMapping(role, value)} onRefresh={ctl.refreshModels} />
              </div>
              <span className="ag-claude-ctx" title={t('agents.claudeMapping.context1mHint')}>
                <Toggle size="sm" label={`${roleLabel(role)} 1M`} checked={routes[`${role}1m`]} disabled={rolesDisabled}
                  onChange={(on) => ctl.changeClaude1mPreference(`${role}1m`, on)} />
                <span>{t('agents.claudeMapping.context1m')}</span>
              </span>
            </div>
          ))}
          <div className="ag-claude-sep" aria-hidden />
          {fieldRow('startupModel')}
          {fieldRow('subagentModel')}
        </div>

        <div className="ag-claude-advanced">
          <button type="button" className="ag-claude-advanced-toggle" aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}>
            <ChevronDown size={14} aria-hidden className={advancedOpen ? 'is-open' : ''} />
            <span>{t('agents.claudeCodeRuntime.advancedContext')}</span>
          </button>
          {advancedOpen ? (
            <div className="ag-claude-advanced-body">
              <div className="ag-claude-field" title={t('agents.claudeCodeRuntime.maxContextTokensHint')}>
                <label htmlFor="ag-claude-max-context">{t('agents.claudeCodeRuntime.maxContextTokens')}</label>
                <div className={`ag-claude-input${maxTokensInvalid ? ' is-invalid' : ''}`}>
                  <input id="ag-claude-max-context" type="number" min={100_000} max={1_000_000} step={1_000}
                    value={maxTokens} disabled={advancedDisabled} aria-invalid={maxTokensInvalid}
                    onChange={(event) => ctl.changeClaudeCodeRuntimeSetting('maxContextTokens', Math.trunc(event.currentTarget.valueAsNumber || 0))} />
                  <span>{t('sec.agents.claude.tokens')}</span>
                </div>
                {maxTokensInvalid ? <small className="ag-claude-hint ag-claude-hint--error" role="alert">{t('sec.agents.claude.rangeContext')}</small> : null}
              </div>
              <div className="ag-claude-field" title={t('agents.claudeCodeRuntime.autoCompactPctHint')}>
                <label htmlFor="ag-claude-auto-compact">{t('agents.claudeCodeRuntime.autoCompactPct')}</label>
                <div className={`ag-claude-input${pctInvalid && !routes.disableAutoCompact ? ' is-invalid' : ''}`}>
                  <input id="ag-claude-auto-compact" type="number" min={1} max={100} step={1} value={pct}
                    disabled={advancedDisabled || routes.disableAutoCompact} aria-invalid={pctInvalid}
                    onChange={(event) => ctl.changeClaudeCodeRuntimeSetting('autoCompactPct', Math.trunc(event.currentTarget.valueAsNumber || 0))} />
                  <span>%</span>
                </div>
                {pctInvalid ? <small className="ag-claude-hint ag-claude-hint--error" role="alert">{t('sec.agents.claude.rangePct')}</small> : null}
              </div>
              <label className="ag-claude-switch ag-claude-field" title={t('agents.claudeCodeRuntime.disableAutoCompactHint')}>
                <span>{t('agents.claudeCodeRuntime.disableAutoCompact')}</span>
                <Toggle size="sm" label={t('agents.claudeCodeRuntime.disableAutoCompact')} checked={routes.disableAutoCompact}
                  disabled={advancedDisabled} onChange={ctl.changeClaudeCodeAutoCompactDisabled} />
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
