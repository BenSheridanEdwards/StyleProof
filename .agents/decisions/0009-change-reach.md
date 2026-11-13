# ADR 0009: Diff-bounded completeness (Change Reach)

- **Status:** accepted (2026-10-23)
- **Amendment (2026-11-02, #1240):** The changed-stylesheet join below is target design, not built. Until it is built (#934), StyleProof cannot list a changed stylesheet no capture served. The report names this as a run-level J1 gap that is not checked, under both levels. It prevents reach-complete but does not hold `gate`, because the report has neither the PR's changed files nor source maps.
- **Implementation note (2026-11-05, #1001):** J3 now judges source occurrences against paired class-list deltas. Captures record no per-occurrence render provenance: only absence from every captured element on the occurrence's own side, with no known capture omissions on any map on that side, is `never-rendered`; any presence (including unpaired elements and unchanged class lists) is `unknown`, and no J3 unit reaches or corroborates J2. Missing vocabulary, ledgers, source ranges or pairing remain named warn-only `unmeasured` gaps.
- **Amendment (2026-11-10, visual-first report; Ben's report rule 5 of 2026-11-07, "no repeated or internal diagnostics"):** What report.md and report.html show changes; report.json still names every status and evidence gap (`reach.rules`, `reach.scripts`, `reach.classes`, `reach.gaps`, `reach.complete`). When a side's served-CSS record is missing, old or unreadable, it names that gap and gives no rule counts (and no empty rule list), so it never reads as zero changed rules.
  - At `'warn'`, the report names every J1 status other than `reached`, in plain lines under the summary: changed rules never matched, changed rules computed styles cannot show, and one line for what reach could not check (rules that matched only elements StyleProof does not compare, and J1 ledger gaps: a missing or old ledger, unreadable stylesheets, a side with no captures, with the remedy).
  - At `'gate'` with held findings, the report shows one "Reach gate" line under the summary and the "Changed but never matched" section, which lists every held J1 finding and a "Not checked" list.
  - J2 and J3 detail (units and their status counts), J2/J3 gaps and truncation notices (`J2 units truncated`, `J2 gaps truncated`, `J2 gap paths truncated`, `J3 detail truncated`) and the "Reach complete" / "Reach incomplete" label are `report.json` only, at both levels. report.md and report.html show no J2/J3 table, strip, cap or truncation line. J2/J3 stay warn-only and still prevent `complete: true`.
  - The unbuilt changed-stylesheet join (#934) is `report.json` only at warn; under `'gate'` with held findings, the "Not checked" list in report.md/html names it. It never holds the gate.
  - So "no status other than `reached` is ever silent" (item 6) holds for report.json at both levels and for J1 in report.md/html; items 1 and 6 and the Consequences' "Reach incomplete" strip describe the report before this amendment.
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
  through source maps). For a line that produces a value, running alone does
  not prove the value rendered (item 5).
- **J3**: a changed class-token occurrence must land on a captured element,
  proved by a class-list delta between base and head tied to that occurrence's
  source range; a delta for the same token from another occurrence proves
  nothing.

The original reach corpus (#988, `bench/reach-corpus.review.md`) measured the miss and
the joins on a fixture whose spec opens only the healthy state:

| Scenario                   | Today's diff shows | Prototype reach joins                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| declared (healthy state)   | 1 of 13 changes    | name 11 of the 12 misses; 1 pinned residual (runtime CSS-in-JS), re-expected as `unknown` under this ADR (value, rendering not proved); render-scope value, eagerly built JSX element, same-line class-plus-style and same-token collision scenarios not yet measured, expected as `unknown` once PR #1031 adds them |
| complete (all five states) | 12 of 13 changes   | mark every rendered change reached                                                                                                                                                                                                                                                                                   |

The #1001 receipt now covers 18 cases (17 visual): declared shows 3/17, complete
shows 16/17, and all 14 declared misses are named. After round-two omission and explicit-context corrections, unknown case counts are 7/8;
no J3 occurrence reaches without provenance. See the review for the 16-case baseline.

The same corpus pins one noise case: a changed error-handler string that never
runs during capture and has no visual effect, which J2 flags.

The cost receipt (#989, `bench/reach-cost.results.json`) measured what recording
the evidence adds to a capture on a GitHub runner:

| Target                                | off (median) | J1 overhead | J1+J2 overhead |
| ------------------------------------- | ------------ | ----------- | -------------- |
| detection-fixture (static, CSS-rich)  | 1443.6 ms    | 1.2%        | 6.5%           |
| example-demo (static dogfood surface) | 1149 ms      | 2.6%        | 3.8%           |
| react-table (React, 300 rows)         | 10081.7 ms   | 0.1%        | 5.3%           |

7 runs per mode on `linux x64`, 4 CPUs, load average 1.2 at start, chromium 149.0.7827.55, run https://github.com/BenSheridanEdwards/StyleProof/actions/runs/39602282519. Thresholds agreed in #989: J1 ≤ 5%, J1+J2 ≤ 15% (median total vs off). Verdict: J1 within threshold, J1+J2 within threshold.

## Decision

1. **The claim.** Each changed unit gets one status: `reached`, `never-rendered`,
   `blind-channel`, `unmeasured`, or `unknown`. A run is **reach-complete** only
   when the evidence for all three joins is complete: every base and head capture
   has a `complete` J1 ledger, every changed stylesheet or component style
   block in the diff was served by a base or head capture, J2 block coverage
   resolved through source maps on both sides, a J3 class-list delta between
   base and head, and every changed dependency file was served and attributed
   to a unit by a served-sources comparison. Every added or deleted line in
   each changed hunk must also map to a J1/J2/J3 unit or served source (item 4), or belong to a path on the base
   revision's explicit non-visual list (item 4). Changed files without text hunks
   require the same attribution or exemption. That list is unchanged by the
   PR, and every changed file it excuses is named in the report, even on a
   reach-complete run. On top of that, every changed unit is `reached`, none
   was cleared by approval, and no run-level evidence gap remains (item 4).
   An empty unit list alone proves nothing. Only a reach-complete green means:
   every changed served CSS rule matched an element StyleProof compared, every
   changed line of render code ran, every changed value-producing line (item 5)
   was corroborated as rendered by a `reached` J1 or J3 unit derived from that
   same value's exact source range, every changed class-token occurrence reached
   a captured element through a delta tied to that occurrence's own source
   range, and every computed-style difference those states produced is in the
   report. Every other green carries a visible,
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
   stylesheet sources (CSS, preprocessor and CSS-module files, plus style
   blocks in component files such as Vue/Svelte/Astro `<style>` and styled-jsx)
   with the sheets served on base and head, by URL or source-map `sources` and
   line mappings. Serving a component's JavaScript alone does not attribute its
   style blocks. A changed stylesheet or style block that no base or head
   capture served, or that cannot be matched to a served sheet (for example, it
   has no source map), produces the same run-level J1 `unknown` row, such as "N
   changed stylesheets never served during capture; changed rules there cannot
   be listed", with each file and affected style-block line range named in
   sorted path and numeric line order. It
   will behave like a missing ledger at both levels once the join is built, and the remedy is a surface
   that loads the sheet, with source mappings where needed to attribute it.
   When the diff changes a dependency's resolved version or contents (a
   lockfile, a manifest's dependency ranges, a vendored package), reach must
   account for every changed file in that dependency's resolved contents (base
   versus head package files). Each changed file must be served by a base or
   head capture and attributed to a J1/J2/J3 unit through the served-sources
   comparison. Any changed dependency file not served, or served but not
   attributed, produces a run-level `unknown` row, "dependency contents changed
   but not served or attributed: <package>: <files>", with packages in sorted
   name order and files in sorted path order. When no served-sources
   comparison exists, or the changed contents cannot be listed, reach produces
   the run-level `unknown` row "dependency changed without a served-sources
   diff: <packages>", with packages in sorted name order. An empty
   served-sources diff never proves a dependency change invisible. A base
   non-visual-list match on a lockfile, manifest or vendored path exempts only
   the changed-line attribution of those lines; it never clears or suppresses
   a dependency row. These rows stay at `'warn'` under either level, like the
   J2/J3 gaps, prevent reach-complete, and cannot be cleared by approval.
   Every added or deleted line in each changed hunk must map to a J1/J2/J3 unit
   or served source, or belong to an explicitly listed non-visual path. A match
   for one hunk never attributes another hunk in the same file. A changed line
   is attributed to a **served source** only when it falls inside a served rule
   or style-block rule that J1 turned into a changed unit. Serving the file
   alone attributes nothing. Any other changed line in a served sheet, such as
   an `@layer`, `@import` or `@charset` statement, a comment, or a preprocessor
   variable or mixin outside any rule, gets the changed-line attribution
   `unknown` below. Any remaining
   changed lines produce a run-level `unknown` row, "changed lines not
   attributable to any join: <file>:<lines>". The report names each uncovered
   range with its base or head side, in sorted path and numeric line order,
   including design-token JSON/YAML, Tailwind/PostCSS configuration, build-time
   codegen inputs and server-side templates when they cannot be attributed. A
   file's extension or absence from captures never makes it non-visual. These
   rows stay at `'warn'` under either level and prevent reach-complete;
   approval cannot clear them (item 3). Changed files without text hunks (such
   as binary or metadata-only changes) still require attribution or a base-list
   exemption; otherwise the same `unknown` finding names the path and reason
   without inventing line numbers. Repository maintainers own the explicit
   non-visual list in repository configuration. Reach reads both the list and
   its configured location only from the comparison's base revision; the PR
   head cannot supply exemptions. An absent base list means no exemptions. An
   unreadable or invalid list grants none and produces a run-level `unknown`
   row naming the reason. Any PR change to the list or its location, including
   creation, deletion or renaming, produces a run-level `unknown` row naming
   the changed configuration and entries in sorted order. These rows stay at `'warn'` under
   either level, prevent reach-complete, and cannot be cleared by approval. The
   report names every changed file the base list excuses, its changed line
   ranges where available and matching entry, in sorted path and numeric line
   order, even on a reach-complete run. All sorting is by code point, not
   locale, so the same inputs give byte-identical rows. Attribution and non-visual exemptions
   supplement the join checks: they never mark a unit `reached` or clear another
   evidence gap.
   Missing J2 coverage or source maps, or a missing J3 class-list delta,
   likewise produces a run-level `unmeasured` row naming the missing evidence.
   Those rows stay at `'warn'` under either level and prevent reach-complete.
5. **Named residuals.** These stay documented, not hidden:
   - **J2 block entry.** An executed anchor means its block was entered; code
     after any expression that threw in that block is not proved. Default parameter
     values, destructuring defaults, logical assignment RHS (`||=`, `&&=`, `??=`),
     and later links of short-circuited optional chains can still be unevaluated.
     V8 does not give every potentially throwing expression its own continuation
     counter. Capture notes name these residuals; the 2.2 join must keep such code unknown rather than infer
     reached from block execution.
     After an optional chain, V8 may end an enclosing idle continuation early,
     so later code in that block can read executed even when it never ran:
     `if (t) return 1; const i = s?.missing?.x; sink("dead");`.
     These counters cannot prove the continuation executed.
     V8 also reports **bodies of generator / async-generator functions that were called but never iterated**
     as executed: iterator creation can give the whole function count 1 with no
     inner idle range. A file whose raw text contains a generator-like pattern
     has its ran evidence downgraded to unmeasured; this may include files with
     no generator. The raw patterns are:
     - `\byield\b` anywhere, including strings/comments;
     - `function GAP *`;
     - `* GAP KEY GAP ? GAP <GENERIC> GAP (` with `?` and `<GENERIC>` optional.

     `GAP` permits whitespace, block comments and line comments between the star,
     key, optional question mark, generic list and parenthesis. Keys accept optional
     `#` followed by `(?:[\p{ID_Continue}$\\]|\{[\dA-Fa-f]+\})+` with Unicode semantics (including
     fixed and braced escaped names with arbitrarily many leading hex zeros), numeric literals including `.5` and `0x…`, quoted keys
     `'(?:\\[^]|[^'\\])*'` / `"(?:\\[^]|[^"\\])*"`, or computed keys equivalent to
     `\[[^]{0,512}?\]`. Generic contents are equivalent to `<[^]{0,512}?>` and
     may include parentheses/newlines. Bounds count Unicode characters.
     A generator with no `yield` whose computed key or type-parameter list exceeds 512 characters is not detected.
     Quoted keys accept escaped CR, LF, CRLF, U+2028 and U+2029 line continuations.
     All raw source positions remain eligible: strings, comments, regex bodies
     and templates are not excluded. Matching multiplication-like text and other
     non-generator text intentionally flags. The rule covers changes outside a
     generator and actually iterated bodies, before same-range corroboration.
     Negative or missing evidence keeps its existing status. Gap ends are
     precomputed once; key and suffix results are cached; each computed/generic
     lookahead is bounded to 512 characters. This is linear in file size with
     fixed bounds and avoids a backtracking whole-header regex. The bounded
     context remains only for parameter residual naming.
     Regex-literal attempts inspect at most 4,096 characters. A failed slash-start
     attempt whose window was cut off before a line terminator makes the remaining
     line negative-only; template and JSX-tag scans stop conservatively too.
     Long division lines may also be over-flagged. Truncated regex bodies must
     never be re-lexed as code.

   - **J2 source-map attribution.** A minifier can merge equivalent arms
     (`flag ? one : one` → `one`) or hoist a shared call
     (`flag ? sink(a) : sink(b)` → `sink(flag ? a : b)`). The source-map anchor
     can remain on one original arm even when the other arm ran, making that
     original arm read executed. J2 cannot detect this from the map. This is
     an attribution residual, and execution alone still supplies no rendering
     proof; corroboration requires the same value's exact source range.
   - value-producing lines at any lexical scope: module, component or render
     body, hook, helper or memo. A value here is anything a line computes that
     can reach the page. Examples, not an exhaustive list: style objects,
     inline `style` values, runtime CSS-in-JS templates, numeric theme
     constants, JSX elements and element tags, non-class attributes and props,
     text, and variant-name strings. J3 cannot see most of them, and J2 proves
     only that the line executed, not that the value
     reached a rendered element. A value computed on every render but applied
     only inside an uncaptured branch executes on healthy captures without
     rendering: `const faultStyle = { color: 'red' }` in `App()`, used only by
     an unopened fault overlay, or `const banner = <strong>Down</strong>`
     (was `<span>`), shown only by `{fault && banner}`. A changed line that
     defines or changes such a value reads `unknown` ("value; rendering not
     proved"), never `reached`, on J2 execution alone. Only a `reached` J1 or
     J3 unit derived from that same value's exact source range (its expression,
     for example a J1 rule mapped to that template range) corroborates it. A
     unit from another value, line or hunk never does, including another value
     on the same line: in `<Banner className="new-x" style={{ color: fault ?
'red' : 'blue' }} />`, a `reached` J3 unit for `new-x` says nothing about
     the style value, which stays `unknown`. Class tokens follow the same rule. J3 can report `never-rendered` only when no captured element on that occurrence's side carries the token (head for additions, base for removals), including unpaired elements, and every map on that side records complete omission facts. Volatile elements, configured ignore lists, untraversed open/closed author roots or embedded documents, omitted head content, route-announcer author children, and html children outside head/body leave absence unproven and the occurrence `unknown`. Facts must be version 2, with successful CDP shadow-root and document-boundary verification, zero omission counts, no instability, and complete capture-key pairing on both sides; version-1/missing facts remain conservative. Omission facts are collected and written only with captureReach. CDP excludes user-agent roots and the shared framework exemptions; route-announcer exemptions cover the host and its shadow tree, not author light-DOM children. Self-check preserves unknown when omission facts differ, even if a later read has zero omissions. Explicit evidence follows a positive token-role allow-list over the existing lexer, with comments skipped and no new runtime dependency: direct bare class-helper arguments, their array elements/object keys, ternary result branches and right-hand `&&`/`||`/`??` results inside positive roles, class attribute / `.className =` values, classList.add arguments and the second classList.replace argument. These roles recurse only through approved value positions; known cva variant/compound class values and supported framework class bindings also qualify. Everything else remains J3-only: non-helper/optional/non-null/generic calls, tagged templates, binary/relational operands including in/instanceof, lookup keys/containers, case labels, arrow bodies, unary/void expressions and non-class assignments. Queries/removals/toggles, dataset assignments, data-class attributes and vocabulary-only candidates cannot lower J2. Plain class properties remain explicit for Vue h() props, with data-object/name/type ambiguities and conservative syntax limits documented in REFERENCE. Presence is a capture-time snapshot; a class added and removed before capture can read never-rendered. Template nesting beyond 128 levels always produces a named extraction gap through EOF, even outside a class context. Bracket/expression limits apply only where role analysis runs (files with recognized class syntax or explicit bindings): completed statements before the first unfinished statement retain their roles; that statement is dropped back to the previous top-level semicolon and covered through EOF (the whole unread expression for a substitution). Implicit semicolons may conservatively widen the gap. Flat else-if chains do not increase nesting depth per alternate. Type scope is an inherited mode entered by annotations/return types, type aliases/interfaces/implements clauses, as/satisfies assertions and balanced generic arguments/parameters (including extends/defaults). Every nested object, tuple, parenthesized, generic, union/intersection or conditional type stays non-explicit until its initializer, parameter/statement boundary or runtime function body. Angle matching stops at runtime operators, statement boundaries and declarator commas; parenthesized arrow return types, ASI statements and case-expression labels resume runtime discovery. J3 re-lexes opaque generic prefixes with the existing TS lexer without changing J2. This remains lexical evidence: unsupported/ambiguous forms may omit both a candidate and its gap, so an absent J3 row does not establish complete checking. Recognized depth/fragment failures have named gaps; REFERENCE states the remaining lexical limits. Runtime property/ternary colons and case/default/statement labels retain runtime class values. Token presence without provenance stays `unknown`; the absence of a directional delta is not negative evidence. Pure additions/deletions cannot be excluded by opposite-blob positions. Replacement exclusions match ordered token values plus positive role/slot across the whole hunk, with multiplicity and cached matching; this does not establish binding identity or render provenance:
     a J3 delta corroborates only the occurrence whose source range produced
     it, proved by per-occurrence provenance (for example, source-mapped render
     provenance linking the captured element's class value to that
     occurrence's expression). A token-name match never counts, even when the
     token is unique in the diff, and neither does J2 execution. With `const
OK = 'new'` and `const FAULT = 'new'` (both were `'old'`), and `FAULT`
     used only by an unopened overlay, a delta on the healthy element never
     clears `FAULT`, which reads `unknown` ("class token; delta not tied to
     this occurrence"). When reach cannot tie a delta to one occurrence, every
     occurrence it could belong to reads `unknown`. When reach cannot tell
     whether a changed line produces a value, or where a value's source range
     ends, it treats the whole line as an uncorroborated value. The line surfaces in the
     report and prevents reach-complete;
   - consequences of a reached change in uncaptured states (item 2);
   - dependency JavaScript that changed without a source diff cannot be
     attributed to a unit until a served-sources diff exists. Until then it is a
     run-level `unknown` finding (item 4), and the run is not reach-complete.
     Dependency CSS is covered by J1 only where a capture served it. Dependency
     JavaScript or CSS that changed but was not served, or was served but not
     attributed, is the same run-level `unknown` finding even when a
     served-sources diff exists. Any other dependency change is the same
     run-level finding.
6. **Default levels.** `changeReach` takes `'warn'` or `'gate'`.
   - New in a minor release, the default is `'warn'`: the report lists every
     non-`reached` unit and run-level evidence gap by status (table below), the
     confidence strip shows "Reach incomplete", and no verdict changes.
     This keeps existing certify and review-gate users backward compatible.
   - `'gate'` is opt-in. In certify mode a `never-rendered` J1 unit fails with
     `CERTIFICATION_FAILED`. In review-gate mode it needs review, and the existing
     Approve checkbox clears it.

   | Status                                            | `'warn'` (default)                                                                                                                                                                                                | `'gate'`, J1 unit                                                                                                 | `'gate'`, J2/J3 unit           | Counts toward reach-complete |
   | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------- |
   | `reached`                                         | no finding                                                                                                                                                                                                        | no finding                                                                                                        | no finding                     | yes                          |
   | `never-rendered`                                  | named finding "Changed but never matched"                                                                                                                                                                         | certify: `CERTIFICATION_FAILED`; review-gate: needs review                                                        | named finding                  | no                           |
   | `blind-channel`                                   | named finding "Changed in a channel computed styles cannot hold" (`@keyframes`, `@font-face`)                                                                                                                     | blocks like `never-rendered`                                                                                      | named finding                  | no                           |
   | `unmeasured`                                      | named finding naming the setting to enable (source maps, `captureReach`)                                                                                                                                          | blocks like `never-rendered`                                                                                      | named finding                  | no                           |
   | `unknown`                                         | named finding with the reason (legacy or partial ledger, value without rendering proof, class-token occurrence without a delta tied to it)                                                                        | blocks like `never-rendered`; legacy base names "recapture with `captureReach`"                                   | named finding                  | no                           |
   | `unknown`, run-level J1 evidence gap              | named finding for a missing or partial ledger, or a changed stylesheet or component style block not served or attributable (target design; until #934 the report names this as not checked)                       | missing or partial ledger blocks like `never-rendered`; unbuilt changed-stylesheet join stays `'warn'` (not held) | not applicable                 | no                           |
   | `unmeasured`, run-level J2/J3 evidence gap        | named finding naming the missing coverage, source maps or class-list delta (item 4)                                                                                                                               | not applicable                                                                                                    | named finding                  | no                           |
   | `unknown`, run-level dependency gap               | named finding naming the changed packages, and the unserved or unattributed files when a comparison exists (item 4)                                                                                               | named finding (stays `'warn'`)                                                                                    | named finding (stays `'warn'`) | no                           |
   | `unknown`, run-level changed-line attribution gap | named finding naming each uncovered `file:lines` range or changed file without text hunks not attributable to any join or served source (item 4) and not exempted by the base revision's non-visual list (item 4) | named finding (stays `'warn'`)                                                                                    | named finding (stays `'warn'`) | no                           |
   | `unknown`, run-level non-visual list gap          | named finding for a PR change to the list or its location, or an unreadable or invalid base list (item 4)                                                                                                         | named finding (stays `'warn'`)                                                                                    | named finding (stays `'warn'`) | no                           |

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
- The report gains a "Changed but never matched" section, and the confidence
  strip may say "Reach complete" only for a reach-complete run (item 1); otherwise
  it shows "Reach incomplete". Neither label is a percentage or score (see
  Alternatives rejected). Without source maps, markup reach reads as
  `unmeasured` and the strip names the setting to enable.
- Reach reads the pull request's changed stylesheet, component style-block and
  dependency paths, not only the captures. A changed stylesheet or style block
  that no capture served (or that cannot be matched to a served sheet) is a
  run-level J1 `unknown` finding, never a silent omission. A lockfile, manifest
  or vendored dependency change is a run-level `unknown` finding unless a
  served-sources comparison serves and attributes every changed dependency
  file; a base-list exemption never clears it.
- Reach accounts for every added or deleted line in each changed hunk. Lines
  not mapped to a J1/J2/J3 unit or served source (as item 4 defines it) and
  not exempted by the base revision's non-visual list produce a named run-level `unknown` finding with
  `file:lines` and the base or head side. It stays at `'warn'` under either
  level and prevents reach-complete, including for build inputs and server-side
  templates. Changed files without text hunks still require attribution or a
  base-list exemption; otherwise the finding names their path and reason.
- The non-visual list belongs to repository maintainers and is read only from
  base. Changing it or its location produces a run-level `unknown` finding and
  prevents reach-complete. Every changed file it excuses remains named in the
  report, including on a reach-complete run.
- `bench/reach-corpus.mjs --check` is the oracle. Phase 1 and 2 replace its
  prototype joins with `src/` code and keep its expectations, with one change:
  the `runtime-css-in-js` scenario is expected as `unknown`, not `reached`.
  The corpus now includes all four required scenarios, each
  expected as `unknown`: a render-scope value applied only in an unopened state
  (a component-body `faultStyle` used only by the fault overlay), an eagerly
  built JSX element that is never mounted (`const banner = <strong>` shown only
  by `{fault && banner}`), a line where a changed class token has a delta (currently `unknown` without provenance)
  but a changed style value on the same line renders only in an unopened state,
  and two module constants changing the same token `'old'`→`'new'`, one
  rendered on the healthy page and one only by the unopened fault overlay,
  where the overlay occurrence is expected as `unknown`, never `reached`. The
  original complete-state J3 expectations (`branch-class`, `module-constant`,
  `colliding-constant`) stay `reached` only through per-occurrence evidence; if
  Phase 1 cannot record that evidence, they are deliberately re-expected as
  `unknown`. #1001 applies that re-expectation to all three complete cases. In declared, branch-class has J3 and combined status `never-rendered`. Module-constant has a `never-rendered` head J3 candidate but combined status `unknown`, because a vocabulary-only candidate cannot lower J2. Colliding-constant has head J3/combined status `unknown` because its token is already present on healthy; its base removal is `never-rendered`. Complete base/head class tokens stay `unknown`. The current corpus tally is 7 declared / 8 complete unknown cases.

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
- a served-sources diff exists: dependency changes can be attributed to units,
  with unserved or unattributed changed files still a run-level gap;
- J2 can attribute a value to a rendered element, or a class-list delta can be
  tied to its source occurrence: such lines, at any scope, can move from
  `unknown` to `reached`.

Unchecked stylesheet guidance appears under **Not checked**, separate from held Reach evidence gaps, and includes the capture remedy.
