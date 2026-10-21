import type { ThemeDefinition, ThemeTokens } from './types';
import { themeMaterialTokens, themeOverlaySurface } from './materials';

/**
 * Ember is the display name of the built-in dark/light palettes.
 * Theme contract for the new UI: the legacy theme tokens (src/themes/types.ts) drive the semantic --ec-* layer
 * (src/ui/tokens.css). Ember Dark/Light define no tokens, so they keep the stylesheet values; any other theme
 * (upstream's Warm Sand, Sakura, Graphite, Midnight, or a custom one) overrides the variables it supplies.
 * Status colours are not part of the theme contract and stay on the appearance's status vocabulary.
 */
const semanticProperties = [
  '--ec-bg', '--ec-surface', '--ec-raised', '--ec-popover', '--ec-hover', '--ec-muted-bg', '--ec-field',
  '--ec-sidebar', '--ec-sidebar-hover', '--ec-sidebar-selected', '--ec-sidebar-border', '--ec-scrim',
  '--ec-fg', '--ec-fg-2', '--ec-fg-muted', '--ec-fg-subtle',
  '--ec-border', '--ec-border-soft', '--ec-input-border', '--ec-ring',
  '--ec-accent', '--ec-accent-fg', '--ec-accent-soft',
] as const;

export const semanticTokenBridgeProperties: readonly string[] = semanticProperties;

export function themeSemanticTokens(theme: ThemeDefinition): Record<string, string> {
  if (Object.keys(theme.tokens).length === 0 && !theme.backdrop) return {};
  const raw: Readonly<ThemeTokens> = theme.tokens;
  const material = themeMaterialTokens(theme);
  const pairs: Array<[string, string | undefined]> = [
    ['--ec-bg', raw.workspaceBackground ?? theme.windowBackground],
    ['--ec-surface', material.surface],
    ['--ec-raised', material.softSurface],
    ['--ec-popover', themeOverlaySurface(theme)],
    ['--ec-hover', material.hoverBackground],
    ['--ec-muted-bg', material.softSurface],
    ['--ec-field', raw.softSurface ?? raw.surface],
    ['--ec-sidebar', raw.sidebarBackground],
    ['--ec-sidebar-hover', raw.sidebarHover],
    ['--ec-sidebar-selected', raw.sidebarSelected],
    ['--ec-sidebar-border', raw.sidebarBorder],
    ['--ec-scrim', raw.scrim],
    ['--ec-fg', raw.textPrimary],
    ['--ec-fg-2', raw.textSecondary],
    ['--ec-fg-muted', raw.textTertiary],
    ['--ec-fg-subtle', raw.textMuted],
    ['--ec-border', raw.border],
    ['--ec-border-soft', raw.borderSubtle],
    ['--ec-input-border', raw.borderStrong],
    ['--ec-ring', raw.focusRing],
    ['--ec-accent', raw.accent],
    ['--ec-accent-fg', raw.accentContrast],
    ['--ec-accent-soft', raw.accentSoft],
  ];
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => pair[1] !== undefined));
}
