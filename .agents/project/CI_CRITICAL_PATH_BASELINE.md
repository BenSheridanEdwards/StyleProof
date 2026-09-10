# CI critical-path baseline

Mission 2 (#542) — locked baseline for product hosted CI wall-clock.

**Baseline locked:** 2026-09-09 (issue #543)

## Method

The **critical-path wall-clock** is the dependency-aware time from the earliest
required-check start to the `required` aggregator success on a single PR head
commit. This is real elapsed time, not the sum of job CPU minutes across
parallel jobs.

### Calculation steps

1. Enumerate the check contexts that gate merge. The `ci.yml` `required` job
   needs `build`, `e2e`, `e2e-evidence`, and `cli-smoke` to all succeed. Branch
   protection enforces `required`. Sibling workflows (`fallow`, `secret-scan`,
   `codeql`, `pr-body`, `action-dogfood`, `store-dogfood`) run in parallel but
   do not block `required` directly — they must pass independently.
2. For a given PR head SHA, fetch all check runs via
   `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`.
3. Identify the **earliest `started_at`** across all required-chain checks and
   the **`completed_at`** of the `required` check.
4. Critical-path wall-clock = `required.completed_at − earliest.started_at`.
5. Record per-job durations (`completed_at − started_at`) and any queue-delay
   gaps (time between a dependency completing and its dependent starting).

### Dependency graph (ci.yml)

```
         ┌─────────────────┐
         │ build (18/20/22)│  ← parallel matrix
         └────────┬────────┘
                  │
         ┌────────┴────────┐
         │ e2e shards 1,2  │  ← parallel matrix, dominates critical path
         └────────┬────────┘
                  │ (needs: e2e)
         ┌────────┴────────┐
         │   e2e-evidence  │
         └────────┬────────┘
                  │
         ┌────────┴────────┐
         │    cli-smoke    │  ← parallel matrix (macOS, Windows)
         │   (independent) │
         └────────┬────────┘
                  │ (needs: build, e2e, e2e-evidence, cli-smoke)
         ┌────────┴────────┐
         │    required     │
         └─────────────────┘
```

The critical path is: `e2e shard 1/2` (slower shard) → queue gap →
`e2e-evidence` → queue gap → `required`. Build and cli-smoke run in parallel
but are typically shorter than the e2e chain.

## Required-check inventory (baseline time)

| Context | Workflow | Notes |
| ------- | -------- | ----- |
| `required` | ci.yml | Aggregator — fail-closed gate for merge |
| `e2e (node 22)` | ci.yml | Evidence verification (needs both shards) |
| `e2e (node 22, shard 1/2)` | ci.yml | Chromium + Firefox, ~half the specs |
| `e2e (node 22, shard 2/2)` | ci.yml | Chromium + Firefox, other half |
| `build (node 18)` | ci.yml | Build + unit tests |
| `build (node 20)` | ci.yml | Build + unit tests |
| `build (node 22)` | ci.yml | Build + unit + lint/format/privacy/audit/demo |
| `cli smoke (macos-latest)` | ci.yml | Package smoke test |
| `cli smoke (windows-latest)` | ci.yml | Package smoke test |
| `CodeQL` | codeql.yml | SAST initializer |
| `CodeQL analyze` | codeql.yml | SAST analysis |
| `gitleaks (full history)` | secret-scan.yml | Secret scan |
| `action-dogfood` | action-dogfood.yml | Action self-test |
| `round-trip` | store-dogfood.yml | Map-store dogfood |
| `Validate PR body` | pr-body.yml | PR body structure |
| `fallow` | fallow.yml | Dead code / complexity |

Total: **16 check contexts** on a typical PR.

## Sample PRs

| PR | Head SHA | Merged | Wall-clock | Shard 1 | Shard 2 | e2e-evidence | Queue gap¹ |
| -- | -------- | ------ | ---------- | ------- | ------- | ------------ | ---------- |
| #541 | `1c9ec18` | 2026-09-09T19:49Z | **6m 28s** | 3m 34s | 2m 33s | 21s | 2m 10s |
| #540 | `fd1d0cf` | 2026-09-09T19:28Z | **4m 11s** | 3m 38s | 2m 38s | 22s | 3s |
| #523 | `3c50c2f` | 2026-09-09T18:19Z | **4m 10s** | 3m 40s | 2m 17s | 18s | 3s |
| #522 | `bafead1` | 2026-09-09T17:32Z | **4m 21s** | 3m 15s | 2m 35s | 19s | 39s |
| #521 | `729afa1` | 2026-09-09T16:27Z | **3m 54s** | 3m 22s | 2m 32s | 19s | 3s |

¹ Queue gap = time from slower shard completion to e2e-evidence start. Caused
  by runner availability and GitHub Actions scheduling, not job logic.

## Locked baseline metric

| Metric | Value | Notes |
| ------ | ----- | ----- |
| **Median critical-path wall-clock** | **4m 11s** | 5 samples, median |
| **P90 critical-path wall-clock** | **~6m 28s** | Single outlier with 2m+ queue gap |
| **Mean critical-path wall-clock** | **4m 37s** | 5 samples |

**Locked baseline for Mission 2: 4m 11s (median) / 4m 37s (mean)**

Mission 2 success criterion: achieve ~50% reduction (~2m 5s median) on
waste-only cuts without weakening any required check.

## Top cost centers

| Rank | Job | Median duration | % of critical path | Notes |
| ---- | --- | --------------- | ------------------ | ----- |
| 1 | e2e shard 1/2 | 3m 34s | ~86% | Consistently slowest shard |
| 2 | e2e shard 2/2 | 2m 35s | ~62% | Runs parallel, not on path |
| 3 | build (node 22) | 2m 1s | ~48% | Runs parallel with e2e |
| 4 | build (node 20) | 1m 49s | ~44% | Parallel |
| 5 | build (node 18) | 1m 42s | ~41% | Parallel |

The e2e critical chain (shard 1 + queue gap + evidence + required) dominates.
Build and cli-smoke finish before e2e-evidence starts.

## Shard imbalance

| PR | Shard 1 | Shard 2 | Imbalance |
| -- | ------- | ------- | --------- |
| #541 | 3m 34s | 2m 33s | +40% |
| #540 | 3m 38s | 2m 38s | +38% |
| #523 | 3m 40s | 2m 17s | +61% |
| #522 | 3m 15s | 2m 35s | +26% |
| #521 | 3m 22s | 2m 32s | +33% |

**Median shard imbalance: +38%** (shard 1 longer than shard 2)

Rebalancing shards is a waste-only cut: it does not weaken evidence (same
tests run), only redistributes them.

## Queue-delay observations

Queue gaps between shard completion and e2e-evidence start vary significantly:

- Typical: 3–39 seconds
- Outlier: 2m 10s (#541, possibly runner contention)

These gaps are GitHub Actions scheduling, not controllable by workflow logic.
The 2m+ outlier inflates the P90 but not the median.

## Waste patterns identified (for B-tickets)

1. **Shard imbalance** — 26–61% imbalance; rebalancing can shave ~30s–1m from
   the critical path without reducing test coverage.
2. **Playwright `--with-deps` apt install** — both shards reinstall apt
   packages even with browser cache hit; removing apt-redundancy is waste-only.
3. **Duplicate npm ci + build** — e2e-evidence job runs full `npm ci` solely
   to `--list` shards; build already proven by parallel jobs.

## Verification

This baseline was computed from GitHub Actions check-run timestamps only,
using `gh api` against the merged PR head SHAs listed above. The method is
reproducible by anyone with repo read access.

## References

- Parent spec: #542
- Baseline ticket: #543
- Cut tickets (out of scope for this baseline): #544, #545, #546, #547
