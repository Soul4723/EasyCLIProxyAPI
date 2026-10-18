// Providers section strings. zh-CN is the key source; en/ja must mirror it (zh-TW is derived automatically).
// Each sub-module (api/, creds/, signin/) owns its own i18n file and key prefix; this file only aggregates.
import { apiEn, apiJa, apiZhCN } from './api/i18n';
import { credsEn, credsJa, credsZhCN } from './creds/i18n';
import { signinEn, signinJa, signinZhCN } from './signin/i18n';

export const providersZhCN = {
  "sec.providers.title": "提供商",
  ...apiZhCN,
  ...credsZhCN,
  ...signinZhCN,
} as const;

export const providersEn: Record<keyof typeof providersZhCN, string> = {
  "sec.providers.title": "Providers",
  ...apiEn,
  ...credsEn,
  ...signinEn,
};

export const providersJa: Record<keyof typeof providersZhCN, string> = {
  "sec.providers.title": "プロバイダー",
  ...apiJa,
  ...credsJa,
  ...signinJa,
};
