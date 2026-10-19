# Lint status

`bun run lint` runs Biome 2.5 (`biome.json`) over `src/`, `tests/` and `scripts/`. It exits 0 with
**0 errors and 185 warnings**. New code should not add warnings; fix the rule or add a justified
`// biome-ignore <rule>: <reason>` line.

The warnings are rules that need a behaviour-aware review, so they were downgraded from error to
`warn` rather than fixed mechanically. Counts below are from the lint run on this branch.

| Rule | Warnings | Why it is not fixed mechanically |
| --- | ---: | --- |
| `correctness/useExhaustiveDependencies` | 69 | Adding the "missing" dependencies is how refresh loops get introduced. Many of the "unnecessary" ones (`connectionRevision`, `attempt`, `manualVersion`, `refreshVersion`) are deliberate re-run triggers. Each needs reading against the effect. |
| `a11y/useSemanticElements` | 27 | Replacing `role=` on a `div` with a native element changes layout, styling and keyboard behaviour. |
| `suspicious/noArrayIndexKey` | 23 | Safe only where the list is static or never reordered; needs a stable id per list. |
| `suspicious/noControlCharactersInRegex` | 18 | Control-character regexes in input sanitising and export code; not reviewed one by one. |
| `a11y/noLabelWithoutControl` | 10 | Needs the label/control association checked per form. |
| `a11y/noStaticElementInteractions` | 8 | Needs a real role and keyboard handling per element. |
| `a11y/useAriaPropsSupportedByRole` | 8 | Depends on the element's role. |
| `a11y/useValidAriaRole` | 6 | Depends on the element's role. |
| `a11y/useKeyWithClickEvents` | 6 | Needs keyboard handling designed per element. |
| `a11y/noNoninteractiveTabindex` | 4 | Elements deliberately made focusable (scroll regions, hint icons, chart focus targets). |
| `a11y/useAriaPropsForRole` | 2 | Depends on the element's role. |
| `a11y/noSvgWithoutTitle` | 2 | Needs accessible names. |
| `a11y/noAutofocus` | 1 | Focus behaviour. |
| `a11y/noAriaHiddenOnFocusable` | 1 | Focus behaviour. |

Test-only `overrides` in `biome.json`:

- `suspicious/noExplicitAny` is off in `tests/**` (62 findings, all test code; none in `src/`).
- `suspicious/noAssignInExpressions` is off in `tests/fixtures/**` (the compact fixtures use `??=` on `window`).

Fixed in the same change: `noPrototypeBuiltins` (now `Object.hasOwn`, with `ES2022.Object` added
to the `tsconfig.json` libs; the app already relies on `structuredClone`, which is newer),
unused imports, variables and parameters, `useConst`, `noImplicitAnyLet`, `noCommaOperator`,
`noAssignInExpressions` and `noShadowRestrictedNames` in `src/`, and `useButtonType` in
`tests/fixtures/` (none of those buttons is inside a form). Intentional literals keep a
`biome-ignore` with the reason: `${input:...}` placeholders in the Copilot setup test and the
`__proto__` key in the plugin config test.

## Possible bugs

None identified. The ~40 `useExhaustiveDependencies` "does not specify its dependency" warnings in
`src/` were counted, not individually triaged; read each against its effect before changing it.
