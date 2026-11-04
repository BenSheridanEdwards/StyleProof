# Script join: issue #1000

J2 is advisory execution evidence, not rendering certification. The git adapter
uses the compared map manifests' SHAs, including a reused ancestor, and the
project-root prefix recorded by each capture. Added ranges use head evidence;
removed ranges use base. Complete blob-byte hashes must match sourcesContent.

The QA correction judges execution starts inside the changed-token range. An
enclosing mixed or idle span cannot flag an evaluated child operand. Mapping
starts retain their innermost V8 entry state when the other state interval has a mapping
start. An unrepresented state interval inside a generated extent stays mixed, retaining
coarse-map uncertainty. A distant same-counter anchor cannot clear a resumed interval. Column-zero maps fall back explicitly to line
scope. Git LF line numbers are converted through blob offsets to JavaScript
terminator line numbers. Execution alone leaves values unknown; only exact
source/side/changed-token-range J1/J3 provenance can corroborate them.

## QA red → green

Regressions and corpus expectations were changed before implementation. Retained
outputs normalize checkout/temporary paths, remove file-URL prefixes and ANSI
codes, and trim trailing whitespace: [unit red](qa-red-unit.txt),
[review red](qa-red-review.txt), [browser red](qa-red-browser.txt),
[producer red](qa-red-producer.txt), [corpus red](qa-red-corpus.txt).
The first unit run had 10 failures / 9 passes; the expanded review run had 7
failures. The original three browser cases had 2 failures / 1 pass. The focused
producer regression failed, and the corpus rejected five result cells.

| Review item           | Red evidence                                                                                                               | Green evidence / resulting behavior                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Evaluated operands | Enclosing-span and cheap-map unit failures; real Chromium nullish operand falsely partly-ran; producer entry-state failure | Units pass; four real esbuild/Chromium cases pass: nullish operand, selected ternary consequent, selected alternative, unopened nullish fallback. Evaluated operands are ran/unknown; unopened fallback remains never-rendered. |
| 2. Dropped files      | Unloaded MDX/template/extensionless-path gap test failed                                                                   | Every unjudged path is named in a sorted run gap; explicit submodule and Unicode ordering tests also pass.                                                                                                                      |
| 3. Line numbering     | Git line 3 was read as JS line 3 after a Unicode separator                                                                 | Test passes for CR, U+2028 and U+2029: git line 3 maps to JS line 4 and the correct blob text.                                                                                                                                  |
| 4. Quadratic join     | 6,000-line getter-backed source test failed                                                                                | Anchors are indexed once per side/source/line; the test passes with bounded source-array reads.                                                                                                                                 |
| 5. Git work           | No-evidence early-return test and all-path diff/blob-batch test failed                                                     | No git work without scriptReach; 42-file fixture uses one diff and one batch, retaining healthy files after a missing blob.                                                                                                     |
| 6. Report size        | 3,000-line compression / fragmented table cap test failed                                                                  | Adjacent equal units render as ranges; tables cap at 100 rows with a remaining count; exact JSON units remain intact.                                                                                                           |
| 7. Project root       | Capture-prefix/cwd-independence test failed                                                                                | Captured prefixes bind paths; unmatched captured keys emit a gap. Browser captures assert the recorded nested-package prefix.                                                                                                   |
| 8. Partial coverage   | Missing-capture test incorrectly reported not loaded                                                                       | Test passes: absent coverage is unmeasured / coverage missing.                                                                                                                                                                  |
| 9. Trimming           | Equal-count hunk / insertion test failed                                                                                   | Unrelated replacement lines retain line scope; pure inline insertions emit no empty base unit.                                                                                                                                  |
| 10. Corpus provenance | Five revised expectations failed under the prototype override                                                              | All expectations pass; J3-prototype has its own field/label and never overrides src J2.                                                                                                                                         |
| 11. Formatting churn  | Manual diff review of the rejected commit                                                                                  | Blank-line-only edits in the four named files and unrelated config-table repadding are removed. No behavioral test applies to whitespace removal.                                                                               |
| 12. Type contract     | Manual comment review                                                                                                      | RuleReach.sourceRange documents conservative changed-token-range matching. No runtime behavior changed.                                                                                                                         |

The first full pre-push browser run caught a stale drift-location assertion: the
containing `if` at original line 2 no longer inherits branch-span state, so the
first changed entry is correctly the branch at line 3. The exact location
assertion was updated from 2 to 3; drift must still become unknown. That run
reported 704 passed, one failed and one skipped; its [failure output](qa-red-full-e2e.txt) is retained.

The targeted classifier, adapter, producer, report and corpus tests pass
**190/190**, with no failures, cancellations or skips. The expanded browser
regression passes **4/4**. The existing warn opt-in behavior stays unchanged:
no reach/scriptReach evidence omits the section; script-only captures show J2.

## Corpus before → after

| Measurement                        | Original prototype | Rejected 9cf55d77f | Corrected join |
| ---------------------------------- | ------------------ | ------------------ | -------------- |
| Cases / visual cases               | 14 / 13            | 16 / 15            | 16 / 15        |
| Declared: visual changes shown     | 1/13               | 1/15               | 1/15           |
| Complete: visual changes shown     | 12/13              | 14/15              | 14/15          |
| Declared: misses named             | 11/12              | 14/14              | 14/14          |
| Unknown cases, declared / complete | 0 / 0              | 3 / 3              | 5 / 6          |
| Error handler, both scenarios      | never-rendered     | never-rendered     | never-rendered |

Against the rejected commit, **three existing cases move to unknown in five
scenario cells**: module-constant and colliding-constant in both scenarios, and
branch-class in complete. Against the original prototype, runtime-css-in-js also
moves to unknown in both scenarios; render-scope-value and eager-jsx-element are
two new unknown cases. The corrected receipt has eleven unknown cells. Separate
J3-prototype rows retain their prototype results and explicitly defer to #1001
for ADR 0009 per-occurrence provenance. See the [corpus review](../../../bench/reach-corpus.review.md).

## Report evidence

The current [generated excerpt](report-excerpt.md), [reach JSON](reach.json) and
screenshot show both changed operands ran and remain unknown. Blocking stays zero
under gate, and reach remains incomplete. The unrelated product-state warning is
preserved: this is diagnostic evidence, not a certified same-state comparison.

![J2 report keeps executed operands unknown and reach incomplete](report.png)

Final verification and the enforced pre-push browser suite are reported with
actual command tails in the implementation handoff. No hook or gate is bypassed.

## Round 2: coarse maps, JSON priority and complete changed-line attribution

Rebased onto main (67b7521da). Before implementation, the retained
[round-two unit run](round2-red-unit.txt) failed **14 tests**, with 24 passing;
the [real-browser run](round2-red-browser.txt) failed both cases. The root-counter
browser fixture records one git-prefix lookup across two surfaces and their
self-checks after the fix. Targeted units subsequently passed **205/205** and
capture/J2 browser scenarios **34/34**.

| Item | Red → green                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | The column-zero ternary read ran/unknown for whole-line and red-token changes; both now read partly-ran/never-rendered with line scope. The original mapper mixed-boundary test is restored. Existing nullish operands, both ternary arms and the unopened fallback stay green.                                                                                                |
| 2    | The 1,500-line fixture lost all 20 style findings; both whole-line and token-range variants now retain 20/20 within 450 KB. A tighter configured budget also keeps all style findings. Only equal whole-line units merge with counts; token units use remaining bytes up to a 64 KB cap. Omitted source units get an exact named gap, full counts and a visible report notice. |
| 3    | A blank line added inside css template text vanished; added and deleted blank lines now remain zero-width unmeasured units with the no-anchors reason. Empty opposite-side token ranges still disappear.                                                                                                                                                                       |
| 4    | A type change and CR followed by diff-header-like content killed all paths; sections now pair by their Git-quoted header paths, including two sections for one type change. Malformed sections leave per-file gaps while healthy siblings survive.                                                                                                                             |
| 5    | An unloaded-only change vanished on a key mismatch; valid recorded prefixes now remain usable and produce not-loaded units plus the warning.                                                                                                                                                                                                                                   |
| 6    | Configured inter-hunk context attributed unchanged lines; fixed diff options and walking actual +/- body lines keep only changed lines.                                                                                                                                                                                                                                        |
| 7    | The long unbalanced residual input entered expensive regexes; lines above 2048 UTF-16 code units skip naming explicitly and remain unknown.                                                                                                                                                                                                                                    |
| 8    | Root provenance was absent from settings and the browser fixture counted three Git lookups; settings now resolve it once and pass it to surfaces, self-checks and popups.                                                                                                                                                                                                      |
| 9    | A J2 gap suppressed the incomplete J1 fallback; only existing ledger-kind gaps now suppress that fallback. Gate still holds the J1 gap.                                                                                                                                                                                                                                        |
| 10   | Adjacent token columns were merged, a missing-evidence side lost its lines, and Unicode reasons sorted as UTF-16; exact token/status assertions, per-side unmeasured units and explicit code-point ordering now pass.                                                                                                                                                          |

A follow-up [interval regression](round2-red-interval.txt) first failed against
the counter-sharing guard. The corrected producer checks each flat V8 interval
independently. In the tiny `a ?? b;` two-anchor fixture, the idle operand remains
mixed when its extent contains an unrepresented executed semicolon; it is still
never-rendered. The real esbuild operand assertions remain ran/unknown. Its fallback’s generated
extent also contains an unanchored executed continuation, so the [exact raw-state
assertion](round2-red-fallback.txt) now requires partly-ran; both base and head
must still be never-rendered. The separate fine-anchor nullish test still requires
ran for the main operand and never-ran for the fallback.

The corpus still has **5 declared / 6 complete unknown cases**. No scenario moved
status in round two; all J3-prototype labels remain separate. The original and
rejected-head comparisons above still apply.

The generated [budget summary](round2-budget-summary.json) and
[report JSON](round2-report.json) record **20/20 findings listed, zero omitted,
75,427 JSON bytes within 450,000**, 3,000 unknown source units, 135 detailed units
retained and **2,865 explicitly truncated**. Human tables independently stop at
100 rows. The screenshots retain the product-state warning, advisory reach status
and the fixture's lack of captured screenshots. They prove diagnostic reporting
and budgeting, not a certified same-state comparison.

![All twenty style findings survive advisory J2 detail](round2-style-findings.png)

![The omitted J2 detail is explicitly counted and named](round2-truncation-gap.png)

The first full verify attempt cancelled `test/ci-cli.test.mjs` at its unchanged
300,000 ms file timeout (4,741 passed, one cancellation, zero assertion failures).
The CI file passed 81/81 separately; a full verify before the final multiline
scope regressions passed 4,823/4,823, with zero cancellations or skips. No gate or timeout configuration was changed.

The first full browser run reported 706 passed, one skipped and one failure in
the provenance counter fixture. Its Node-based Git shim exceeded the resolver's
one-second startup deadline under load, before writing a counter record. The
[retained failure](round2-red-provenance-shim.txt) is instrumentation timing, not
permission to relax the resolver deadline or the one-lookup assertion. A plain
POSIX shell shim now records the same calls and delegates to Git without another
Node startup. The root path includes spaces and an apostrophe to check quoting;
both round-two browser cases pass with that shim. Product code is unchanged.

A final [scope regression](round2-red-scope.txt) exposed a missing line-scope
label when a changed range spans JavaScript terminator lines. Both the label
and multiline fallback failed before the fix; the exclusive-ending-line control passed. The join now marks coarse
rows across the whole selected range and ignores an anchor exactly on the
excluded ending line. The same binary-search index remains in use.

The final targeted unit run passes **208/208**, including all three multiline
scope tests. Final `pnpm run verify` passes **4,826/4,826**, with zero failures,
cancellations or skips. `bench:reach:check` passes all 32 scenario cells and
`demo:check` confirms the generated demo is current. Browser gate tails and the
published SHA are reported in the handoff.
