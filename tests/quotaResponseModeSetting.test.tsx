import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplateConfigSection } from '../src/components/TemplateConfigSection';
import { CoreRuntimeProvider } from '../src/coreRuntime';
import { I18nProvider } from '../src/i18n';
import { templateText } from '../src/i18n/templateConfig';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';
import { routingTemplateGroups } from '../src/services/generalTemplateFields';
import { applyTemplateChanges, draftTemplateField, readTemplatePath, templateFieldValidation } from '../src/services/templateConfig';

const group = routingTemplateGroups.find(item => item.id === 'routing-advanced')!;
const index = group.fields.findIndex(item => item.path.join('.') === 'routing.cooldown.quota-response-mode');
const field = group.fields[index];
const path = ['routing', 'cooldown', 'quota-response-mode'];
const stored = (value: string) => ({ routing: { cooldown: { 'disable-cooling': false, 'quota-response-mode': value } } });

describe('quota response mode setting', () => {
  test('offers the two core values with retryable as the default', () => {
    expect(field).toMatchObject({ type: 'segmented', defaultValue: 'retryable', removeWhenDefault: true });
    expect(field.options?.map(option => option.value)).toEqual(['retryable', 'usage-limit']);
    expect(templateFieldValidation(field, 'usage-limit')).toBeNull();
    expect(templateFieldValidation(field, 'retryable')).toBeNull();
    for (const value of ['usage_limit', '', true, null]) expect(templateFieldValidation(field, value)).not.toBeNull();
  });

  test('writes the key only for usage-limit and removes it when retryable is chosen', () => {
    expect(draftTemplateField(field, {}, undefined, 'retryable')).toBeUndefined();
    expect(draftTemplateField(field, {}, undefined, 'usage-limit')).toEqual({ value: 'usage-limit', remove: false, expectedExists: false, expected: null });
    const removal = draftTemplateField(field, stored('usage-limit'), undefined, 'retryable');
    expect(removal).toEqual({ value: 'retryable', remove: true, expectedExists: true, expected: 'usage-limit' });
    const saved = applyTemplateChanges(stored('usage-limit'), [{ ...removal!, path }]);
    expect(readTemplatePath(saved, path).exists).toBe(false);
    expect(readTemplatePath(saved, ['routing', 'cooldown', 'disable-cooling']).value).toBe(false);
    // An explicit retryable written by hand or by another tool is cleaned up the same way.
    expect(draftTemplateField(field, stored('retryable'), undefined, 'retryable')).toMatchObject({ remove: true, expectedExists: true });
    expect(draftTemplateField(field, stored('usage-limit'), undefined, 'usage-limit')).toBeUndefined();
  });

  test('round-trips through the browser mock configuration', async () => {
    const runtime = createBrowserMockRuntime('running');
    const draft = draftTemplateField(field, await runtime.invoke('get_extended_core_config') as Record<string, unknown>, undefined, 'usage-limit')!;
    const result = await runtime.invoke('save_extended_core_config', { changes: [{ ...draft, path }] }) as { config: Record<string, unknown>; restartRequired: boolean };
    expect(result.restartRequired).toBe(false);
    expect(readTemplatePath(result.config, path).value).toBe('usage-limit');
    const removal = draftTemplateField(field, result.config, undefined, 'retryable')!;
    await runtime.invoke('save_extended_core_config', { changes: [{ ...removal, path, value: null }] });
    expect(readTemplatePath(await runtime.invoke('get_extended_core_config'), path).exists).toBe(false);
  });

  test('renders a labelled two-option control with plain explanations', () => {
    const html = renderToStaticMarkup(<I18nProvider><CoreRuntimeProvider><TemplateConfigSection groups={[group]} /></CoreRuntimeProvider></I18nProvider>);
    const id = `template-${group.id}-${index}`;
    expect(html).toContain(`<span id="${id}-label">When all credentials are out of quota</span>`);
    expect(html).not.toContain(`for="${id}"`);
    expect(html).toMatch(new RegExp(`id="${id}" class="routing-segmented template-config-segmented-control" aria-labelledby="${id}-label" aria-describedby="${id}-notes" role="radiogroup"`));
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-value="retryable"[^>]*>Retry later \(default\)</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*data-value="usage-limit"[^>]*>Report usage limit</);
    for (const option of field.options!) expect(html).toContain(templateText(option.description, 'en'));
    expect(html).toContain('<p data-selected="true"><strong>Retry later (default)</strong>');
    expect(html).toContain('The setting is written only when Report usage limit is selected');
  });

  test('shows the explanations in every shipped language', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'en'] as const) {
      for (const text of [field.label, field.note, ...field.options!.flatMap(option => [option.label, option.description])]) {
        expect(templateText(text, locale).length).toBeGreaterThan(0);
      }
    }
    expect(templateText(field.options![1].label, 'zh-TW')).toBe('報告用量上限');
  });
});
