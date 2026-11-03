# Script reach #999

The Chromium fixture in `script-reach.e2e.spec.ts` reports an executed anchor on
original line 3 and an unexecuted anchor on original line 5. The script without a
map is unmeasured. `execution.json` is captured output; `report.json` names the
unbuilt J2 join. This capture-data change has no UI; screenshots/video do not apply.

Executed means the innermost V8 block containing a mapped generated segment ran.
Default parameter values, destructuring defaults, logical assignment RHS and later
optional-chain links remain named expression-evaluation residuals in evidence
notes. The 2.2 join must not treat those expressions as reached.

Test-first receipt: 10 unit regressions and three browser regressions failed before
the fixes; the early-metadata pause regression also failed before its fix.
Behaviour-named tests cover Vite filesystem root checks across checkouts, webpack
ignored sources, original anchors and conflicts, matcher-specific CDP/page reads,
Playwright versus page eval, cache restoration and parsed-code size guards. The
real bundled fixture maps 1,841,203 bytes with 102,084 total app/vendor segments.

Cost is evaluated on the CI runner: [CI receipt](cost-ci.json), supplied separately
by the orchestrator. The bench includes cached repeated navigations and the large
single bundle. Local laptop numbers are excluded.

Focused results: **95 unit tests passed; 42 script-reach browser scenarios passed**.

| Finding | Red → green evidence                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Expression fixture: missing notes → explicit residuals, zero fault calls, executed block anchors retained.                                           |
| 2       | Vite outside-root accepted/checkouts differed → refused/stable package key.                                                                          |
| 3       | Runner map became unknown with patched fetch → mapped through CDP outside replay matcher.                                                            |
| 4       | Four anonymous entries → one page eval; early-metadata pause test also failed before its fix. Refreshed execution.json has no Playwright entries.    |
| 5       | Missing cache restore → restored before map read without a load event; capture callback is covered.                                                  |
| 6       | Ignored webpack module threw → non-app/undefined.                                                                                                    |
| 7       | Oversized parsed script mapped → unknown before getScriptSource.                                                                                     |
| 8       | Interior point anchors dropped → all distinct anchors retained. Stored format/projection is tuple-only.                                              |
| 9–10    | Documentation/receipt cleanup: behaviour names, merged resource tests, one changelog entry, local cost receipt removed. Static/privacy gates passed. |

Full gates on the final implementation:

`pnpm run verify`

```text
ℹ tests 4712
ℹ suites 32
ℹ pass 4712
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 269306.864291
```

`pnpm run test:e2e`

```text
  1 skipped
  695 passed (3.7m)
```

The existing skip covers the non-Chromium forced-state case in the Chromium project.
