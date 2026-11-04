# Script join: issue #1000

J2 is advisory, not rendering certification. The git adapter reads the compared
map manifests' SHAs (including a reused ancestor), executes git from the top
level and reanchors paths to the config directory. Added ranges use head;
removed ranges use base. Complete blob-byte hashes must match sourcesContent.
Executed evidence supplies start points only; mixed/unexecuted evidence supplies
spans. Changed lexical ranges keep `a` separate from `b` in `x = a ?? b`.
Execution alone leaves values unknown; only same-source, same-side, exact-range
reached J1/J3 provenance can corroborate them. J1 has no such provenance yet.

## Red → green

Tests and the corpus expectation changed before the implementation. The initial
empty classifier produced **8 failing, 1 passing** behavioral tests; the old
prototype corpus rejected both runtime-css-in-js expectations:

```text
2 violated expectation(s):
  declared: runtime-css-in-js — reach reached, want unknown
  complete: runtime-css-in-js — reach reached, want unknown
```

The retained [unit red output](red-unit.txt) normalizes the checkout path, removes its file-URL prefix, and trims trailing whitespace.
[Corpus red output](red-corpus.txt) is retained verbatim. The targeted classifier,
git adapter, report and corpus tests subsequently passed **53/53**. Tests cover
operand separation, start-only execution evidence, negative/mixed spans, both
sides, exact-range corroboration, all five residuals, missing evidence, source
hash mismatches, ancestor SHAs, config-relative paths, renames, raw blob bytes,
and advisory JSON/Markdown/HTML rendering. A browser regression also joins stored
capture evidence for an executed value and an unopened branch.

Fallow initially rejected three new functions for complexity. Splitting the
hunk-reading and evidence-reading steps resolved all three; final audit reports
zero dead-code, complexity or duplication issues. An overlapping verification
attempt hit an ESLint ENOENT on a disappearing config-evaluation temporary file;
that run was stopped and final verification was restarted without the overlap.

## Corpus before → after

| Measurement                        | Before         | After          |
| ---------------------------------- | -------------- | -------------- |
| Cases / visual cases               | 14 / 13        | 16 / 15        |
| Declared: visual changes shown     | 1/13           | 1/15           |
| Complete: visual changes shown     | 12/13          | 14/15          |
| Declared: misses named             | 11/12          | 14/14          |
| Unknown cases, declared / complete | 0 / 0          | 3 / 3          |
| Error handler, both scenarios      | never-rendered | never-rendered |

**One existing case moved to unknown**, runtime-css-in-js in both scenarios (two
cells). Two new cases, render-scope-value and eager-jsx-element, add four unknown
cells. Total: six unknown cells, three cases per scenario. Other expectations
are unchanged. J3 remains explicitly prototype-only for the three class-token
cases; these results do not prove production J3 provenance or reach-complete.

Final `pnpm run verify` passed **4,756/4,756** tests, with zero failures,
cancellations or skips. `pnpm run bench:reach:check` passed every expectation
(16 cases × two scenarios); `pnpm run demo:check` was current. Verification used
Node 22.23.4 and system Git for disposable fixtures. An earlier Node 22 run
cancelled two existing CLI files at the unchanged 300,000 ms file timeout;
removing Git-wrapper overhead resolved it without changing gates or assertions.

## Report evidence

The [generated excerpt](report-excerpt.md), [reach JSON](reach.json) and screenshot
show the same source range on base and head: both ran, both remain unknown,
`blocking` stays zero under gate, and reach remains incomplete. The screenshot
also preserves the unrelated product-state warning; this is diagnostic,
advisory evidence, not a certified same-state comparison.

![J2 report keeps both executed source ranges unknown and reach incomplete](report.png)

The normal pre-push hook enforces the full browser suite again with
`pnpm run test:e2e --workers=4`; no hook is bypassed. Final command tails and the
pushed head are included in the implementation handoff.
