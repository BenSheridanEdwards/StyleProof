# Reach corpus: method and results

Buyer-legible answer to: _when a pull request restyles a state the capture spec
never opens, does today's gate see it, and can reach evidence name it?_ This is
Phase 0 of Change Reach ([#934](https://github.com/BenSheridanEdwards/StyleProof/issues/934),
ticket [#988](https://github.com/BenSheridanEdwards/StyleProof/issues/988)).

## Method

- `bench/fixtures/reach/` is one small app: the base side of a PR. Each case in
  the corpus declares its seeded `edit`, and the head side is the base plus every
  edit. There are 14 edits. 13 are visual and one is not.
- `bench/reach-corpus.json` is the only source of truth. It lists five surfaces
  (home, fault overlay, `status=bad`, dark mode, the 1440px band) and two
  scenarios. **declared** opens only `home`, as a typical spec does.
  **complete** opens all five.
- `bench/reach-corpus.mjs` runs the real product path. esbuild bundles each
  side with source maps. Chromium renders every surface on both sides.
  `captureStyleMap` captures each one with `captureReach` and V8 JS coverage, and
  `diffStyleMaps` compares base with head.
- `src/rule-reach.ts` supplies J1 through `classifyRuleReach` on the
  `captureReach` ledger. `bench/reach-joins.mjs` holds the J2/J3 prototypes.
  - **J1:** a changed served CSS rule must match an element. Changed custom
    properties follow `aliases`, need every consumer to match, and require a
    read outside a custom-property declaration. Unread and alias-only tokens
    are never rendered. `@keyframes`, `@font-face` and `@property` resolve
    through rendered references; `@property` also resolves through declarations;
    alias-only reads do not count.
  - **J2:** a changed line of render code must run. This uses V8 block coverage
    resolved through the bundle's source map.
  - **J3:** a changed class token must land on a captured element. Some paired
    element's class list must gain or lose it between base and head.
- Before any case runs, the healthy base is captured twice. The two captures
  must self-diff to zero and record identical reach ledgers and execution.
  Missing ledgers or any drift abort the run. Each scenario also fails if its
  J1 ledger is not complete, because CSS reach is then unknown.
- Every changed unit, meaning each changed served rule or changed source line,
  must belong to exactly one case. A unit no case claims fails the run.

## Results (receipt: `bench/reach-corpus.results.json`)

The migrated runner (J1 from `src/rule-reach.ts`) reproduces these totals in
Chromium: CI's `node bench/reach-corpus.mjs --check` passed every case on commit
`b8ebaf468` (run 40170871007). The committed receipt file's timestamp and CSS
unit strings still come from the earlier prototype run; `npm run bench:reach`
refreshes them.

| Scenario                | Today's diff shows      | Reach joins                                        |
| ----------------------- | ----------------------- | -------------------------------------------------- |
| declared (`home` only)  | 1 of 13 visual changes  | name 11 of the 12 misses; 1 is the pinned residual |
| complete (all 5 states) | 12 of 13 visual changes | mark every rendered change reached                 |

What each kind of change does in the declared scenario:

| Change                                                         | Today  | Reach                                         |
| -------------------------------------------------------------- | ------ | --------------------------------------------- |
| `:hover` colour                                                | shown  | reached (forced `:hover` matches)             |
| Fault-overlay rule, removed rule, CSS Module rule, ternary arm | missed | never rendered (J1)                           |
| Token used only by the fault badge                             | missed | never rendered (J1 consumer closure)          |
| Dark-mode and 1440px `@media` rules                            | missed | never rendered, with the gating `@media`      |
| `@keyframes` body                                              | missed | blind channel (a rendered rule references it) |
| Class added inside the fault overlay                           | missed | never rendered (J2 never ran)                 |
| Module-scope class constants (incl. one that collides)         | missed | never rendered (J3; J2 alone says "ran")      |
| Runtime CSS-in-JS style string                                 | missed | **reached: the pinned residual**              |
| `console.warn` text in an error handler                        | n/a    | never rendered (**noise**)                    |

## What this proves, and what it doesn't

**Proven:** on a deterministic fixture, a restyle confined to a state the spec
never opens is invisible to today's diff, and that holds for a CSS rule, a
token, a media query, a CSS Module, a markup class, and a module-scope constant.
Reach evidence from a real browser names each of those misses with the changed
rule or line. Capturing the missing states turns each one into an ordinary
finding.

**Named limits, pinned so they cannot drift silently:**

- **Runtime CSS-in-JS** (`runtime-css-in-js`). The style string runs at load,
  so J2 says it ran. The rule is injected only on render, so J1 sees nothing.
  The value is not a class token, so J3 has no signal. Today it reads as
  reached, which is a false clearance. Zero-runtime CSS-in-JS compiles to CSS,
  and J1 covers that exactly.
- **Noise** (`error-handler`). Changed code that never runs during capture and
  has no visual effect is still flagged. The client-bundle filter
  ([#1000](https://github.com/BenSheridanEdwards/StyleProof/issues/1000)) and
  acknowledgements ([#1006](https://github.com/BenSheridanEdwards/StyleProof/issues/1006))
  are where that gets addressed.
- **Blind channel** (`keyframes`). It is reached but computed styles cannot
  hold it, so it is named rather than counted as clean.

**Not proven:** the cost of recording reach evidence and the noise rate on a real
app's PRs ([#989](https://github.com/BenSheridanEdwards/StyleProof/issues/989)).
J2/J3 remain bench prototypes; J3 pairs changed lines by position inside each diff
hunk. Unsupported CSS parsing fails with unknown reach. The fixture is synthetic,
and its rates say nothing about a particular consumer app.

## Reproduce

```sh
npm run bench:reach         # measure + write the receipt
npm run bench:reach:check   # fail on any violated expectation
```

Adding a case: add it to `reach-corpus.json` with its `edit`, its `unit`
matcher, and its expectations, then rerun. Each edit's `from` must occur exactly
once in the base file. A changed unit that no case's matcher claims fails the
run.
