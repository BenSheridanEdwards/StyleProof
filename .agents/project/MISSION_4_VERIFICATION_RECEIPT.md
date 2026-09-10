# Mission 4 Verification Receipt

Mission 4 (#562) — verification of migration mode CLI/Action, gallery sections, and
reviewable structure changes. Proof that certify and style contracts remain fail-closed
and at least as strong after Mission 4.

**Receipt issued:** 2026-09-10  
**Ticket:** #568  
**Parent:** #562 (Mission 4)

## North Star

Never ship a change that decreases confidence that evidence is true or complete.
Certify and style contracts remain fail-closed and at least as strong.

## What shipped

| PR | Ticket | Commit | Change |
| -- | ------ | ------ | ------ |
| #570 | #563 | `c5680756` | Fixture/tests for two-head migration showcase |
| #571 | #564 | `1b63f4c2` | CLI `--migration` flag to styleproof-diff and styleproof-report |
| #572 | #566 | `fe8a2390` | Gallery report sections (Changed styles, New surfaces, New/removed elements) |
| #573 | #565 | `9b7ef361` | Action `mode: migration` input |
| #574 | #567 | `0cfec5ed` | Review-gate: reviewable new/removed elements in migration mode only |

## Locked product rules affirmed

### Q9: Gallery labels locked

Migration gallery sections use the Q9-locked labels:
- **Changed styles** → `SurfaceClassification: 'changed'`
- **New surfaces** → `SurfaceClassification: 'genuinely-new'`
- **New/removed elements** → `ContentChange kind: 'structure'`

**Test coverage:**
- `MIGRATION_GALLERY_LABELS has correct locked labels`
- `Changed styles section includes surfaces with classification "changed"`
- `New surfaces section includes surfaces with classification "genuinely-new"`
- `New/removed elements section includes surfaces with structure changes`

### Q10: Inventory separate / deferred

Removed surfaces stay **separate** from migration gallery buckets. They are not
included in Changed styles, New surfaces, or New/removed elements sections.

**Test coverage:**
- `removed surfaces are NOT included in any migration gallery bucket (Q10 lockdown)`

### Explicit opt-in only

Migration mode requires explicit activation:
- CLI: `--migration` flag
- Action: `mode: migration` input

No auto-activation from `--include-content` or silent default for review-gate users.

**Test coverage:**
- `styleproof-diff --help documents the --migration flag`
- `styleproof-report --help documents the --migration flag`
- `composite action exposes mode input with certify/review-gate/migration values`
- `composite action passes --migration to diff step when mode=migration`
- `composite action migration mode does not pass --migration without explicit mode input`

## Trust guarantees preserved

### 1. Certify mode unchanged

`styleproof-diff <before> <after>` (no flags) behaves identically to pre-Mission-4:
- Exit code 0 only when zero style changes
- Structure changes are **advisory** (do not affect exit code)
- `certifiesFully: true` only when all evidence gates pass

**Test coverage:**
- `styleproof-diff: structure-only changes exit 0 in default certify mode`
- `styleproof-diff: style changes exit 1 in default certify mode`
- `styleproof-diff: no changes exit 0 in default certify mode`
- `styleproof-diff: existing behavior unchanged when --migration is not passed`

### 2. Review-gate mode unchanged

`require-approval: true` without `mode: migration` behaves identically:
- Structure changes do not affect commit status
- Approve box clears only style changes
- Trust state `NO_REVIEWABLE_STYLE_CHANGES` set when no style changes

**Test coverage:**
- `certify mode with structure-only should not require review`
- `composite action exposes require-approval input for review-gate mode`

### 3. Migration mode is strictly additive

`--migration` makes structure changes reviewable without affecting any existing
behavior in certify or review-gate mode:

- **Migration exit codes:** Exit 1 when structure or style changes exist
- **Migration trust state:** `STYLE_REVIEW_REQUIRED` when structure changes exist
- **No existing green becomes red:** Certify/review-gate unchanged without opt-in
- **No existing red becomes green:** Style changes still require approval

**Test coverage:**
- `styleproof-diff --migration: structure-only changes exit 1`
- `styleproof-diff --migration: style changes exit 1`
- `styleproof-diff --migration: no changes exit 0`
- `migration mode: structure-only changes yield STYLE_REVIEW_REQUIRED when changed=true (#567)`

### 4. Trust state invariants

| State | Condition |
| ----- | --------- |
| `NO_REVIEWABLE_STYLE_CHANGES` | No style AND no (migration + structure) changes |
| `STYLE_REVIEW_REQUIRED` | Reviewable changes need approval |
| `CERTIFICATION_FAILED` | Evidence gaps (coverage, determinism, report consistency) |

**Test coverage:**
- `migration mode with structure changes should require review`
- `structure changes should be reviewable` (reviewableChanged: true)
- `composite action does not expose raw-only findings as reviewable changes`

### 5. Advisory content layer unchanged

`--include-content` without `--migration` remains purely advisory:
- Content changes never affect exit code in non-migration mode
- Content changes never affect trust state in non-migration mode

**Test coverage:**
- `migration: false does NOT return migrationGallery`
- `styleproof-report: report.json without --migration does not include migration marker`

### 6. Gallery does not soft-green style findings

Migration mode gallery is **showcase only** — it does not suppress or soft-green
any style findings. Style change counts are identical in migration and non-migration
mode.

**Test coverage:**
- `style changes still affect counts in migration mode (no soft-green)`
- `migration mode does NOT soft-green style findings`
- `changedSurfaces should be same in migration and non-migration mode`
- `totalFindings should be same in migration and non-migration mode`

## No proof weakened — checklist

- [x] **All required checks still required and fail-closed**  
  `required` aggregator still needs: `build`, `e2e`, `e2e-evidence`, `cli-smoke`

- [x] **`required` aggregator still demands all evidence lanes**  
  BUILD_RESULT, E2E_RESULT, E2E_EVIDENCE_RESULT, CLI_SMOKE_RESULT all must equal `success`

- [x] **E2E inventory/completeness still verified**  
  `verify-e2e-shards.mjs` validates shard count and test coverage

- [x] **Determinism oracle receipt still required**  
  STYLEPROOF_DETERMINISM_RECEIPT env var still set; verification script prints it

- [x] **Action dogfood + store dogfood still assert same contracts**  
  `action-dogfood.yml` and `store-dogfood.yml` unchanged in evidence assertions

- [x] **Secret scan / CodeQL / fallow / PR body still gate as before**  
  All sibling workflows run and are required; not moved to scheduled/main-only

- [x] **No tests skipped**  
  1376 unit tests pass; 25 E2E tests pass (35 did not run = expected skip for
  parallel shard assignment)

- [x] **No Node runtime proof removed**  
  Build matrix still tests Node 18, 20, 22; cli-smoke still runs on macOS/Windows

- [x] **Certify exit codes unchanged**  
  Exit 0 = no style changes; Exit 1 = style changes; Exit 2 = usage error; Exit 3 = new surfaces only

- [x] **Migration mode is strictly additive**  
  Requires explicit `--migration` or `mode: migration`; no silent defaults

- [x] **Gallery does not affect trust classification**  
  Gallery is presentation-only; trust state computed identically with or without

- [x] **Structure changes advisory in certify/review-gate**  
  Structure changes only reviewable with explicit `--migration` / `mode: migration`

## New test coverage (Mission 4)

| Test | Ticket | What it proves |
| ---- | ------ | -------------- |
| `styleproof-diff --help documents the --migration flag` | #564 | Flag is documented |
| `styleproof-diff: structure-only changes exit 0 in default certify mode` | #564 | Certify unchanged |
| `styleproof-diff --migration: structure-only changes exit 1` | #564 | Migration elevates structure |
| `styleproof-diff: existing behavior unchanged when --migration is not passed` | #564 | Backward compatible |
| `styleproof-diff --migration: JSON output includes migration marker` | #564 | Migration flag propagates |
| `MIGRATION_GALLERY_LABELS has correct locked labels` | #566 | Q9 labels locked |
| `Changed styles section includes surfaces with classification "changed"` | #566 | Gallery classification |
| `New surfaces section includes surfaces with classification "genuinely-new"` | #566 | Gallery classification |
| `New/removed elements section includes surfaces with structure changes` | #566 | Gallery classification |
| `removed surfaces are NOT included in any migration gallery bucket` | #566 | Q10 separation |
| `report.md includes Q9 gallery section headers in migration mode` | #566 | Gallery rendering |
| `style changes still affect counts in migration mode (no soft-green)` | #566 | No proof weakening |
| `migration mode does NOT soft-green style findings` | #566 | No proof weakening |
| `composite action exposes mode input with certify/review-gate/migration values` | #565 | Action mode input |
| `composite action passes --migration to diff step when mode=migration` | #565 | Action flag wiring |
| `composite action passes --migration to report step when mode=migration` | #565 | Action flag wiring |
| `composite action migration mode does not pass --migration without explicit mode input` | #565 | Explicit opt-in |
| `migration mode: structure-only changes yield STYLE_REVIEW_REQUIRED (#567)` | #567 | Reviewable structure |

## Verification commands run

```bash
# Full gate pass
npm run build          # ✓ pass
npm run typecheck      # ✓ pass
npm run lint           # ✓ pass (1 expected warning: console.warn for fail-soft)
npm run format:check   # ✓ pass
npm run privacy:check  # ✓ pass (374 files scanned)

# Tests
npm test               # ✓ 1376 tests pass, 0 fail
npm run test:e2e       # ✓ 25 tests pass, 35 did not run (shard assignment)

# Demo freshness
npm run demo:check     # ✓ docs/demo/ is up to date
```

## Migration mode confidence argument

1. **Explicit activation only.** Migration mode requires `--migration` (CLI) or
   `mode: migration` (Action). No silent default, no auto-activation from other flags.

2. **Certify mode unchanged.** Without `--migration`, structure changes remain
   advisory and do not affect exit codes or trust state. All existing certify
   tests pass unchanged.

3. **Review-gate mode unchanged.** Without `mode: migration`, structure changes
   remain advisory. The approve box still clears only style changes.

4. **Migration mode elevates structure.** With `--migration` / `mode: migration`,
   structure changes become reviewable alongside style changes. Exit 1 when
   structure or style changes exist; `STYLE_REVIEW_REQUIRED` trust state.

5. **Gallery is showcase only.** The migration gallery (Changed styles, New
   surfaces, New/removed elements) is a presentation layer. It does not affect
   trust classification, exit codes, or approval behavior.

6. **No soft-greening.** Style findings are never suppressed in migration mode.
   `changedSurfaces` and `totalFindings` counts are identical with or without
   `--migration`.

7. **Q9/Q10 labels locked.** Gallery uses the locked labels; removed surfaces
   stay separate from the three migration gallery buckets.

## Deferred (out of scope)

Per parent ticket #562:

- Q10 inventory behavior — deferred to future ticket
- Soft-green structure changes — explicitly rejected
- Weaken style/certify contracts — explicitly rejected
- Remote object store/GC/branch retirement/#480/SaaS — future missions

## Version recommendation

**7.0.0** if the `mode: migration` Action input is considered a worth-it breaking
change for users who might have scripts that pass unknown inputs. Otherwise
**6.4.0** as a minor feature addition with full backward compatibility.

Recommendation: **6.4.0** — migration mode is strictly additive, requires explicit
opt-in, and all existing behavior is unchanged. No breaking change for users who
do not use the new mode.

## Receipt JSON

```json
{
  "mission": 4,
  "tickets": ["#563", "#564", "#565", "#566", "#567"],
  "verification": {
    "unit_tests": "PASS (1376/1376)",
    "e2e_tests": "PASS (25/25 ran, 35 shard-skipped)",
    "store_dogfood_ci": "PASS",
    "action_dogfood_ci": "PASS",
    "demo_freshness": "PASS"
  },
  "trust_guarantees": {
    "certify_unchanged": true,
    "review_gate_unchanged": true,
    "migration_additive": true,
    "explicit_opt_in_only": true,
    "gallery_showcase_only": true,
    "no_soft_green": true,
    "q9_labels_locked": true,
    "q10_separation": true
  },
  "proof_weakened": false,
  "version_recommendation": "6.4.0",
  "deferred": [
    "Q10 inventory behavior",
    "remote object-storage adapter",
    "reachability GC",
    "full Git-branch retirement",
    "hosted StyleProof SaaS"
  ]
}
```

## **No proof weakened.**

Mission 4 changes (migration mode CLI/Action, gallery sections, reviewable structure
changes in migration mode) are strictly additive. Every existing trust guarantee
remains at least as strong:

- Certify mode exit codes and trust states unchanged
- Review-gate mode exit codes and trust states unchanged
- Migration mode requires explicit opt-in (`--migration` / `mode: migration`)
- Gallery is showcase-only; does not affect trust classification
- Style findings never soft-greened; counts identical in all modes
- Structure changes advisory except with explicit migration opt-in
- All CI evidence lanes still required and fail-closed

---

**Receipt author:** Cursor Cloud Agent  
**Verification method:** Local gate pass + hosted CI on PR  
**Base commit:** `fe8a2390` (main) + `9b7ef361` (#573) + `0cfec5ed` (#574)  
**North star unchanged:** Evidence confidence was not weakened.
