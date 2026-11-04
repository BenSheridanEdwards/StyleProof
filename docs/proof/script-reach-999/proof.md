# Script reach #999

The bundled Chromium fixture records an executed anchor on original line 3 and
an unexecuted anchor on original line 5. Its unmapped script is unmeasured.
`execution.json` contains captured evidence; `report.json` names the unbuilt J2
join. This capture-data change has no UI; screenshots/video do not apply.

Executed means block entry. Default parameter values, destructuring defaults,
logical assignment RHS, later optional-chain links, and code after any expression
that threw remain unproved. The minified external-map property-read fixture pins
`null.x`: its later assignment has executed anchors while `window.after` stays false.
Evidence notes preserve that limit for the 2.2 join.

A 100-button forced-state capture excludes StyleProof’s marked CDP evaluations;
Playwright helpers are excluded too, while page eval remains named unmeasured.
Internal scripts do not consume the app cap and identification has a separate
10,000-record bound. Unknown empty-host schemes use the filesystem root check;
URL parent traversal above the root reads unknown. Runner roots come from the
config directory, then git top level, and are frozen across captures/self-checks
and popups. Generated UTF-8 size is measured once per mapping.

Test-first receipt: 12 new unit cases, three browser fixtures and the REFERENCE
scope check failed before their fixes. Existing protocol tests now recognize the
sourceURL footer while preserving their reset-barrier and snapshot assertions. The REFERENCE tables outside script reach
are restored byte-for-byte to main; the repository formatter does not require
re-padding those documentation tables.

CI cost receipt: [cost-ci.json](cost-ci.json) (GitHub runner, run 41755453348). J1 0–3.7%, J1+J2 5.3–7.2% on the 0.2 targets and the cached-repeat target; the new 1.8 MB single-bundle target sits at the 15% J1+J2 threshold.

Focused checks: 123 script-reach unit tests and 47 browser scenarios passed.

Full local gates on the final implementation:

`pnpm run verify`

```text
ℹ tests 4740
ℹ suites 32
ℹ pass 4740
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 266756.5675
```

`pnpm run test:e2e`

```text
  1 skipped
  700 passed (3.7m)
```

The existing skip is the non-Chromium forced-state case in the Chromium project.
