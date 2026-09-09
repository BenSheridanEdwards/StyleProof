# TDD Fixture Coverage Plan

This document tracks the red→green→refactor TDD behaviour examples needed to
stress-test existing StyleProof product features. The audit identified gaps in
fixture coverage that, when filled, will increase confidence in the
capture→diff→report→gate pipeline.

Tracking issue: [#520](https://github.com/BenSheridanEdwards/StyleProof/issues/520)

## Existing Test Infrastructure

### Unit Tests (93 files)
- `test/*.test.mjs` — Node built-in test runner against `dist/`
- Strong coverage of: diff, report summarization, map-store operations, coverage
  guard, confidence ledger, determinism oracle

### E2E Tests (16 files)
- `test/*.e2e.spec.ts` — Playwright specs exercising real browser capture
- Strong coverage of: smoke capture, CLI flow, state recipes, variant crawler,
  auth confidence, data residue

### Fixtures (2 directories)
- `test/fixtures/react-catalog/` — Component manifest consumer contract proof
- `test/fixtures/selective-remap/` — Dependency-cruiser selective capture proof

### CI Dogfood
- `action-dogfood.yml` — Action against own fixtures
- `store-dogfood.yml` — Real capture + map store + diff

---

## Identified Gaps and Implementation Status

### 1. Baseline Failure + New Surface Fixture
**Gap**: No fixture produces baseline capture failures alongside genuinely new
surfaces, preventing regression testing of the classification logic (#491).

**Fixture**: `test/fixtures/mixed-baseline-failure/`
- 5 baseline surfaces with simulated capture failures
- 3 genuinely new head-only surfaces
- 2 changed surfaces with healthy baselines

**Tests**:
- [x] Unit: `baseline-failure-classification.test.mjs` — Assert
  `baselineFailureReceipts` and classification values
- [x] Integration: Assert `report.json.baselineFailures.length === 5` and
  correct per-surface classifications

**Status**: ✅ Implemented

---

### 2. Oracle-Proven Import Fixture
**Gap**: No fixture with `determinism: 'oracle-proven'` in coverage ledger to
test v2 import preservation (#510).

**Fixture**: `test/fixtures/oracle-proven-bundle/`
- Valid v1 bundle with `styleproof-coverage.json` carrying
  `determinism: 'oracle-proven'`
- Minimal surface maps (privacy-clean synthetic)

**Tests**:
- [x] Unit: `oracle-proven-import.test.mjs` — Assert coverage ledger reader
  accepts `oracle-proven`
- [x] Unit: Assert determinism audit maps `oracle-proven` to `proven` trust
  status

**Status**: ✅ Implemented

---

### 3. Report JSON/Markdown Parity Fixture
**Gap**: No explicit test asserts `report.json` and `report.md` agree on
baseline failure counts and surface classifications.

**Tests**:
- [x] Unit: `report-parity.test.mjs` — Given a diff result, assert JSON counts
  match Markdown rendered counts
- [x] Integration: Parse Markdown header, assert equality with JSON

**Status**: ✅ Implemented

---

### 4. Crawl-to-Report E2E Flow
**Gap**: `crawl.e2e.spec.ts` does not exist; crawl coverage is unit-only.

**E2E**: `test/crawl-report.e2e.spec.ts`
- Crawl a simple fixture site
- Run diff between two crawl captures
- Generate report
- Assert surface discovery and report generation succeed

**Status**: ✅ Implemented

---

### 5. Partial Width Capture Fixture
**Gap**: No fixture tests surfaces where some widths succeed and others fail.

**Fixture**: `test/fixtures/partial-width-capture/`
- Surface with 3 declared widths
- Simulated failure at one width

**Tests**:
- [x] Unit: Assert coverage reports partial completion
- [x] Unit: Assert confidence ledger downgrades surface

**Status**: ✅ Implemented

---

### 6. Data Residue Gate Mode Fixture
**Gap**: `data-residue.test.mjs` exists but gate vs warn mode distinction may
not be fully exercised.

**Tests**:
- [x] Unit: `data-residue-gate-mode.test.mjs` — Assert `dataResidue: 'gate'`
  fails on unacknowledged residue
- [x] Unit: Assert `dataResidue: 'warn'` passes with warning only

**Status**: ✅ Implemented

---

## Implementation Notes

- Each fixture is privacy-clean (no real app data, internal URLs, or client
  identifiers).
- Failing-first TDD: tests written first, fixtures created to make them pass.
- Fixtures are minimal and synthetic to stay fast and deterministic.

## Evidence

All tests pass under `npm test` and `npm run test:e2e`. See the verification
commands in the PR for proof.
