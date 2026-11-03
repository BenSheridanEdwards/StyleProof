# Script reach #999

The Chromium fixture reports an executed anchor on original line 3 and an
unexecuted anchor on original line 5. Its script without a source map is
unmeasured. `execution.json` is captured output; `report.json` still names the
unbuilt J2 join. This capture-data change has no UI: screenshots/video do not apply.

The replacement mapper stores original starts only, aggregates conflicting states
to mixed, and never infers executed extents. Source keys use the capture project
root, preserve complete package paths, and refuse outside-root paths/collisions.

Primary test-first receipt: 22 unit regressions failed (4 already passed), plus
four Chromium regressions failed before implementation. Further HAR-array and
pre-compaction collision tests also failed before their fixes. Focused checks
now pass: 85 unit tests and 38 script-reach browser scenarios.

Key tests in `test/script-reach-round3*.{test.mjs,e2e.spec.ts}`:

- `R3.1`: QA's nonmonotonic mappings, removed DEBUG code and repeated starts.
- `R3.2`: three distinct same-kind anchors survive compaction.
- `R3.3`: monorepo/nested paths, checkout roots, URI resolution, Windows roots, outside-root and collisions.
- `R3.4`: webpack eval and missing metadata remain named unmeasured entries.
- `R3.5`: the tracked file-spoof regression passes the actual privacy scanner.
- `R3.6`: vendor-only mappings do not consume the app cap; a real React bundle maps.
- `R3.7–12`: generous backstop, cache load window, total cap, CDP page isolation,
  HAR arrays and one ownership-unavailable warning.
- `R3.14`: CRLF, CR, U+2028 and U+2029 preserve generated offsets.

Real bundle output:

```text
LARGE BUNDLE: 1841203 bytes, 102084 segments, status mapped
```

`bench/reach-cost.mjs` includes `react-catalogue-large` by default. A single local
smoke sample measured off 739.1 ms, J1 802.3 ms (+8.5%), J1+J2 832 ms (+12.6%).
This is fixture validation, not a CI cost verdict; the CI receipt is unchanged.

Full gates on the staged final implementation:

`pnpm run verify`

```text
ℹ style reads: 19780 legacy, 15352 shared
ℹ style reads: 19780 legacy, 15352 shared
ℹ style reads: 580 legacy, 700 shared
ℹ style reads: 14740 legacy, 14740 shared
ℹ budget 328: 82 planner path reads
ℹ budget 327: 82 planner path reads
ℹ tests 4634
ℹ suites 32
ℹ pass 4634
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 262702.913541
```

`pnpm run test:e2e`

```text
  1 skipped
  691 passed (3.7m)
```

The one existing skip is the non-Chromium forced-state case in the Chromium project.
