/**
 * Provider registry: the single map from provider ids and aliases to display name, colour token and logo.
 *
 * providerInfo(idOrAlias) never throws. Unknown names return id 'other' with the original string as the name.
 * `invertInDark` marks logos that are monochrome (or mixed with currentColor) and need inverting on the dark
 * theme; ProviderLogo applies it. OpenRouter has no logo asset, so it renders a monogram.
 */
import claudeLogo from '../assets/icons/claude.svg';
import codexLogo from '../assets/icons/codex.svg';
import antigravityLogo from '../assets/icons/antigravity.svg';
import grokLogo from '../assets/icons/grok.svg';
import kimiLogo from '../assets/icons/kimi-light.svg';
import devinLogo from '../assets/icons/devin.svg';
import geminiLogo from '../assets/icons/gemini.svg';
import vertexLogo from '../assets/icons/vertex.svg';
import openaiLogo from '../assets/icons/openai-light.svg';
import deepseekLogo from '../assets/icons/deepseek.svg';
import copilotLogo from '../assets/icons/copilot.svg';

export type ProviderId =
  | 'claude'
  | 'codex'
  | 'antigravity'
  | 'xai'
  | 'kimi'
  | 'devin'
  | 'gemini'
  | 'vertex'
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'copilot'
  | 'other';

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  colorVar: string;
  icon?: string;
  invertInDark?: 'invert' | 'invert-hue';
};

type KnownProviderId = Exclude<ProviderId, 'other'>;

const PROVIDERS: Record<KnownProviderId, Omit<ProviderInfo, 'id'>> = {
  claude: { name: 'Claude', colorVar: 'var(--ec-p-claude)', icon: claudeLogo },
  codex: { name: 'Codex', colorVar: 'var(--ec-p-codex)', icon: codexLogo },
  antigravity: { name: 'Antigravity', colorVar: 'var(--ec-p-antigravity)', icon: antigravityLogo },
  xai: { name: 'xAI', colorVar: 'var(--ec-p-xai)', icon: grokLogo, invertInDark: 'invert' },
  kimi: { name: 'Kimi', colorVar: 'var(--ec-p-kimi)', icon: kimiLogo, invertInDark: 'invert-hue' },
  devin: { name: 'Devin', colorVar: 'var(--ec-p-devin)', icon: devinLogo, invertInDark: 'invert' },
  gemini: { name: 'Gemini', colorVar: 'var(--ec-p-gemini)', icon: geminiLogo },
  vertex: { name: 'Vertex AI', colorVar: 'var(--ec-p-vertex)', icon: vertexLogo },
  openai: { name: 'OpenAI', colorVar: 'var(--ec-p-openai)', icon: openaiLogo, invertInDark: 'invert' },
  deepseek: { name: 'DeepSeek', colorVar: 'var(--ec-p-deepseek)', icon: deepseekLogo },
  openrouter: { name: 'OpenRouter', colorVar: 'var(--ec-p-openrouter)' },
  copilot: { name: 'Copilot', colorVar: 'var(--ec-p-copilot)', icon: copilotLogo, invertInDark: 'invert' },
};

const ALIASES = new Map<string, KnownProviderId>([
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['claude-code', 'claude'],
  ['codex', 'codex'],
  ['antigravity', 'antigravity'],
  ['xai', 'xai'],
  ['x-ai', 'xai'],
  ['grok', 'xai'],
  ['kimi', 'kimi'],
  ['devin', 'devin'],
  ['gemini', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['google', 'gemini'],
  ['aistudio', 'gemini'],
  ['vertex', 'vertex'],
  ['vertex-ai', 'vertex'],
  ['openai', 'openai'],
  ['openai-compatible', 'openai'],
  ['openai-compatibility', 'openai'],
  ['deepseek', 'deepseek'],
  ['openrouter', 'openrouter'],
  ['copilot', 'copilot'],
  ['github-copilot', 'copilot'],
]);

export function providerInfo(idOrAlias: string): ProviderInfo {
  const id = ALIASES.get(idOrAlias.trim().toLowerCase());
  if (!id) return { id: 'other', name: idOrAlias, colorVar: 'var(--ec-p-other)' };
  return { id, ...PROVIDERS[id] };
}
