# Reach corpus: method and results

The fixture measures whether unopened-state restyles appear in the computed-style
diff and whether reach names missing evidence. `bench/reach-corpus.results.json`
is the measured receipt; `pnpm run bench:reach:check` is the CI oracle.

## Method

There are 16 seeded changes (15 visual and one non-visual error handler). The
**declared** scenario captures home only; **complete** captures all five fixture
states. “Complete” names that spec, not reach-complete certification. esbuild
source maps, real Chromium, `trackScriptReach`, `captureStyleMap`, and
`diffStyleMaps` supply the evidence. Healthy repeated captures must have identical
style and reach evidence. Every changed unit must have exactly one case owner.

J1 uses `src/rule-reach.ts`. J2 uses `changedScriptRanges` and
`classifyScriptReach` from `src/` on stored capture evidence. The corpus constructs
one-line patches by hand and judges the head unit (base for a removed line); it
does not run `readScriptChanges`. Unit and e2e tests cover the real Git/manifest
adapter, including comparison SHAs, multiline hunks, capture prefixes, patch
pairing, source hashes and expression starts.

The temporary fixture is a Git repository, so each capture resolves its actual
`src/base` or `src/head` project-root prefix. After rebasing onto the injected-script
capture fix (#1287), the corpus asserts **zero J2 run-level gaps** for every source
unit. The receipt's `j2Gaps` records the empty lists; any gap fails the oracle.
Case statuses judge mapped source units; the run is not reach-complete.

**J3-prototype is separate evidence.** The token-name `classReach` prototype is
retained for branch-class, module-constant and colliding-constant, but never
overrides or corroborates the src J2 status. Results have a separate
`prototypeJ3` field and printed J3-prototype label. #1001 re-judges these cases
under ADR 0009 per-occurrence provenance. A token delta is not that provenance.

## Results and correction

| Measurement                                  | Original prototype (14 cases) | Rejected join head (16 cases) | Corrected join (16 cases) |
| -------------------------------------------- | ----------------------------- | ----------------------------- | ------------------------- |
| Declared: visual changes shown               | 1/13                          | 1/15                          | 1/15                      |
| Complete: visual changes shown               | 12/13                         | 14/15                         | 14/15                     |
| Declared: unknown cases                      | 0                             | 3                             | 5                         |
| Complete: unknown cases                      | 0                             | 3                             | 6                         |
| Declared: misses named by non-reached status | 11/12                         | 14/14                         | 14/14                     |
| Error handler, both scenarios                | never-rendered                | never-rendered                | never-rendered            |

The correction moves **five result cells** to unknown: module-constant and
colliding-constant in both scenarios, and branch-class in complete. This is
**three existing cases**, not five cases. Compared with the original prototype,
the existing runtime-css-in-js case also moved to unknown in both scenarios;
the render-scope-value and eager-jsx-element cases were newly added. The corrected
receipt contains eleven unknown cells: five declared and six complete.
Round four changes no case status: **zero cells moved to unknown**. Resolving the
temporary Git root removes the two previously unchecked prefix gaps; the two
unsupported-script gaps remain explicit and asserted.
After the round-five rebase, #1287 excludes those injected scripts and removes
both unsupported-script gaps. No case status changes; unknown counts stay five
declared and six complete.

| Case               | Src J2 declared | Src J2 complete | J3-prototype declared / complete |
| ------------------ | --------------- | --------------- | -------------------------------- |
| branch-class       | never-rendered  | unknown         | never-rendered / reached         |
| module-constant    | unknown         | unknown         | never-rendered / reached         |
| colliding-constant | unknown         | unknown         | never-rendered / reached         |
| runtime-css-in-js  | unknown         | unknown         | n/a                              |
| render-scope-value | unknown         | unknown         | n/a                              |
| eager-jsx-element  | unknown         | unknown         | n/a                              |
| error-handler      | never-rendered  | never-rendered  | n/a                              |

The value definitions execute without proving their values rendered. Even a
computed-style finding on the complete spec does not supply exact-range
corroboration. Thus those src J2 units stay unknown. The healthy page never enters
the fault badge branch, so branch-class remains never-rendered there.

## Limits

This is a synthetic fixture, not a consumer noise-rate measurement. Block entry
still cannot prove default parameter values, destructuring defaults, logical
assignment RHS, later optional-chain links or code after a throwing expression.
J2 findings remain advisory under both levels. The error handler remains named
noise. The keyframes change remains a J1 blind channel. J3 per-occurrence
provenance is not built, and these results never establish reach-complete.

```sh
pnpm run bench:reach        # write receipt
pnpm run bench:reach:check  # check every expectation
```
