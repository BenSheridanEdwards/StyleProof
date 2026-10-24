# ADR 0009: Diff-bounded completeness (Change Reach)

- **Status:** accepted (2026-10-23)
- **Date:** 2026-10-21
- **Epic:** #934
- **Depends on:** #988 reach corpus, #989 reach cost receipt, #991 served-rule ledger (merged in #1045)

## Context

A green StyleProof check certifies every change **on the surfaces it captured**.
A restyle confined to a state no surface opens (a fault overlay, an empty state,
a dark-mode rule, an unrendered variant) produces byte-identical honest maps, so
the diff stays green having never seen it. README "The boundary" records this
from a real consumer PR. The coverage guard cannot close it, because it checks
that declared keys have captures, not that a pull request's changed branches have
keys.

The set of app states has no end, so no number of surfaces can prove the gap
closed. The pull request's diff does have an end. Change Reach joins the diff with
evidence a real browser records during capture:

- **J1**: a changed served CSS rule must match an element StyleProof compares
  (CSS rule usage).
- **J2**: a changed line of render code must run (V8 block coverage resolved
  through source maps).
- **J3**: a changed class token must land on a captured element (a class-list
  delta between base and head).

The reach corpus (#988, `bench/reach-corpus.review.md`) measured the miss and
the joins on a fixture whose spec opens only the healthy state:

| Scenario                    | Today's diff shows | Prototype reach joins                           |
| --------------------------- | ------------------ | ----------------------------------------------- |
| declared (healthy state)    | 1 of 13 changes    | name 11 of the 12 misses; 1 pinned residual (runtime CSS-in-JS), re-expected as `unknown` under this ADR |
| complete (all five states)  | 12 of 13 changes   | mark every rendered change reached              |

The same corpus pins one noise case: a changed error-handler string that never
runs during capture and has no visual effect, which J2 flags.

The cost receipt (#989, `bench/reach-cost.results.json`) measured what recording
the evidence adds to a capture on a GitHub runner:

| Target | off (median) | J1 overhead | J1+J2 overhead |
| --- | --- | --- | --- |
| detection-fixture (static, CSS-rich) | 1443.6 ms | 1.2% | 6.5% |
| example-demo (static dogfood surface) | 1149 ms | 2.6% | 3.8% |
| react-table (React, 300 rows) | 10081.7 ms | 0.1% | 5.3% |

7 runs per mode on `linux x64`, 4 CPUs, load average 1.2 at start, chromium 149.0.7827.55, run https://github.com/BenSheridanEdwards/StyleProof/actions/runs/39602282519. Thresholds agreed in #989: J1 ≤ 5%, J1+J2 ≤ 15% (median total vs off). Verdict: J1 within threshold, J1+J2 within threshold.

## Decision

1. **The claim.** Each changed unit gets one status: `reached`, `never-rendered`,
   `blind-channel`, `unmeasured`, or `unknown`. A run is **reach-complete** only
   when the evidence for all three joins is complete: every base and head capture
   has a `complete` J1 ledger, every changed stylesheet in the diff was served by
   a base or head capture, J2 block coverage resolved through source maps on
   both sides, a J3 class-list delta between base and head, and no dependency
   changed without a served-sources comparison. On top of that,
   every changed unit is `reached`, none was cleared by approval, and no run-level
   evidence gap remains (item 4). An empty unit list alone proves nothing. Only a
   reach-complete green means: every changed served CSS rule matched an element
   StyleProof compared, every changed line of render code ran, every changed class
   token reached a captured element, and every computed-style difference those
   states produced is in the report. Every other green carries a visible,
   non-certifying **"Reach incomplete"** status with a count per status and every
   non-`reached` unit and run-level evidence gap named. It never claims
   completeness.
2. **The boundary.** Reach means every change was seen at least once, which is the
   visual analogue of diff line coverage. It does not claim the consequences of a
   reached change in states nobody captured. A global rule seen on captured pages
   can still change an uncaptured overlay.
3. **Monotonic.** Reach only adds findings or lowers confidence. It never turns a
   red into a green, and it never clears what another gate blocks.
   Approval never upgrades a unit's status or supplies missing evidence: an
   approved `never-rendered` unit is still `never-rendered`, and the run is still
   not reach-complete.
4. **Unknown stays unknown.** `unmeasured` and `unknown` are never reported as
   reached and never count toward reach-complete. A missing ledger (a map captured
   before this feature or without `captureReach`) or a partial ledger (an
   unreadable stylesheet) can leave changed rules out of the unit list entirely,
   so it produces a run-level J1 `unknown` row even when no changed unit can be
   listed or every listed unit is `reached`. The row names the side and the
   reason, for example "N unreadable stylesheets; changed rules there cannot be
   listed" or "missing base ledger; changed rules cannot be listed", and it
   prevents reach-complete. Under the default `'warn'` level it is a named finding
   with no verdict change; under opt-in `'gate'` it blocks like a `never-rendered`
   J1 unit. A missing ledger names "recapture with `captureReach`" as the remedy;
   an unreadable stylesheet must be made readable and recaptured. J1 sees only
   CSS a capture served, so reach also joins the pull request's changed
   stylesheet sources (CSS, preprocessor and CSS-module files in the diff) with
   the sheets served on base and head, by URL or source-map `sources`. A changed
   stylesheet that no base or head capture served, or that cannot be matched to a
   served sheet (for example, it has no source map), produces the same run-level
   J1 `unknown` row, such as "N changed stylesheets never served during capture;
   changed rules there cannot be listed", with each file named. It behaves like a
   missing ledger at both levels, and the remedy is a surface that loads the
   sheet. When the diff changes a dependency's resolved version or contents (a
   lockfile, a manifest's dependency ranges, a vendored package) and no
   served-sources comparison exists for it, reach produces a run-level `unknown`
   row, "dependency changed without a served-sources diff: <packages>". The
   change cannot be attributed to J1, J2 or J3, so this row stays at `'warn'`
   under either level, like the J2/J3 gaps, and it prevents reach-complete.
   Missing J2
   coverage or source maps, or a missing J3 class-list delta, likewise produces a
   run-level `unmeasured` row naming the missing evidence. Those rows stay at
   `'warn'` under either level and prevent reach-complete.
5. **Named residuals.** These stay documented, not hidden:
   - non-class values defined at module scope (style objects, runtime CSS-in-JS
     templates, numeric theme constants). J3 cannot see them, and J2 sees only
     module evaluation. A changed line whose only J2 evidence is module evaluation,
     with no J1 or J3 corroboration, reads `unknown` ("module-scope value;
     rendering not proved"), never `reached`, so it surfaces in the report;
   - consequences of a reached change in uncaptured states (item 2);
   - dependency JavaScript that changed without a source diff cannot be
     attributed to a unit until a served-sources diff exists. Until then it is a
     run-level `unknown` finding (item 4), and the run is not reach-complete.
     Dependency CSS is covered by J1 only where a capture served it. Any other
     dependency change is the same run-level finding.
6. **Default levels.** `changeReach` takes `'warn'` or `'gate'`.
   - New in a minor release, the default is `'warn'`: the report lists every
     non-`reached` unit and run-level evidence gap by status (table below), the
     confidence strip shows "Reach incomplete", and no verdict changes.
     This keeps existing certify and review-gate users backward compatible.
   - `'gate'` is opt-in. In certify mode a `never-rendered` J1 unit fails with
     `CERTIFICATION_FAILED`. In review-gate mode it needs review, and the existing
     Approve checkbox clears it.

   | Status | `'warn'` (default) | `'gate'`, J1 unit | `'gate'`, J2/J3 unit | Counts toward reach-complete |
   | --- | --- | --- | --- | --- |
   | `reached` | no finding | no finding | no finding | yes |
   | `never-rendered` | named finding "Changed but never rendered" | certify: `CERTIFICATION_FAILED`; review-gate: needs review | named finding | no |
   | `blind-channel` | named finding "Changed in a channel computed styles cannot hold" (`@keyframes`, `@font-face`) | blocks like `never-rendered` | named finding | no |
   | `unmeasured` | named finding naming the setting to enable (source maps, `captureReach`) | blocks like `never-rendered` | named finding | no |
   | `unknown` | named finding with the reason (legacy or partial ledger, module-scope value) | blocks like `never-rendered`; legacy base names "recapture with `captureReach`" | named finding | no |
   | `unknown`, run-level J1 evidence gap | named finding for a missing or partial ledger, or a changed stylesheet no capture served, even with no listed units (item 4) | blocks like `never-rendered` | not applicable | no |
   | `unmeasured`, run-level J2/J3 evidence gap | named finding naming the missing coverage, source maps or class-list delta (item 4) | not applicable | named finding | no |
   | `unknown`, run-level dependency gap | named finding naming the changed packages (item 4) | named finding (stays `'warn'`) | named finding (stays `'warn'`) | no |

   No status other than `reached` is ever silent, and under `'gate'` the Approve
   checkbox clears the verdict, not the status or the evidence-gap finding
   (item 3).

   - J2 and J3 findings stay at `'warn'` even under `'gate'` until
     noise is measured on a consumer app. J1 is visual by definition. J2 also
     flags non-visual code (event handlers, error paths), as the corpus's noise
     case shows; they are still listed and still prevent reach-complete.
   - Revisit the default for the next major with that noise data.
7. **J2 ships behind source maps.** J1+J2 stayed within its threshold on every target (worst 6.5%), so J2 proceeds to Phase 2. It is opt-in like J1 and needs source maps in the capture build. Without them, markup reach reads `unmeasured`. Cost was measured on a JS-light dogfood page, a static fixture and a 300-row React page. A larger production bundle can cost more, so Phase 2 (#999) re-measures on the receipt's targets plus a consumer app before J2 is enabled by default.

## Consequences

- Capture records CSS rule usage per surface@width (#991). The Action refuses a
  capture file over 16 MiB, so the served-rule ledger stores rule keys and
  declaration hashes, not full rule bodies.
- With `captureReach` on, a stylesheet the ledger cannot parse exactly (nested
  CSS, unbalanced or unsupported escapes, identical ambiguous sheets) fails the
  capture with "served CSS reach is unknown" rather than recording partial
  evidence, and the self-check fails when two captures' ledgers differ (#1045).
- The report gains a "Changed but never rendered" section, and the confidence
  strip may say "Reach complete" only for a reach-complete run (item 1); otherwise
  it shows "Reach incomplete". Neither label is a percentage or score (see
  Alternatives rejected). Without source maps, markup reach reads as
  `unmeasured` and the strip names the setting to enable.
- Reach reads the pull request's changed stylesheet and dependency paths, not
  only the captures. A changed stylesheet that no capture served (or that cannot
  be matched to a served sheet) is a run-level J1 `unknown` finding, never a
  silent omission. A lockfile, manifest or vendored dependency change is a
  run-level `unknown` finding until a served-sources diff exists.
- `bench/reach-corpus.mjs --check` is the oracle. Phase 1 and 2 replace its
  prototype joins with `src/` code and keep its expectations, with one change:
  the `runtime-css-in-js` scenario is expected as `unknown`, not `reached`
  (follow-up on PR #1031 / Phase 1).

## Alternatives rejected

- **Exhaustive state exploration as the guarantee.** It has no end state and
  cannot reach data-driven branches. It stays a remedy (the variant harvester).
- **Pixels as the gate.** Uncaptured states have identical pixels too, and
  rasterisation flake is the reason for ADR 0001.
- **Static branch enumeration.** It needs one parser per framework, flags every
  conditional in the app, and cannot see `@media` or dark mode.
- **An agent that writes fixtures until green.** That puts model calls in the
  gate. Agents read the reach output as remediation authors only.
- **A confidence score or "% covered".** It needs an invented denominator. It was
  removed once already, in 6.4.0 (ADR 0003, ADR 0004).

## Revisit when

- noise is measured on a consumer app's merged PRs (#989): reconsider the
  default level and whether J2 can gate;
- a served-sources diff exists: dependency changes can be attributed to units
  instead of a run-level gap;
- J2 can attribute a module-scope value to a rendered element: module-scope
  lines can move from `unknown` to `reached`.
