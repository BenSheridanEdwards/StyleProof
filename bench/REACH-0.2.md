# Change Reach 0.2: capture cost and flag noise

N=6 of the 12 target PRs replayed (15-attempt cap reached).
This is a limited sample, not a completed twelve-PR replay. The
[aggregate receipt](reach-noise.results.json) contains no per-PR identities.

## Selection and exclusions

`first-parent-renderer-suffixes-v1` walks first-parent history newest first from
a fixed private cutoff, pairing each commit with its first parent. Renderer
suffix globs are supplied privately. Reverts, changes touching more than 40
files, dependency-only changes and renderer changes confined to tests are
excluded. The target is 12 measured pairs, with at most 15 attempts and a
60-minute wall-clock limit. Two unchanged measured pairs were reused after
checking build, overlay and revision inputs. The last replay took 21m 17s.

All nine unmeasured attempts are accounted for:

- Surface-set mismatch: 3.
- Historical app version needs build dependencies not available offline: 6.

No capture-engine failure was used to explain these exclusions. Surface sets
were not narrowed to their intersection to obtain a comparison.

## Thresholds and observations

J1 ≤ 5% — PASSED (0.1–2.6% median overhead, 7 runs per target across 3 targets, chromium 149.0.7827.55; #1032).

J2 ≤ 15% — PASSED (3.8–6.5% median overhead for combined J1+J2 capture, 7 runs per target across 3 targets, chromium 149.0.7827.55; #1032).

≥1 real unreached change across replayed PRs — PASSED (183 real in 6 PRs).

The capture-cost observations come from the existing
[cost receipt](reach-cost.results.json), not from this replay. The J2 budget
includes J1 rather than measuring incremental JS coverage cost alone.

| Join  | Flags | Real | Join-miss noise | No-visual noise | Unclassified |
| ----- | ----: | ---: | --------------: | --------------: | -----------: |
| J1    |     4 |    2 |               2 |               0 |            0 |
| J2    |   184 |  179 |               2 |               3 |            0 |
| J3    |    20 |    2 |              13 |               5 |            0 |
| Total |   208 |  183 |              17 |               8 |            0 |

Each flag is attributed once to its review join; the split is not a count of
every join status a unit carries. Median flags per measured PR: 31; maximum: 69.
Observed noise/flags is 25/208 = 12.02%. No noise-rate threshold was agreed.
The real-change threshold is an existence check, not a recall or precision claim.

## Determinism and labelling

Determinism: PASSED — 0 style drift, 0 ledger drift and 0 app-source coverage
drift. Ten of 17 coverage records had third-party-only raw coverage drift.
The records include 14 actual surfaces plus three registration/metadata checks.
The gate compares mapped app-line execution evidence and source-mapped URL
sets. Vendored event-dispatch timing is excluded because no join reads those
sources. Product code does not consume JS coverage; J2/J3 remain bench prototypes.
The first-base inputs were unchanged, so the passed double-capture was reused.

Fail-closed captures: 0; reasons: none. In particular,
`inline styles unavailable or changed while reading`: 0, including the
determinism double-capture. This does not establish that animating pages can
never encounter that rejection.

Automatic reach evidence labelled 14 flags as join-miss. Claude reviewed the
remaining 194; all 208 private keys have exactly one final label. Claude labels
replace null automatic labels, while automatic labels stand where no reviewer
label exists. Per-line counting inflates the real-flag count when one unexecuted
function spans many changed lines. J3 noise included words in comments/tests
matching class tokens. Claude labelled its own pipeline's output, which leaves
labelling bias; each real label required a named unopened state, retained only
in private evidence. No private state names or examples are published here.

## Limits

- Main process, preload and IPC are outside these joins.
- Fixtures prove only opened renderer states; unopened states remain a coverage gap.
- Code-split chunks without source maps are outside J2.
- CSS-in-JS not served as a stylesheet is outside the served-rule join.
- J1 partial/unmeasured units include shadow DOM, iframes and ignored regions.
- Non-JSX changes can be covered by J2 but are outside J3.
- Changes inside vendored dependencies are outside J2 by construction.
- `var()` in animation dependencies fails closed.
- Ambiguous identical author stylesheets fail closed.

The final two capture limits remain even though this sample had no fail-closed
captures. A real label whose state was captured, a changed join verdict across
identical projected captures, or a private identity in the aggregate receipt
would falsify the relevant claim. Phase 2 remains a separate decision under #934.
