# Strings and locales

- `locales/zh-CN.ts` is the whole-app key source (`MessageKey`). `locales/en.ts`
  and `locales/ja.ts` assemble matching English and Japanese tables.
- `locales/zh-TW.ts` derives Traditional Chinese from the assembled Simplified
  Chinese table using `locales/traditional.ts`, then applies explicit overrides.
- `resources.ts` is the stable export surface for all four assembled tables.
  Object spreads are applied in source order; later entries win. `index.tsx`
  selects the locale, interpolates `{name}` variables and falls back to English.
- Shared feature fragments live in `src/i18n/*.ts`; section strings enter through
  `src/sections/<name>/i18n.ts` (and provider subsection equivalents). Usage's
  entry point composes its `i18n.<tab>.ts` fragments in a fixed order. Keep that
  entry point when splitting a large section's dictionary.
- The shell owns `src/shell/i18n.ts`; shared UI controls own `src/ui/i18n.ts`.
  `ui/uiText.ts` also resolves these UI strings directly; its Traditional Chinese
  lookup intentionally uses Simplified Chinese, unlike the app resource table.

## Adding a key or locale

Add a key in its owning fragment (or the whole-app table for app-wide text),
with the same key and interpolation variables in zh-CN, en and ja. Wire a new
fragment into each whole-app locale in the same order. Check the generated zh-TW
value and add an explicit override if necessary. Do not rename existing keys
when relocating their source files.

For a new locale, add its table under `locales/`, export it through `resources.ts`,
and register it in `index.tsx` (locale type, resource map, options, normalization
and supported locales). Update the direct UI dictionaries in `ui/uiText.ts` too.

## Checks

`bun test tests/unit/shell/i18n.test.ts` checks complete key parity, nonempty translations,
matching interpolation variables, Japanese coverage, English prose and selected
terminology. TypeScript's `MessageKey` and fragment `Record` types also check
coverage (`bun run check`). Run `bun test --isolate` for the section-specific
string checks and the rest of the suite. Relocation must not change any key,
value or spread order.
