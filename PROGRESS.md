# Progress

## Completed: parallel spec captures + absolute STYLEMAP_DIR (4.4.0)

## Completed

- Declared the spec-driven capture describe `parallel`, with a documented
  `parallel: false` opt-out for spec files whose sibling tests read the maps in
  file order (both in-repo ordered suites now opt out explicitly).
- Benchmarked on a real 150-capture consumer workload: 24.5 minutes serial to
  6.0 minutes at 4 workers, byte-complete bundle, all self-checks passing.
- Respected an absolute STYLEMAP_DIR/--dir in the runner and styleproof-map
  instead of nesting it under baseDir.

## Findings

- The runner already generated one independent test per surface×width, but a
  consumer config with `fullyParallel: false` ran all of them serially in one
  worker — the whole 25-minute capture step was a scheduling artifact.
- Two in-repo e2e suites depended on in-file capture-then-assert ordering; the
  parallel default surfaced them immediately (0ms ENOENT failures), hence the
  explicit opt-out knob rather than a silent heuristic.

## Verification Status

- 441 unit tests, 113 Playwright e2e (including the new fan-out pin), all
  static gates, demo byte-identical, privacy scan clean.

## In progress: selective map-store restore

- Completed: reproduced full-branch checkout through the public restore seam
  and added a regression test that requires partial, sparse retrieval while
  preserving full-tree publishing.
- Completed: restore now checks out only the requested SHA bundle; the focused
  regression test passes.
- Next: run the complete quality gates, verify against a large remote store,
  review the diff, and publish the ready pull request.
- Blockers: none.

## In progress: durable no-change Action reports

- Completed: proved the report generator already emits a privacy-clean no-change report.
- Completed: added regressions requiring clean Action runs to publish an immutable report URL while certify mode continues to fail only on real differences.
- Next: run focused and full Action dogfood verification, review the patch, and open a ready pull request.
- Blockers: none.

## Completed: enterprise README proof correction

- Reframed the opening around enterprise evaluation: evidence, failure states,
  trust boundaries, adoption, and reviewer workflow.
- Rejected the previous "clean" dogfood screenshot because it showed unasserted
  coverage, unknown determinism, and an unacknowledged inventory removal.
- Captured the deterministic demo twice in real Chromium with an explicit
  registry, self-checking, inventory, and data-residue gating; all 8 capture and
  coverage tests passed and the generated report is fully certified clean.
- Replaced the misleading image with the GitHub-rendered certified report and
  linked the screenshot to its committed generated Markdown source.
- Reconciled the report example with the current deterministic demo output.
- Verification: build, typecheck, lint, format, privacy, 543 unit tests, 114
  browser E2E tests, demo freshness, dependency audit, and diff checks pass.
- Blockers: none.
