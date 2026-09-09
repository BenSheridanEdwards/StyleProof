# Mission 2 Verification Receipt

Mission 2 (#542) — verification of CI critical-path waste-only cuts.

**Receipt issued:** 2026-09-09  
**Ticket:** #547 C  
**Verification PR:** #551

## Before — Locked baseline (#543)

| Metric | Value |
| ------ | ----- |
| **Median critical-path** | 4m 11s (251s) |
| **Mean critical-path** | 4m 37s (277s) |
| **Sample PRs** | #541, #540, #523, #522, #521 |
| **Top cost center** | e2e shard 1/2 at ~3m 34s median |
| **Shard imbalance** | +38% (shard 1 > shard 2) |

Method: dependency-aware wall-clock from earliest required-check start to
`required` aggregator success (GitHub Actions timestamps).

Full baseline: [CI_CRITICAL_PATH_BASELINE.md](CI_CRITICAL_PATH_BASELINE.md)

## After — Combined cuts measured

**Measured head:** `e6f32883` (PR #551, stacked cuts)  
**CI run:** 2026-09-09T21:56Z  
**Cache state:** Playwright browser cache **MISS** (cold run with full download)

| Job | Duration | Notes |
| --- | -------- | ----- |
| e2e shard 1/3 | 3m 14s | Critical-path bottleneck |
| e2e shard 2/3 | 1m 42s | Rebalanced |
| e2e shard 3/3 | 2m 47s | Rebalanced |
| e2e-evidence | 6s | Slim (no npm ci) |
| Queue gap | 3s | shard 1 → evidence |
| required | 2s | Aggregator |

**Critical-path wall-clock:** 3m 28s (208s)

## Delta

| Metric | Before | After | Delta | % Change |
| ------ | ------ | ----- | ----- | -------- |
| **Critical path** | 4m 11s | 3m 28s | −43s | **−17.1%** |
| Target | — | 2m 5s | — | ~50% |

**Result:** 17.1% reduction achieved. **Target not met.**

## Gap analysis

The ~50% target required reducing critical path from 251s to ~125s. The
measured 208s is 83s above target (33 percentage points short).

### Why the gap?

1. **Shard 1 still dominates (3m 14s).** The 3-shard rebalance helped shards
   2/3 but did not substantially shorten shard 1, which runs the slowest
   browser tests. More granular rebalancing or test optimization needed.

2. **Playwright cache missed.** This run downloaded browsers with `--with-deps`
   (apt install). Cache hits should save ~20-30s on each shard, but the first
   run after changing the cache key pays the cold penalty.

3. **e2e-evidence slim cut was small.** The job went from ~20s to 6s — a 14s
   absolute savings, but the critical path is dominated by shard 1.

### Waste mapped for future cuts

| Area | Potential | Difficulty |
| ---- | --------- | ---------- |
| Further shard rebalancing | ~15–30s | Low |
| Playwright cache warm | ~20–30s/shard | Auto (next run) |
| Test runtime optimization | Variable | Medium |
| Parallelizing more build work | ~30–60s | High |

## Cuts applied

| PR | Ticket | Change |
| -- | ------ | ------ |
| #548 | #543 | Baseline doc (CI_CRITICAL_PATH_BASELINE.md) |
| #549 | #544, #545 | 3 shards + Playwright cache key optimization |
| #550 | #546 | Slim e2e-evidence (no npm ci/Playwright) |

## No proof weakened — checklist

- [x] **All required checks still required and fail-closed**  
  `required` aggregator still needs: `build`, `e2e`, `e2e-evidence`, `cli-smoke`

- [x] **`required` aggregator still demands all evidence lanes**  
  Verified in ci.yml lines 191-206

- [x] **E2E inventory/completeness still verified**  
  `verify-e2e-shards.mjs` validates shard count and test coverage

- [x] **Determinism oracle receipt still required**  
  STYLEPROOF_DETERMINISM_RECEIPT env var still set; verification script prints it

- [x] **Action dogfood + store dogfood still assert same contracts**  
  action-dogfood.yml and store-dogfood.yml unchanged in evidence assertions

- [x] **Secret scan / CodeQL / fallow / PR body still gate as before**  
  All sibling workflows run and are required; not moved to scheduled/main-only

- [x] **No tests skipped**  
  1309 unit tests pass; e2e shards run all 241 browser tests

- [x] **No Node runtime proof removed**  
  build matrix still tests Node 18, 20, 22; cli-smoke still runs on macOS/Windows

## Buyer-legible openings

All implementing PRs (#548, #549, #550) open with:
1. Pain statement (4+ minute CI wait / shard imbalance / duplicate work)
2. Why this PR solves it (baseline measurement / rebalancing / deduplication)
3. How it stays waste-only (no evidence removed, all gates remain fail-closed)

Ticket references follow the problem framing, not lead the body.

## Required CI evidence

**PR #551 CI status:** All 17 check contexts passed except `Validate PR body`
(non-blocking formatting issue, to be fixed).

| Context | Status |
| ------- | ------ |
| required | ✓ SUCCESS |
| e2e (node 22) | ✓ SUCCESS |
| e2e (node 22, shard 1/3) | ✓ SUCCESS |
| e2e (node 22, shard 2/3) | ✓ SUCCESS |
| e2e (node 22, shard 3/3) | ✓ SUCCESS |
| build (node 18) | ✓ SUCCESS |
| build (node 20) | ✓ SUCCESS |
| build (node 22) | ✓ SUCCESS |
| cli smoke (macos-latest) | ✓ SUCCESS |
| cli smoke (windows-latest) | ✓ SUCCESS |
| action-dogfood | ✓ SUCCESS |
| round-trip | ✓ SUCCESS |
| gitleaks (full history) | ✓ SUCCESS |
| CodeQL | ✓ SUCCESS |
| CodeQL analyze | ✓ SUCCESS |
| fallow | ✓ SUCCESS |
| Validate PR body | ✗ FAILURE (non-blocking) |

## Conclusion

Mission 2 cuts achieved **17.1% reduction** (43s) in critical-path wall-clock.
The ~50% target was **not met** — gap of 33 percentage points remains.

### Honest assessment

The cuts were waste-only (no evidence weakened), but the waste identified in
#544/#545/#546 was less impactful than estimated. The dominant cost center
(shard 1 browser tests) requires more aggressive optimization — either finer
shard rebalancing, test runtime improvements, or parallel build restructuring.

### Recommendation

1. Merge the waste cuts (#548, #549, #550) — they provide real savings with no
   evidence regression.
2. Track ~17% as the verified improvement; do not claim ~50%.
3. Open follow-up tickets for deeper shard optimization if 50% remains a goal.

---

**Receipt author:** Cursor Cloud Agent  
**Verification method:** GitHub Actions timestamps on PR #551 head `e6f32883`  
**North star unchanged:** Evidence confidence was not weakened.
