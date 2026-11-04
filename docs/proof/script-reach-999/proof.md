# Script reach #999

The bundled Chromium fixture records an executed anchor on original line 3 and
an unexecuted anchor on original line 5. Its script without a map is unmeasured.
`execution.json` contains captured evidence; `report.json` names the unbuilt J2
join. This capture-data change has no UI; screenshots/video do not apply.

Executed means block entry. Default parameter values, destructuring defaults,
logical assignment RHS, later optional-chain links, and code after a throwing call
remain unproved. The browser fixtures pin those limits with unevaluated code that
V8 still records as executed; evidence notes retain these residuals for the 2.2 join.

Behaviour tests cover root-relative absolute bundler sources in different build
locations, explicit dot-relative and parent/home paths, and a whole-evidence scan
that rejects leaked filesystem paths. The no-script page plus locator textContent
produces zero script entries, while page eval stays named unmeasured. A map with
100,001 segments maps successfully because ignored webpack sources do not consume
the app budget. Missing routing metadata cannot enable CDP; script-count excess
has a deterministic named unknown entry. Self-check drift also removes retained
per-script execution evidence.

Test-first receipts: 16 new unit regressions and both browser fixtures failed
before the fixes. Existing ownership, cache, popup, large-bundle and original-anchor
scenarios remain covered. Focused checks pass: 111 unit tests and 44 script-reach
browser scenarios.

CI cost receipt: cost-ci.json

Full local gates on the final implementation:

`pnpm run verify`

```text
ℹ tests 4728
ℹ suites 32
ℹ pass 4728
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 262342.528917
```

`pnpm run test:e2e`

```text
  1 skipped
  697 passed (3.7m)
```

The existing skip is the non-Chromium forced-state case in the Chromium project.
