import { getCurrentLocale, translate } from '../../../i18n';

/** Pure alias helpers + types for Settings → Models (same behaviour as the retired ThinkingAliasesPage helpers). */

export type ModelAliasPosition = { section: string; providerIndex: number | null; modelIndex: number };

export type ThinkingAliasEntry = {
  position: ModelAliasPosition;
  sourceModel: string;
  alias: string;
  effort: string | null;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
};

export type SpeedAliasEntry = {
  position: ModelAliasPosition;
  sourceModel: string;
  alias: string;
  serviceTier: string;
  provider: string;
  kind: string;
  oauthChannel?: string | null;
};

export type AliasListEntry = ThinkingAliasEntry & { serviceTier: string | null };

export type ThinkingAliasSource = {
  id: string;
  model: string;
  displayName: string | null;
  provider: string;
  kind: string;
  protocol: string;
  reasoningLevels: string[];
};

export type ModelAliasSource = ThinkingAliasSource & { supportsReasoning: boolean; supportsFast: boolean };

export type ModelAliasEditContext = { source: ThinkingAliasSource; effort: string | null; fast: boolean };

export const EFFORT_HINT_KEYS = {
  low: 'aliases.effort.low',
  medium: 'aliases.effort.medium',
  high: 'aliases.effort.high',
  xhigh: 'aliases.effort.xhigh',
  max: 'aliases.effort.max',
} as const;

export const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };

export const combineModelAliasEntries = (
  thinkingEntries: ThinkingAliasEntry[],
  speedEntries: SpeedAliasEntry[],
): AliasListEntry[] => {
  const entries = new Map<string, AliasListEntry>();
  const entryKey = (entry: ThinkingAliasEntry | SpeedAliasEntry) => JSON.stringify([
    entry.position.section, entry.position.providerIndex, entry.oauthChannel, entry.position.modelIndex,
  ]);
  thinkingEntries.forEach((entry) => { entries.set(entryKey(entry), { ...entry, serviceTier: null }); });
  speedEntries.forEach((entry) => {
    const key = entryKey(entry);
    const current = entries.get(key);
    entries.set(key, current ? { ...current, serviceTier: entry.serviceTier } : { ...entry, effort: null });
  });
  return [...entries.values()].sort((left, right) => (
    left.provider.localeCompare(right.provider) || left.alias.localeCompare(right.alias)
  ));
};

export const combineModelAliasSources = (
  baseSources: ThinkingAliasSource[],
  thinkingSources: ThinkingAliasSource[],
  speedSources: ThinkingAliasSource[],
): ModelAliasSource[] => {
  const reasoningSourceIds = new Set(thinkingSources.map((source) => source.id));
  const speedSourceIds = new Set(speedSources.map((source) => source.id));
  const sources = new Map<string, ModelAliasSource>();
  [...baseSources, ...speedSources, ...thinkingSources].forEach((source) => {
    sources.set(source.id, {
      ...source,
      supportsReasoning: reasoningSourceIds.has(source.id),
      supportsFast: speedSourceIds.has(source.id),
    });
  });
  return [...sources.values()];
};

export const defaultModelAlias = (model: string | null | undefined, effort: string, fast: boolean) => {
  const normalizedModel = model?.trim() ?? '';
  const normalizedEffort = effort.trim().toLowerCase();
  if (!normalizedModel) return '';
  if (!normalizedEffort && !fast) return `${normalizedModel}-alias`;
  return `${normalizedModel}${normalizedEffort ? `-${normalizedEffort}` : ''}${fast ? '-fast' : ''}`;
};

export const uniqueModelAlias = (alias: string, existingModelNames: string[]) => {
  const normalizedAlias = alias.trim();
  if (!normalizedAlias) return '';
  const existingNames = new Set(existingModelNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (!existingNames.has(normalizedAlias.toLowerCase())) return normalizedAlias;
  let suffix = 2;
  let candidate = `${normalizedAlias}-${suffix}`;
  while (existingNames.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${normalizedAlias}-${suffix}`;
  }
  return candidate;
};

export const sourceKindLabel = (kind: string) => {
  const labels: Record<string, string> = {
    'codex-oauth': 'Codex OAuth', 'antigravity-oauth': 'Antigravity OAuth', 'claude-oauth': 'Claude OAuth',
    'aistudio-oauth': 'AI Studio OAuth', 'vertex-oauth': 'Vertex OAuth', 'kimi-oauth': 'Kimi OAuth',
    'xai-oauth': 'xAI OAuth', 'devin-oauth': 'Devin OAuth', 'codex-api': 'Codex API', 'claude-api': 'Claude API',
    'gemini-api': 'Gemini API',
  };
  if (labels[kind]) return labels[kind];
  if (kind === 'openai-compatible') return translate(getCurrentLocale(), 'aliases.source.openAiCompatible');
  return translate(getCurrentLocale(), 'aliases.source.other');
};

/** Provider/account detail of a source; the generic "available models" line when it only repeats the kind label. */
export const sourceDetail = (kind: string, provider: string) => (
  provider === sourceKindLabel(kind) ? translate(getCurrentLocale(), 'aliases.source.available') : provider
);

/** Provider id for ProviderLogo from a source kind such as 'codex-oauth' or 'openai-compatible'. */
export const sourceProviderId = (kind: string) => kind.replace(/-(oauth|api|compatible)$/, '');

export const aliasEntryKey = (entry: AliasListEntry) => JSON.stringify([entry.position, entry.oauthChannel]);
