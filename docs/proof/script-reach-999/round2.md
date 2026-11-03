# Script reach #999: round-two corrections

Branch: `feat/reach-script-coverage-999`. Starting head: `cb3562c7f`.
`git fetch origin && git rebase origin/main` reported main unchanged at `2292aee5e`.

Changes cover mapping gaps, named blobs, cache ownership, debugger pauses, storage-dependent self-checks,
local-file safety, mapping/evidence bounds, nullable sources, path privacy and routed map reads.
No diff join or class-list delta was added. No UI changed: screenshots/video are not applicable;
the replacement proof is real Chromium capture output in `execution.json`, plus unit/E2E command output.
The report's J2 join remains unmeasured (`report.json`).

Primary regressions were written and run before their fixes. Additional coverage includes actual
persistent contexts, X-SourceMap headers, resource fallback, HAR/routing refusal, regular/oversized files,
and an 11,000-line branchful application transformed with esbuild and captured by Chromium.

| Finding | Red evidence                                                                                                                             | Green coverage                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1      | Exact `AAAA,K,cAAmB` unit and browser reproductions included dead `bad()` in executed spans.                                             | Both reproductions exclude original columns 13–19. Generated gaps stop spans; all original anchors bound endpoints.                                                                                                                                                  |
| Q2      | Blob browser assertion received no entry.                                                                                                | A named `blob:` entry is unmeasured, without UUID drift.                                                                                                                                                                                                             |
| B1      | Unit found no owned-session cache disabling; positive best-effort coverage invalidated the whole capture.                                | Cache is disabled/restored; four cacheable navigations on one page are measured; best-effort affects only its script. The browser cache case passed even before the fix on this host.                                                                                |
| B2      | Unit found Debugger enabled during arm.                                                                                                  | Debugger metadata is replayed at stop with pause/resume handling; the debugger interval browser case completes. The browser timing case also passed before the fix on this host.                                                                                     |
| B3      | Pure, runner and localStorage reproductions threw on changed execution.                                                                  | Execution drift records unknown with the first source key and changed line; capture completes.                                                                                                                                                                       |
| B4      | HTTP→file and abort/regular-file reader tests failed; a later sourceURL-spoof reproduction actually returned mapped local-file evidence. | HTTP→file and spoofed file identity are refused; file pages still map in persistent contexts. Aborted, non-regular and oversized local files are refused.                                                                                                            |
| N1      | Segment-count and expired-budget tests did not throw.                                                                                    | Generated/mapping/range/segment bounds and the shared read/CPU deadline produce unknown. The existing 20k-segment/10k-range timing test still passes. Vendor segments are skipped before indexing; numeric indexes and a base64 lookup replace repeated string work. |
| N2      | Oversized evidence invalidated valid sibling scripts; app-sized evidence lacked compact encoding.                                        | Per-script 1 MiB caps preserve siblings; tuple spans keep the realistic bundle below the cap. A further red test caught accidental removal of exclusive-end point anchors, now retained.                                                                             |
| N3      | A legal null source rejected the entire map.                                                                                             | Null sources terminate mappings as unmapped barriers.                                                                                                                                                                                                                |
| N4      | Terminal col 999 on a ten-character original line was accepted.                                                                          | Invalid original anchors are rejected, including terminal anchors; ends cannot exceed original line length.                                                                                                                                                          |
| N5      | Public coverage and an external CDP session both reported generic shared coverage.                                                       | Separate reasons cover active public coverage, public use during capture, user CDP sessions, best-effort coverage and non-Chromium. Existing unexecuted-block preservation regressions remain green.                                                                 |
| N6      | Checkout paths/namespaces, signed queries and fragments remained stored; a further red dev-server path test exposed home paths.          | Project-relative keys match across checkout roots/ports; webpack namespaces and URL credentials/query/fragment/home paths are removed.                                                                                                                               |
| N8      | A failed routed page fetch invoked the CDP fallback.                                                                                     | Page routes and HAR replay suppress the fallback; the browser map-abort test stays unknown. Unrouted CDP fallback still works.                                                                                                                                       |
| N9      | Primary regressions above failed before fixing.                                                                                          | All regression tests, realistic evidence-size capture and existing popup/source-map/ownership cases are covered.                                                                                                                                                     |

The popup fixture changes only its trailing comment per reopen to isolate mapped popup evidence from
Chromium's remaining renderer best-effort reuse under route.fulfill. Genuine cacheable reuse is tested
separately through a real HTTP server; any remaining positive best-effort script is unknown.

Initial unit command: `node --test test/script-reach-round2.test.mjs test/script-reach-round2-reader.test.mjs`

```text
✖ B1 cache is disabled on the owned session for the tracked window (5.039041ms)
✖ B1 best-effort functions affect only their script and have a distinct reason (0.486875ms)
✖ B4 HTTP scripts cannot make the capture read a local map file (2.770542ms)
✖ N6 stored script URLs discard queries and fragments (0.415458ms)
✖ N8 CDP fallback is refused while routing or HAR replay is active (0.316833ms)
✖ N5 active page.coverage and an external CDP controller have distinct reasons (0.151541ms)
✖ N2 the size cap is per script and a valid sibling remains measured (4.027375ms)
✖ B4 the local map reader honours AbortSignal (0.332375ms)
✖ Q1 exact repro: executed spans never bridge the unmapped gap over dead bad() (1.511667ms)
✖ N3 null sources are unmapped barriers, not invalid source maps (0.058625ms)
✖ N4 terminal original anchors outside sourcesContent cannot stretch a span (0.2335ms)
✖ N1 source mapping has a segment-count guard before large indexes accumulate (105.365083ms)
✖ N1 mapping rejects an expired CPU budget (0.322625ms)
✖ N6 source identity removes checkout roots and webpack namespaces (0.404875ms)
✖ B3 mapped execution drift records a named unknown and never throws (0.515459ms)
ℹ tests 15
ℹ suites 0
ℹ pass 0
ℹ fail 15
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 204.480875
```

Initial focused Chromium regression run:

```text
  5 failed
  2 passed (5.3s)
```

Additional red tests preceded the compact-anchor, dev-server URL and file-identity-spoof fixes.
Their failures were respectively a missing exclusive-end anchor, a stored home path, and `mapped`
local-file evidence from an HTTP page. The file-spoof case is now explicitly part of the E2E suite.

Cached-load benchmark target: `react-table-repeat`, enabled by default and selectable with
`node bench/reach-cost.mjs --target react-table-repeat --runs 1 --output <receipt>`.
Each sample averages three navigations on one page, using real `max-age=3600` assets and checking
measured app-source evidence on every J2 navigation. The old CI receipt is unchanged.
The local smoke run used macOS arm64, Node 26.12.1 and Chromium 149.0.7827.55:

```text
StyleProof reach cost — 1 run(s) per mode, chromium 149.0.7827.55

  react-table-repeat (React, 300 rows, mean of 3 cacheable navigations on one page)
    off    median  2719.6 ms (load 16.4 ms, range 2719.6–2719.6)
    J1     median    2971 ms (load 17.6 ms, range 2971–2971)  overhead 9.2%
    J1+J2  median    2952 ms (load 40.6 ms, range 2952–2952)  overhead 8.5%

  J1 ≤ 5%: over threshold
  J1+J2 ≤ 15%: within threshold
  host load average 6.2 / 9 / 17.8 at start, 6.9 / 8.7 / 17.2 at end
```

This single local sample is a smoke test, not a CI cost verdict or a within-noise claim. CI measurement is left to the orchestrator as requested.

Additional targeted red output:

```text
✖ B2 the tracker does not enable Debugger until stop (0.136375ms)
✖ B4 local maps must be regular files under the input cap (0.183542ms)
✖ N2 compact evidence removes interior duplicate anchors but retains exclusive-end anchors (0.8365ms)
✖ N6 development-server file URLs cannot retain home paths (0.634125ms)
File identity spoof: expected unknown/refused; received status: mapped.
```

Final implementation gate: `pnpm run verify`

```text
ℹ style reads: 19780 legacy, 15352 shared
ℹ style reads: 19780 legacy, 15352 shared
ℹ style reads: 580 legacy, 700 shared
ℹ style reads: 14740 legacy, 14740 shared
ℹ budget 328: 82 planner path reads
ℹ budget 327: 82 planner path reads
ℹ tests 4569
ℹ suites 32
ℹ pass 4569
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 553720.754375
```

Context, suppressions, typecheck, lint, anti-slop, format and privacy checks all passed in this command.

Final browser gate: `pnpm run test:e2e`

```text
  1 skipped
  687 passed (4.1m)
```

The one existing skip is the non-Chromium forced-state case in the Chromium-only project.

Selected actual browser pass lines from that full gate:

```text
  ✓  361 [chromium] › test/script-reach-round2.e2e.spec.ts:35:1 › Q1 browser false branch is never executed through an unmapped gap (88ms)
  ✓  363 [chromium] › test/script-reach-round2.e2e.spec.ts:59:1 › B1 four cacheable navigations on one page retain precise evidence (98ms)
  ✓  364 [chromium] › test/script-reach-round2.e2e.spec.ts:74:1 › B2 arming after a debugger interval cannot hang the next navigation (63ms)
  ✓  365 [chromium] › test/script-reach-round2.e2e.spec.ts:86:1 › B3 localStorage first and repeat visits record named unknown evidence (76ms)
  ✓  366 [chromium] › test/script-reach-round2.e2e.spec.ts:108:1 › N2/N9 app-sized evidence uses compact spans under the per-script cap (131ms)
  ✓  369 [chromium] › test/script-reach-round2.e2e.spec.ts:132:1 › B4 browser HTTP scripts cannot read a file source map (58ms)
  ✓  370 [chromium] › test/script-reach-round2.e2e.spec.ts:148:1 › N8 browser map routing cannot be bypassed with the CDP fallback (62ms)
  ✓  371 [chromium] › test/script-reach-round2.e2e.spec.ts:163:1 › B4 an HTTP page cannot spoof a file script URL to read local maps (50ms)
  ✓  428 [chromium] › test/script-reach.e2e.spec.ts:314:1 › review 11: popup captures retain mapped navigation evidence (3.0s)
  ✓  470 [chromium] › test/script-reach.e2e.spec.ts:457:1 › review 1/2: pre-bound active coverage remains precise after tracker disposal (116ms)
```

An earlier full browser attempt failed because the shared Chromium executable was missing:
441 tests failed, 101 did not run and 146 passed. The browser was restored with
`PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install chromium`; no source changes
were needed. The complete rerun above passed. The CI cost receipt was not rerun or replaced.
