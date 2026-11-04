# Reach corpus: method and results

This fixture measures whether a restyle confined to an unopened state is visible
in the computed-style diff, and whether the reach joins name the missing proof.
The receipt is `bench/reach-corpus.results.json`; `pnpm run bench:reach:check` is
the CI oracle.

## Method

- `bench/fixtures/reach/` supplies the base app. The head applies every case's
  unique `edit` from `bench/reach-corpus.json`: 16 changes, 15 visual and one
  non-visual error-handler change.
- The declared scenario captures only `home`. The complete scenario captures
  home, fault overlay, status=bad, dark mode and the 1440px band. “Complete” here
  names the fixture's five-state spec, not a reach-complete certification.
- esbuild bundles each side with source maps. Chromium runs the real
  `trackScriptReach`/`captureStyleMap` path, including `captureReach`, and
  `diffStyleMaps` compares both sides.
- J1 uses `src/rule-reach.ts`. J2 uses `changedScriptRanges` from
  `src/script-join-git.ts` and `classifyScriptReach` from `src/script-join.ts` on
  stored `scriptReach` evidence. The benchmark supplies its seeded file diff;
  unit/report tests independently verify the manifest-SHA git adapter.
- J3 remains the `classReach` prototype in `bench/reach-joins.mjs` for
  branch-class, module-constant and colliding-constant. These three scenarios
  still use its token delta, without per-occurrence provenance. Their reached
  results do **not** claim production J3 correctness; #1001 replaces it.
- Healthy base captures must self-diff to zero and have identical J1 and script
  evidence. Every changed unit must belong to exactly one case, and incomplete
  J1 ledgers abort scoring.

## Before and after

| Measurement                                    | Before (14 cases) | After (16 cases) |
| ---------------------------------------------- | ----------------- | ---------------- |
| Declared: visual changes shown                 | 1/13              | 1/15             |
| Complete: visual changes shown                 | 12/13             | 14/15            |
| Declared: misses named by a non-reached status | 11/12             | 14/14            |
| Declared: unknown cases                        | 0                 | 3                |
| Complete: unknown cases                        | 0                 | 3                |
| Error handler, both scenarios                  | never-rendered    | never-rendered   |

**One existing case moved to unknown:** runtime-css-in-js, in both scenarios
(two result cells). Two new cases are unknown in both scenarios (four new result
cells). Unknown therefore rises from zero to three cases per scenario; there
are six unknown result cells in the new receipt. No other existing expectation
changed.

| Case               | Declared before → after         | Complete before → after         |
| ------------------ | ------------------------------- | ------------------------------- |
| runtime-css-in-js  | reached → unknown               | reached → unknown               |
| render-scope-value | new → unknown                   | new → unknown                   |
| eager-jsx-element  | new → unknown                   | new → unknown                   |
| error-handler      | never-rendered → never-rendered | never-rendered → never-rendered |

The render-scope case computes `faultStyle` in the component body but applies it
only in the fault overlay. The JSX case eagerly builds `banner` and mounts it
only under the fault branch. Both definitions execute on healthy captures, yet
their values are absent from that page. Even the five-state spec leaves them
unknown: execution and visual findings do not provide the exact source-range
J1/J3 corroboration required by ADR 0009.

## Limits

This proves behavior on a synthetic, deterministic fixture, not a consumer noise
rate. J2's error-handler finding remains advisory noise. Source-mapped block
entry does not prove every expression evaluated: default parameter values,
destructuring defaults, logical assignment RHS, later optional-chain links and
code after a throwing expression remain named limits. Missing maps, mismatched
source hashes and unloaded scripts are unmeasured. J2 never changes a verdict
under either changeReach level.

The complete spec still misses the keyframes change because computed styles
cannot hold animation bodies. J1 names that blind channel. All three value
cases remain unknown, and J3 is still a prototype. These results never establish
reach-complete.

## Reproduce

```sh
pnpm run bench:reach        # write receipt
pnpm run bench:reach:check  # fail on any violated expectation
```
