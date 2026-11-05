# Reach corpus: method and results

`bench/reach-corpus.results.json` is the measured receipt;
`pnpm run bench:reach:check` is the CI oracle. “Complete” names the five-state spec,
not reach-complete certification.

## Method

There are 18 seeded changes: 17 visual and one non-visual error handler. Declared
captures only home; complete captures home, fault, status-bad, dark and wide.
esbuild source maps, real Chromium, `trackScriptReach`, `captureStyleMap`, and
`diffStyleMaps` supply the evidence. Healthy repeated captures must have identical
style and reach evidence. Every changed source unit has exactly one case owner.

J1 uses `src/rule-reach.ts`. J2 uses `changedScriptRanges` and
`classifyScriptReach`; J3 uses `classifyClassReach` and `combineClassReach` from
`src/`. There is no token-name J3 prototype. The historical noise runner's adapter
also calls src J3; its previously recorded receipt is historical, not remeasured.
The corpus constructs one-line patches and selects head units (base for removals),
not `readScriptChanges`. Real Git/manifest and Chromium tests exercise the adapter,
captured revision SHAs, project prefixes and report filename pairing.

The temporary fixture is a Git repository, so captures resolve actual
`src/base`/`src/head` project prefixes. Every source unit asserts zero J2 and J3
run-level gaps. Class-case expectations also assert the number and status of every
selected occurrence, including both constants in the same-token collision. Base-side
removals on replacement lines have independent counts and status expectations; they
are retained under `baseClassUnits` in the receipt.
No per-occurrence render provenance is recorded. A delta is unknown, never reached
or J2 corroboration. Token absence is negative evidence only when every map on the occurrence side records
no omissions with verified version-2 facts and complete pairing: volatile elements,
ignore lists, untraversed author roots/documents, outside-body children, unstable
facts and version-1/legacy maps leave absence unknown. Only positive class-context
negatives may lower J2; vocabulary-only candidates cannot. Token presence, including
on unpaired elements or unchanged class lists, stays unknown.

## Before/after (#1001)

The baseline is main after #1000 / PR #1302 (`0cc4bd2dc`). Its corpus log is retained
in `docs/proof/class-delta-1001/corpus-before.log`.

| Measurement                   | Before: src J1/J2, separate J3 prototype | After: src J1/J2/J3 |
| ----------------------------- | ---------------------------------------- | ------------------- |
| Cases / visual                | 16 / 15                                  | 18 / 17             |
| Declared visual changes shown | 1/15                                     | 3/17                |
| Complete visual changes shown | 14/15                                    | 16/17               |
| Declared misses named         | 14/14                                    | 14/14               |
| Declared unknown cases        | 5                                        | 7                   |
| Complete unknown cases        | 6                                        | 8                   |
| Total unknown scenario cells  | 11                                       | 15                  |
| Error handler, both scenarios | never-rendered                           | never-rendered      |

On the **16 existing cases**, no combined case changes relative to main. Declared
module-constant is a vocabulary-only candidate: its head J3 token is absent and
reads never-rendered, but cannot lower its ran/unknown J2 range. Round two restores
that combined cell to unknown. Colliding-constant stays unknown: its head token
`tone-red` appears on the healthy delete link; its base `tone-amber` is absent and
negative on declared. Both complete sides are unknown.

The two new ADR cases add four unknown cells versus main (11 → 15). Declared/complete
unknown totals are **7/8**, versus main's **5/6**, round zero's **5/8**, and round
one's **6/8**. Shown counts and the 14/14 declared misses named are unchanged from
round one. No corpus token status changes from round one's corrected presence rule.

| Case                  | Declared J2 / J3 / combined                 | Complete J2 / J3 / combined |
| --------------------- | ------------------------------------------- | --------------------------- |
| branch-class          | never-ran / never-rendered / never-rendered | ran / unknown / unknown     |
| module-constant       | ran / never-rendered / unknown              | ran / unknown / unknown     |
| colliding-constant    | ran / unknown / unknown                     | ran / unknown / unknown     |
| same-line-class-style | ran / unknown / unknown                     | ran / unknown / unknown     |
| same-token-collision  | ran / unknown / unknown                     | ran / unknown / unknown     |

The same-line case computes a style object on every render; Banner applies it
only when fault is open, while its class changes on healthy. The class occurrence
has a delta but no provenance, and cannot corroborate the style value on that same
line. Both stay unknown. In the same-token case both module constants change
`collision-old` to `collision-new`; one renders on healthy and one only in fault.
Both selected occurrences are unknown even when only healthy is captured.

## Limits

This synthetic fixture does not measure consumer noise. J2 block entry cannot
prove value rendering, default parameter values, destructuring defaults, logical
assignment RHS, later optional-chain links or code after a throwing expression.
The non-visual error handler remains named noise; keyframes remain a blind channel.
J3 skips prose, checks presence on all captured elements (including unpaired),
and cannot reach an occurrence
without future source-mapped render provenance. Missing class vocabulary, ledgers,
source ranges or paired captures remain named unmeasured gaps. J2/J3 findings and
gaps stay advisory at both levels and prevent reach-complete. The changed-stylesheet
and other ADR attribution joins remain unbuilt.

Round three retains the measured 7/8 unknown totals and all combined/J3 corpus
statuses. The capture/context fixes do not change this fully paired fixture;
base-removal counts/statuses remain independently asserted.
