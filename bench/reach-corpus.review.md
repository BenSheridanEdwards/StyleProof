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
selected occurrence, including both constants in the same-token collision.
No per-occurrence render provenance is recorded. A delta is unknown, never reached
or J2 corroboration. Only token absence from every captured element on its own side is negative evidence and can lower J2. Presence, including on unpaired elements or unchanged class lists, stays unknown.

## Before/after (#1001)

The baseline is main after #1000 / PR #1302 (`0cc4bd2dc`). Its corpus log is retained
in `docs/proof/class-delta-1001/corpus-before.log`.

| Measurement                   | Before: src J1/J2, separate J3 prototype | After: src J1/J2/J3 |
| ----------------------------- | ---------------------------------------- | ------------------- |
| Cases / visual                | 16 / 15                                  | 18 / 17             |
| Declared visual changes shown | 1/15                                     | 3/17                |
| Complete visual changes shown | 14/15                                    | 16/17               |
| Declared misses named         | 14/14                                    | 14/14               |
| Declared unknown cases        | 5                                        | 6                   |
| Complete unknown cases        | 6                                        | 8                   |
| Total unknown scenario cells  | 11                                       | 14                  |
| Error handler, both scenarios | never-rendered                           | never-rendered      |

On the **16 existing cases**, declared module-constant moves from unknown to
never-rendered. Colliding-constant stays unknown: the head token `tone-red` already
appears on the healthy delete link, so absence of a directional delta cannot prove
it never landed. Round one corrects that cell from the first implementation's
never-rendered back to unknown. No other case status changes in round one.
The three complete class cases stay unknown. The two new ADR cases add four
unknown cells; combined with the module-constant negative, this is **+3 unknown
cells versus main** (11 → 14), or **+1 versus the first J3 implementation** (13 → 14).
Declared/complete unknown totals are **6/8**, versus main's **5/6** and round zero's **5/8**.

| Case                  | Declared J2 / J3 / combined                 | Complete J2 / J3 / combined |
| --------------------- | ------------------------------------------- | --------------------------- |
| branch-class          | never-ran / never-rendered / never-rendered | ran / unknown / unknown     |
| module-constant       | ran / never-rendered / never-rendered       | ran / unknown / unknown     |
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
J3 skips prose, checks presence on all captured elements (including unpaired), and cannot reach an occurrence
without future source-mapped render provenance. Missing class vocabulary, ledgers,
source ranges or paired captures remain named unmeasured gaps. J2/J3 findings and
gaps stay advisory at both levels and prevent reach-complete. The changed-stylesheet
and other ADR attribution joins remain unbuilt.
