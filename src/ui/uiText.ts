/**
 * uiText: resolves the shared `ui.*` strings from src/ui/i18n.ts for the active locale.
 *
 * Usage: `const tu = useUiText(); tu('ui.copy'); tu('ui.pagination.range', { from: 1, to: 20, total: 90 })`.
 * Why not `useI18n().t`: the `ui.*` keys are not wired into src/i18n resources, so `t()` cannot type-check them.
 * Common app keys (common.cancel, common.confirm, common.retry, ...) still go through `useI18n().t`.
 * Placeholders are `{name}`; unknown placeholders are left as-is. zh-TW falls back to the zh-CN strings.
 */
import { useCallback } from 'react';
import { useI18n } from '../i18n';
import { uiEn, uiJa, uiZhCN } from './i18n';

export type UiKey = keyof typeof uiZhCN;
export type UiVars = Record<string, string | number>;
export type UiTranslate = (key: UiKey, vars?: UiVars) => string;

const dictionaries: Record<string, Record<string, string>> = {
  en: uiEn,
  ja: uiJa,
  'zh-CN': uiZhCN,
  'zh-TW': uiZhCN,
};

export function translateUi(locale: string, key: UiKey, vars?: UiVars): string {
  const dictionary = dictionaries[locale] ?? uiEn;
  const template = dictionary[key] ?? uiEn[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function useUiText(): UiTranslate {
  const { locale } = useI18n();
  return useCallback((key, vars) => translateUi(locale, key, vars), [locale]);
}
