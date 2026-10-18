import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, Eye, EyeOff, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { providerText } from '../../../i18n/providerTemplate';
import { isRecord, maskSecret, readString } from '../../../services/managementApi';
import {
  fetchModels,
  mergeModelOptions,
  reconcileModelSelection,
  type ModelOption,
  type ModelProvider,
} from '../../../services/modelService';
import { checkProviderModelHealth, PROVIDER_HEALTH_TIMEOUT_MS } from '../../../services/providerHealthCheck';
import { Button, Chip, Dialog, IconButton, Masked, ProviderLogo, StatusPill } from '../../../ui';
import {
  type ProviderCategory, type ProviderDraft, type ProviderRow, type ProviderSaveResult,
  applyProviderPreset, definitionFor, exclusionsForModelSelection, modelSelectionForDiscovery, parseProviderHeaders,
  providerDraftConnection, providerHeadersFromRecord, providerLabel, providerModelType, requestErrorMessage,
} from './logic';
import { brandOfKind } from './kinds';
import { CheckField, Disclosure, ErrorLine, Field, FormGrid, FormSection, SelectInput, TextArea, TextInput } from './fields';
import {
  GroupKeysEditor, ProviderGroupTemplateFields, ProviderKeyTemplateFields, ProviderModelFields,
} from './TemplateFields';
import { ModelTransferDialog } from './ModelTransferDialog';

type CheckState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; model: string; ttft?: number; response?: number }
  | { state: 'error'; message: string };

export type ApiProviderFormProps = {
  kind: ProviderCategory;
  editingRow: ProviderRow | null;
  initialDraft: ProviderDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => Promise<ProviderSaveResult>;
};

/**
 * Add / edit one API-key config. Sections: Basic (name, remark, URL, key) · Models (fetch, manual list, check) ·
 * Advanced (collapsed: model rules, routing, request behaviour). Same validation and discovery as the old dialog.
 */
export function ApiProviderForm({ kind, editingRow, initialDraft, busy, onClose, onSave }: ApiProviderFormProps) {
  const { t } = useI18n();
  const formId = useId();
  const definition = definitionFor(kind);
  const activeSection = definition.section;
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  const grouped = Boolean(draft.groupKeys);
  const [keyVisible, setKeyVisible] = useState(false);
  const [discoveryKeyId, setDiscoveryKeyId] = useState(initialDraft.groupKeys?.[0]?.id ?? '');
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [formError, setFormError] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([]);
  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [thinkingLevelInput, setThinkingLevelInput] = useState('');
  const [check, setCheck] = useState<CheckState>({ state: 'idle' });
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(
    () => new Set(mergeModelOptions(initialDraft.models).map((model) => model.name.toLowerCase())),
  );
  const modelSectionRef = useRef<HTMLDivElement>(null);
  const discoverySelectionInitializedRef = useRef(false);
  const discoveryRequestRef = useRef(0);
  const checkRequestRef = useRef(0);

  const closeModelDiscovery = useCallback(() => {
    discoveryRequestRef.current += 1;
    setModelLoading(false);
    setModelDiscoveryOpen(false);
  }, []);

  useEffect(() => () => { discoveryRequestRef.current += 1; checkRequestRef.current += 1; }, []);

  const modelOptions = useMemo(
    () => mergeModelOptions(discoveredModels, draft.models),
    [discoveredModels, draft.models],
  );
  const configuredModels = useMemo(
    () => draft.models.filter((model) => model.name.trim()),
    [draft.models],
  );
  const selectedModels = useMemo(() => modelOptions.filter((model) =>
    selectedModelNames.has(model.name.toLowerCase()),
  ), [modelOptions, selectedModelNames]);
  const unselectedModels = useMemo(() => modelOptions.filter((model) =>
    !selectedModelNames.has(model.name.toLowerCase()),
  ), [modelOptions, selectedModelNames]);

  // Anything that changes the connection invalidates running discovery and the last check result.
  const resetConnectionState = () => {
    discoveryRequestRef.current += 1;
    checkRequestRef.current += 1;
    setModelLoading(false);
    setModelError('');
    setCheck({ state: 'idle' });
  };

  const updateTextField = (
    field: 'name' | 'apiKey' | 'remark' | 'baseUrl' | 'proxyUrl' | 'priority' | 'prefix' | 'headersText' | 'excludedModelsText' | 'cloakMode' | 'cloakSensitiveWordsText',
    value: string,
  ) => {
    setFormError('');
    if (field === 'apiKey' || field === 'baseUrl' || field === 'headersText') resetConnectionState();
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === 'proxyUrl' ? { proxyUrlEdited: true, proxyUrlMixed: false } : {}),
      ...(field === 'excludedModelsText' ? { modelSelectionCatalog: undefined } : {}),
    }));
  };

  const updateBooleanField = (field: 'websockets' | 'cloakStrictMode', value: boolean) => {
    setFormError('');
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateOptionalBooleanField = (field: 'disableCooling' | 'cloakCacheUserId', value: string) => {
    setFormError('');
    setDraft((current) => ({ ...current, [field]: value === '' ? null : value === 'true' }));
  };

  const updateModels = (update: (models: ModelOption[]) => ModelOption[]) => {
    setDraft((current) => {
      const models = update(current.models);
      return {
        ...current,
        models,
        excludedModelsText: current.modelSelectionCatalog && models.some((model) => model.name.trim())
          ? exclusionsForModelSelection(current.excludedModelsText ?? '', current.modelSelectionCatalog, models)
          : current.excludedModelsText,
      };
    });
  };

  const updateModel = (index: number, patch: Partial<ModelOption>) => {
    updateModels((models) => models.map((model, modelIndex) =>
      modelIndex === index ? { ...model, ...patch } : model,
    ));
  };

  const addModel = () => updateModels((models) => [...models, { name: '', alias: '' }]);
  const removeModel = (index: number) => updateModels((models) => models.filter((_, modelIndex) => modelIndex !== index));

  const addThinkingLevel = () => {
    const level = thinkingLevelInput.trim().toLowerCase();
    if (!level) return;
    setDraft((current) => {
      const levels = current.thinkingLevels ?? [];
      if (levels.some((item) => item.toLowerCase() === level)) return current;
      return { ...current, thinkingLevels: [...levels, level], thinkingLevelsEdited: true };
    });
    setThinkingLevelInput('');
  };

  const removeThinkingLevel = (level: string) => {
    setDraft((current) => ({
      ...current,
      thinkingLevels: (current.thinkingLevels ?? []).filter((item) => item !== level),
      thinkingLevelsEdited: true,
    }));
  };

  const baseUrlRequired = activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';

  // Connection used for discovery and the check: the selected group key, or the single key of the form.
  const connectionForRequests = () => {
    const provider: ModelProvider = kind === 'deepseek' ? 'deepseek' : providerModelType(definition.section);
    const selectedKey = draft.groupKeys?.find((key) => key.id === discoveryKeyId) ?? draft.groupKeys?.[0];
    const connection = selectedKey ? providerDraftConnection(draft, selectedKey) : null;
    const apiKey = connection ? readString(connection, 'api-key') : draft.apiKey.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? '';
    return {
      provider,
      apiKey,
      authIndex: connection ? readString(selectedKey!.value, 'auth-index', 'authIndex') || undefined : editingRow?.authIndex,
      headers: connection ? providerHeadersFromRecord(connection) : parseProviderHeaders(draft.headersText ?? ''),
      proxyUrl: connection ? readString(connection, 'proxy-url') : draft.proxyUrl,
    };
  };

  const discoverModels = async () => {
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(t('apiAccess.error.enterBaseUrl'));
      return;
    }
    const requestId = ++discoveryRequestRef.current;
    setModelLoading(true);
    setModelError('');
    try {
      const connection = connectionForRequests();
      const fetchedModels = await fetchModels(
        connection.provider,
        draft.baseUrl,
        connection.apiKey,
        connection.authIndex,
        connection.headers,
        undefined,
        connection.proxyUrl,
      );
      if (requestId !== discoveryRequestRef.current) return;
      const models = applyProviderPreset(kind, { ...draft, models: fetchedModels }).models;
      const initialized = discoverySelectionInitializedRef.current;
      setDiscoveredModels(models);
      setSelectedModelNames((current) =>
        initialized
          ? reconcileModelSelection(models, draft.models, current, 'refresh')
          : modelSelectionForDiscovery(draft.models, models, draft.excludedModelsText ?? ''));
      discoverySelectionInitializedRef.current = true;
      if (!models.length) setModelError(t('apiAccess.error.noAvailableModels'));
    } catch (requestError) {
      if (requestId === discoveryRequestRef.current) setModelError(requestErrorMessage(requestError));
    } finally {
      if (requestId === discoveryRequestRef.current) setModelLoading(false);
    }
  };

  const openModelDiscovery = () => {
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(t('apiAccess.error.baseBeforeModels'));
      return;
    }
    discoverySelectionInitializedRef.current = false;
    setSelectedModelNames(modelSelectionForDiscovery(draft.models, discoveredModels, draft.excludedModelsText ?? ''));
    setModelDiscoveryOpen(true);
    void discoverModels();
  };

  const moveModels = (models: ModelOption[], selected: boolean) => {
    discoverySelectionInitializedRef.current = true;
    setSelectedModelNames((current) => {
      const next = new Set(current);
      models.forEach((model) => {
        const key = model.name.toLowerCase();
        if (selected) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  };

  const applyModelSelection = () => {
    if (modelLoading || selectedModels.length === 0) return;
    setDraft((current) => ({
      ...current,
      models: selectedModels.flatMap((selected) => {
        const existing = current.models.filter((model) => model.name.toLowerCase() === selected.name.toLowerCase());
        return existing.length ? existing : [selected];
      }),
      modelSelectionCatalog: activeSection === 'openai-compatibility' ? undefined : discoveredModels,
      excludedModelsText: activeSection === 'openai-compatibility'
        ? current.excludedModelsText
        : exclusionsForModelSelection(current.excludedModelsText ?? '', discoveredModels, selectedModels),
    }));
    closeModelDiscovery();
  };

  // "Check": one minimal streaming request with the draft's own connection (first configured, else first upstream model).
  const runCheck = async () => {
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setCheck({ state: 'error', message: t('apiAccess.error.enterBaseUrl') });
      return;
    }
    const requestId = ++checkRequestRef.current;
    setCheck({ state: 'checking' });
    try {
      const connection = connectionForRequests();
      let model = configuredModels[0]?.name ?? discoveredModels[0]?.name;
      if (!model) {
        const fetched = await fetchModels(connection.provider, draft.baseUrl, connection.apiKey, connection.authIndex, connection.headers, undefined, connection.proxyUrl);
        model = fetched[0]?.name;
      }
      if (requestId !== checkRequestRef.current) return;
      if (!model) {
        setCheck({ state: 'error', message: t('apiAccess.health.noModel') });
        return;
      }
      const result = await checkProviderModelHealth({
        provider: connection.provider,
        baseUrl: draft.baseUrl,
        apiKeys: [connection.apiKey],
        authIndex: connection.authIndex,
        customHeaders: connection.headers,
        proxyUrl: connection.proxyUrl,
        timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
      }, model);
      if (requestId !== checkRequestRef.current) return;
      setCheck(result.status === 'healthy'
        ? { state: 'ok', model, ttft: result.firstTokenLatencyMs, response: result.responseLatencyMs }
        : {
          state: 'error',
          message: result.errorCode === 'missing-direct-key'
            ? t('apiAccess.health.missingDirectKey')
            : result.timedOut ? t('apiAccess.health.timeout') : result.error || t('apiAccess.health.failed'),
        });
    } catch (requestError) {
      if (requestId === checkRequestRef.current) setCheck({ state: 'error', message: requestErrorMessage(requestError) });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const result = await onSave(draft);
    if (result.saved) {
      onClose();
      return;
    }
    if (result.target === 'models') {
      setModelError(result.error);
      window.requestAnimationFrame(() => {
        modelSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }
    setFormError(result.error);
  };

  const hasModelExclusions = activeSection !== 'openai-compatibility' && Boolean(draft.excludedModelsText?.trim());
  const modelSummaryTitle = configuredModels.length > 0
    ? t('apiAccess.models.selected', { count: configuredModels.length })
    : kind === 'deepseek'
      ? t('apiAccess.models.selectionRequired')
      : hasModelExclusions
        ? t('apiAccess.models.restricted')
        : activeSection === 'openai-compatibility'
          ? t('apiAccess.models.autoAll')
          : t('apiAccess.models.upstreamDefault');
  const modelSummaryDetail = configuredModels.length > 0
    ? configuredModels.slice(0, 3).map((model) => model.name).join('、')
    : kind === 'deepseek'
      ? t('apiAccess.models.selectionRequiredHint')
      : hasModelExclusions
        ? t('apiAccess.models.hiddenHint')
        : activeSection === 'openai-compatibility'
          ? t('apiAccess.models.autoHint')
          : t('apiAccess.models.allHint');

  const label = providerLabel(definition);
  const title = t(definition.openAi
    ? editingRow ? 'apiAccess.entries.editProvider' : 'apiAccess.entries.addProvider'
    : editingRow ? 'apiAccess.entries.editKey' : 'apiAccess.entries.addKey');
  const advancedCount = [draft.prefix, draft.excludedModelsText, draft.headersText, draft.proxyUrl, draft.priority, draft.weight]
    .filter((value) => value && String(value).trim()).length;

  return (
    <>
      <Dialog
        open
        size="lg"
        onClose={onClose}
        dismissible={!busy}
        title={(
          <span className="ec-api-form-title">
            <ProviderLogo provider={brandOfKind(kind)} size={22} />
            <span>{title}</span>
            <span className="ec-api-subtitle">{label}</span>
          </span>
        )}
        footer={(
          <>
            <div className="ec-api-footer-error">{formError ? <ErrorLine message={formError} onDismiss={() => setFormError('')} /> : null}</div>
            <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form={formId} loading={busy}>{busy ? t('common.saving') : t('common.save')}</Button>
          </>
        )}
      >
        <form id={formId} className="ec-api-form" onSubmit={(event) => void submit(event)}>
          <FormSection title={t('sec.providers.api.form.basic')}>
            <FormGrid>
              {definition.openAi ? (
                <Field label={t('apiAccess.entries.name')}>
                  <TextInput autoFocus value={draft.name} maxLength={80} onChange={(event) => updateTextField('name', event.currentTarget.value)} placeholder={t('apiAccess.entries.namePlaceholder')} />
                </Field>
              ) : null}
              <Field label={t('apiAccess.field.remark')} wide={!definition.openAi}>
                <TextInput value={draft.remark} maxLength={80} onChange={(event) => updateTextField('remark', event.currentTarget.value)} placeholder={t('apiAccess.remarkPlaceholder')} />
              </Field>
              <Field label={t('apiAccess.field.baseUrl')} wide>
                <TextInput value={draft.baseUrl} onChange={(event) => updateTextField('baseUrl', event.currentTarget.value)} placeholder={baseUrlRequired ? t('apiAccess.baseRequiredPlaceholder') : t('apiAccess.baseOptionalPlaceholder')} />
              </Field>
            </FormGrid>
            {!definition.openAi ? (
              <div className="ec-api-secret">
                <Field label={t('apiAccess.field.key')}>
                  <TextInput autoFocus type={keyVisible ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                    value={draft.apiKey} onChange={(event) => updateTextField('apiKey', event.currentTarget.value)} placeholder="sk-..." />
                </Field>
                <IconButton
                  label={t(keyVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
                  icon={keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                  active={keyVisible}
                  onClick={() => setKeyVisible((value) => !value)}
                />
              </div>
            ) : null}
            {draft.groupKeys ? (
              <GroupKeysEditor keys={draft.groupKeys} disabled={busy} onChange={(groupKeys) => {
                resetConnectionState();
                setFormError('');
                setDraft((current) => ({ ...current, groupKeys }));
              }} />
            ) : null}
          </FormSection>

          <div ref={modelSectionRef}>
            <FormSection
              title={t('apiAccess.models.title')}
              action={(
                <div className="ec-api-section__actions">
                  <Button size="sm" icon={<RefreshCw size={13} />} onClick={openModelDiscovery} disabled={busy}>{t('apiAccess.models.fetch')}</Button>
                  <Button size="sm" icon={<Activity size={13} />} onClick={() => void runCheck()} disabled={busy || check.state === 'checking'} loading={check.state === 'checking'}>
                    {t('sec.providers.api.form.check')}
                  </Button>
                </div>
              )}
            >
              {(draft.groupKeys?.length ?? 0) > 1 ? (
                <Field label={t('apiAccess.entries.discoveryKey')}>
                  <SelectInput
                    value={draft.groupKeys!.some((key) => key.id === discoveryKeyId) ? discoveryKeyId : draft.groupKeys![0].id}
                    onChange={(event) => { resetConnectionState(); setDiscoveryKeyId(event.currentTarget.value); }}
                  >
                    {draft.groupKeys!.map((key, index) => (
                      <option value={key.id} key={key.id}>{t('apiAccess.entries.keyNumber', { number: index + 1 })} · {maskSecret(readString(key.value, 'api-key'))}</option>
                    ))}
                  </SelectInput>
                </Field>
              ) : null}
              <div className={`ec-api-model-summary${configuredModels.length || hasModelExclusions ? ' is-set' : ''}`}>
                <strong>{modelSummaryTitle}</strong>
                <span className="ec-trunc">{modelSummaryDetail}</span>
                {check.state === 'ok' ? (
                  <StatusPill size="sm" status="available" label={`${t('apiAccess.health.healthy')}${check.ttft !== undefined ? ` · ${t('apiAccess.health.firstTokenInline', { latency: check.ttft })}` : check.response !== undefined ? ` · ${t('apiAccess.health.responseInline', { latency: check.response })}` : ''}`} />
                ) : null}
              </div>
              {check.state === 'error' ? <ErrorLine message={check.message} onDismiss={() => setCheck({ state: 'idle' })} /> : null}
              <div className="ec-api-model-rows">
                {draft.models.map((model, index) => (
                  <div className="ec-api-model" key={index}>
                    <div className="ec-api-model__row">
                      <TextInput value={model.name} onChange={(event) => updateModel(index, { name: event.currentTarget.value })}
                        placeholder={t('apiAccess.models.namePlaceholder')} aria-label={t('apiAccess.models.namePlaceholder')} disabled={busy} />
                      <TextInput value={model.alias ?? ''} onChange={(event) => updateModel(index, { alias: event.currentTarget.value })}
                        placeholder={t('apiAccess.models.aliasPlaceholder')} aria-label={t('apiAccess.models.aliasPlaceholder')} disabled={busy} />
                      <IconButton size="sm" label={t('apiAccess.models.remove')} icon={<Trash2 size={14} />} onClick={() => removeModel(index)} disabled={busy} />
                    </div>
                    <ProviderModelFields section={activeSection} value={model.config ?? { ...(model.thinking ? { thinking: model.thinking } : {}) }}
                      onChange={(config) => updateModel(index, { config, thinking: isRecord(config.thinking) ? config.thinking : undefined })} />
                  </div>
                ))}
                <Button size="sm" icon={<Plus size={13} />} onClick={addModel} disabled={busy}>{t('apiAccess.models.add')}</Button>
              </div>
              {modelError && !modelDiscoveryOpen ? <ErrorLine message={modelError} onDismiss={() => setModelError('')} /> : null}
            </FormSection>
          </div>

          <Disclosure title={t('apiAccess.advanced')} meta={advancedCount || undefined}>
            <div className="ec-api-advanced">
              <FormSection title={providerText('modelRules')}>
                <Field label={t('apiAccess.field.prefix')}>
                  <TextInput value={draft.prefix ?? ''} onChange={(event) => updateTextField('prefix', event.currentTarget.value)} placeholder={t('apiAccess.prefixPlaceholder')} />
                </Field>
                {activeSection !== 'openai-compatibility' ? (
                  <Field label={t('apiAccess.field.excludedModels')} wide>
                    <TextArea value={draft.excludedModelsText ?? ''} onChange={(event) => updateTextField('excludedModelsText', event.currentTarget.value)} rows={3} placeholder={'model-old-*\nmodel-preview'} />
                  </Field>
                ) : null}
                {kind === 'openai-compatibility' ? (
                  <div className="ec-api-thinking">
                    <div className="ec-api-thinking__head"><strong>{t('apiAccess.thinking.title')}</strong><small>{t('apiAccess.thinking.description')}</small></div>
                    <div className="ec-api-thinking__entry">
                      <TextInput
                        value={thinkingLevelInput}
                        onChange={(event) => setThinkingLevelInput(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addThinkingLevel();
                          }
                        }}
                        placeholder={t('apiAccess.thinking.placeholder')}
                      />
                      <Button size="sm" icon={<Plus size={13} />} onClick={addThinkingLevel} disabled={!thinkingLevelInput.trim()}>{t('apiAccess.thinking.add')}</Button>
                    </div>
                    {(draft.thinkingLevels?.length ?? 0) > 0 ? (
                      <div className="ec-api-chips">
                        {draft.thinkingLevels?.map((level) => (
                          <Chip key={level} onRemove={() => removeThinkingLevel(level)} removeLabel={t('apiAccess.thinking.deleteAria', { level })}>{level}</Chip>
                        ))}
                      </div>
                    ) : <small className="ec-api-field__hint">{t('apiAccess.thinking.empty')}</small>}
                  </div>
                ) : null}
              </FormSection>

              <FormSection title={providerText('connectionRouting')}>
                <FormGrid>
                  <Field label={t('apiAccess.field.priority')}>
                    <TextInput type="number" step="1" value={draft.priority} onChange={(event) => updateTextField('priority', event.currentTarget.value)} placeholder={t('common.optional')} />
                  </Field>
                  {!definition.openAi ? (
                    <>
                      <Field label={t('apiAccess.entries.weight')}>
                        <TextInput type="number" step="1" max="1000000" value={draft.weight ?? ''} placeholder="1"
                          onChange={(event) => { const weight = event.currentTarget.value; setDraft((current) => ({ ...current, weight })); }} />
                      </Field>
                      <Field label={t('apiAccess.field.proxyUrl')} wide>
                        <TextInput value={draft.proxyUrl ?? ''} onChange={(event) => updateTextField('proxyUrl', event.currentTarget.value)} placeholder="socks5://127.0.0.1:1080" />
                      </Field>
                    </>
                  ) : null}
                </FormGrid>
              </FormSection>

              <FormSection title={providerText('requestBehavior')}>
                {!definition.openAi ? <ProviderKeyTemplateFields section={activeSection} value={draft.templateFields ?? {}} inherited={{}} onChange={(templateFields) => setDraft((current) => ({ ...current, templateFields }))} /> : null}
                <ProviderGroupTemplateFields section={activeSection} includeErrors={definition.openAi} value={draft.templateFields ?? {}} onChange={(templateFields) => setDraft((current) => ({ ...current, templateFields }))} />
                <Field label={t('apiAccess.field.headers')} hint={providerText('headersHint')} wide>
                  <TextArea value={draft.headersText ?? ''} onChange={(event) => updateTextField('headersText', event.currentTarget.value)} rows={3} placeholder={'X-Team: production\nAuthorization: Bearer ...'} />
                </Field>
                {!grouped && activeSection === 'claude-api-key' ? (
                  <div className="ec-api-subgroup">
                    <FormGrid>
                      <Field label={t('apiAccess.cloak.mode')}>
                        <SelectInput value={draft.cloakMode ?? ''} onChange={(event) => updateTextField('cloakMode', event.currentTarget.value)}>
                          <option value="">{t('apiAccess.cloak.default')}</option>
                          <option value="auto">{t('apiAccess.cloak.auto')}</option>
                          <option value="always">{t('apiAccess.cloak.always')}</option>
                          <option value="never">{t('apiAccess.cloak.never')}</option>
                        </SelectInput>
                      </Field>
                      <Field label={t('apiAccess.cloak.cacheUser')}>
                        <SelectInput aria-label={t('apiAccess.cloak.cacheUser')} value={draft.cloakCacheUserId == null ? '' : String(draft.cloakCacheUserId)} onChange={(event) => updateOptionalBooleanField('cloakCacheUserId', event.currentTarget.value)}>
                          <option value="">{t('apiAccess.option.inherit')}</option>
                          <option value="true">{t('common.enabled')}</option>
                          <option value="false">{t('common.disabled')}</option>
                        </SelectInput>
                      </Field>
                    </FormGrid>
                    <Field label={t('apiAccess.cloak.words')} wide>
                      <TextArea value={draft.cloakSensitiveWordsText ?? ''} onChange={(event) => updateTextField('cloakSensitiveWordsText', event.currentTarget.value)} rows={3} placeholder={'internal-name\nworkspace-id'} />
                    </Field>
                    <CheckField label={t('apiAccess.cloak.strict')} checked={Boolean(draft.cloakStrictMode)} onChange={(checked) => updateBooleanField('cloakStrictMode', checked)} />
                  </div>
                ) : null}
                {!grouped && (activeSection === 'codex-api-key' || activeSection === 'xai-api-key') ? (
                  <CheckField label={<>WebSocket <small className="ec-api-field__hint">{t('apiAccess.websocket.description')}</small></>} checked={Boolean(draft.websockets)} onChange={(checked) => updateBooleanField('websockets', checked)} />
                ) : null}
                <Field label={t('apiAccess.cooling.title')} hint={t('apiAccess.cooling.description')}>
                  <SelectInput aria-label={t('apiAccess.cooling.title')} value={draft.disableCooling == null ? '' : String(draft.disableCooling)} onChange={(event) => updateOptionalBooleanField('disableCooling', event.currentTarget.value)}>
                    <option value="">{t('apiAccess.option.inherit')}</option>
                    <option value="true">{t('apiAccess.cooling.disable')}</option>
                    <option value="false">{t('apiAccess.cooling.enable')}</option>
                  </SelectInput>
                </Field>
              </FormSection>
            </div>
          </Disclosure>
        </form>
      </Dialog>

      {modelDiscoveryOpen ? (
        <ModelTransferDialog
          providerLabel={label}
          found={modelOptions.length}
          unselected={unselectedModels}
          selected={selectedModels}
          loading={modelLoading}
          error={modelError}
          onMove={moveModels}
          onRefresh={() => void discoverModels()}
          onApply={applyModelSelection}
          onClose={closeModelDiscovery}
          onDismissError={() => setModelError('')}
        />
      ) : null}
    </>
  );
}

/** Masked one-line summary of a row's key(s), shared by the list and dialogs. */
export function KeySummary({ row }: { row: Pick<ProviderRow, 'apiKey' | 'apiKeys'> }) {
  const { t } = useI18n();
  if (!row.apiKey) return null;
  return (
    <span className="ec-api-keysummary" title={t('apiAccess.keys.count', { count: row.apiKeys.length })}>
      <Masked kind="identifier" mono value={maskSecret(row.apiKey)} />
      {row.apiKeys.length > 1 ? <span className="ec-api-keysummary__more">+{row.apiKeys.length - 1}</span> : null}
    </span>
  );
}
