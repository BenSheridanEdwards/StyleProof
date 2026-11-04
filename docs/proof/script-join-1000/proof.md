# Script join: issue #1000

J2 is advisory execution evidence, not rendering certification. The git adapter
uses the compared map manifests' SHAs, including a reused ancestor, and the
project-root prefix recorded by each capture. Added ranges use head evidence;
removed ranges use base. Complete blob-byte hashes must match sourcesContent.

The QA correction judges execution starts inside the changed-token range. An
enclosing mixed or idle span cannot flag an evaluated child operand. Mapping
starts retain their innermost V8 entry state even when the following generated
segment crosses a block boundary. Column-zero maps fall back explicitly to line
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
