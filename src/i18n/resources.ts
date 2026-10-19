import { zhTW } from './locales/zh-TW';
import { jaOverrides } from './locales/ja';
import { en } from './locales/en';
import { zhCN, type MessageKey } from './locales/zh-CN';

export { en, zhCN, zhTW };
export type { MessageKey };
export type MessageVariables = Record<string, string | number>;

export const ja: Record<MessageKey, string> = jaOverrides;
