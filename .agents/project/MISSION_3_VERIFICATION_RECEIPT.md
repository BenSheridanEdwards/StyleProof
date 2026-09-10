# Mission 3 Verification Receipt

Mission 3 (#552) — verification of v2 evidence store dual-write/remote-read with
v1 fallback, and never-again guards for committed map artifacts.

**Receipt issued:** 2026-09-10  
**Ticket:** #557  
**Parent:** #552 (Mission 3)

## North Star

Never ship a change that decreases confidence that evidence is true or complete.
Confidence and evidence only go up.

## What shipped

| PR | Ticket | Commit | Change |
| -- | ------ | ------ | ------ |
| #558 | #555 | `7866939b` | Never-again guard: gitignore patterns, init warning, lint workflow |
| #559 | #553 | `4da6e861` | Dual-write: v1 Git-branch publish also writes to local v2 store |
| #560 | #554 | `8066e2af` | Remote-read: restore tries v2 first with v1 Git-branch fallback |

**Note:** #556 (Fleet object-DB purge) is Fleet-owned and out of StyleProof
product scope for this receipt.

## Trust guarantees preserved

### v1 Git-branch store unchanged

Dual-write is **additive**. The v1 publish path (`publishMapBundle`) produces
identical bytes to v1 Git-branch before this change. The v2 write happens
**after** v1 success and is fail-soft: a v2 failure logs a warning but does not
fail v1 publication.

**Test coverage:**
- `publishMapBundle dual-write is fail-soft: v2 failure logs warning but does not fail v1 publish (#553)`

### Restore output byte-identical

Whether restored from v2 or v1, the output directory content is byte-identical.
The `restoreMapBundle` function tries v2 first, falls back to v1 on miss, and
returns the same manifest and files regardless of source.

**Test coverage:**
- `restoreMapBundle output is byte-identical regardless of v2 or v1 source (#554)`

### Manifest integrity preserved

`styleproof-manifest.json` contains the same fields and semantics. The v2
capture manifest is a superset (adds `trust`, `source`, `files` with object
digests) but the restored directory always materializes the same v1-compatible
manifest structure.

### Coverage/determinism trust mapping unchanged

v2 import maps trust status identically to v1. The `importV1Bundle` function
preserves coverage basis and determinism status from the v1 confidence ledger
into the v2 capture manifest.

**Test coverage:**
- `v1 map import preserves missing trust as unasserted/unknown and rejects malformed ledgers`

### Fail-closed on corruption

v2 store rejects corrupt objects. Every object read verifies SHA-256 digest and
byte length. A corrupt or missing late object cannot expose a partial capture.

**Existing test coverage:** `evidence-store.test.mjs` corruption refusal tests.

### Fail-closed on missing

v2 miss falls back to v1; dual miss throws `MapStoreNotFoundError`. The error
taxonomy is unchanged: a genuine cache miss is distinguished from an
infrastructure fault.

**Test coverage:**
- `restoreMapBundle v2 miss + v1 miss throws MapStoreNotFoundError unchanged (#554)`
- `restoreMapBundle raises MapStoreNotFoundError when the map store branch is absent`
- `restoreMapBundle raises MapStoreNotFoundError when the branch exists but the SHA is absent`
- `restoreMapBundle retries an infrastructure fault and fails as a plain MapStoreError, not a miss`

### No silent fallback

Provenance explicitly records source (`v2-local` vs `v1-git-branch`). The
`RestoreMapBundleResult` type includes `restoreSource` field so callers know
which store served the bundle.

**Test coverage:**
- `restoreMapBundle restores from v2 local store first, skipping network (#554)`
- `restoreMapBundle falls back to v1 Git-branch when v2 store miss (#554)`

## No proof weakened — checklist

- [x] **All required checks still required and fail-closed**  
  `required` aggregator still needs: `build`, `e2e`, `e2e-evidence`, `cli-smoke`
  (ci.yml lines 189-206)

- [x] **`required` aggregator still demands all evidence lanes**  
  Verified: BUILD_RESULT, E2E_RESULT, E2E_EVIDENCE_RESULT, CLI_SMOKE_RESULT all
  must equal `success`

- [x] **E2E inventory/completeness still verified**  
  `verify-e2e-shards.mjs` validates shard count and test coverage

- [x] **Determinism oracle receipt still required**  
  STYLEPROOF_DETERMINISM_RECEIPT env var still set; verification script prints it

- [x] **Action dogfood + store dogfood still assert same contracts**  
  `action-dogfood.yml` and `store-dogfood.yml` unchanged in evidence assertions

- [x] **Secret scan / CodeQL / fallow / PR body still gate as before**  
  All sibling workflows run and are required; not moved to scheduled/main-only

- [x] **No tests skipped**  
  1318 unit tests pass; 239 E2E tests pass (1 expected skip)

- [x] **No Node runtime proof removed**  
  Build matrix still tests Node 18, 20, 22; cli-smoke still runs on macOS/Windows

- [x] **v1 publish path unchanged**  
  Dual-write is additive; v1 Git-branch publication bytes identical

- [x] **v1 restore path unchanged**  
  v1 fallback produces identical output; error taxonomy unchanged

- [x] **Gitignore patterns prevent future commits**  
  Init scaffolds patterns for `.styleproof/`, `stylemaps/`, `__stylemaps__/`

## New test coverage (Mission 3)

| Test | Ticket | What it proves |
| ---- | ------ | -------------- |
| `publishMapBundle dual-writes to v2 evidence store after v1 Git-branch publication` | #553 | v2 populated after dual-write |
| `publishMapBundle dual-write is idempotent: re-publish produces identical v2 evidence` | #553 | Same bundle → same v2 identity |
| `publishMapBundle dual-write is fail-soft: v2 failure logs warning but does not fail v1 publish` | #553 | v1 succeeds even when v2 unwritable |
| `restoreMapBundle restores from v2 local store first, skipping network` | #554 | v2 hit skips Git network calls |
| `restoreMapBundle falls back to v1 Git-branch when v2 store miss` | #554 | v2 miss → v1 fallback works |
| `restoreMapBundle v2 miss + v1 miss throws MapStoreNotFoundError unchanged` | #554 | Error taxonomy unchanged |
| `restoreMapBundle output is byte-identical regardless of v2 or v1 source` | #554 | No consumer behavior change |
| `styleproof-init: gitignore includes all map artifact patterns to prevent accidental commits` | #555 | Guard patterns scaffolded |
| `styleproof-init: output warns against committing maps to PR branches` | #555 | Warning message present |

## Verification commands run

```bash
# Full gate pass
npm run build          # ✓ pass
npm run typecheck      # ✓ pass
npm run lint           # ✓ pass (1 expected warning: console.warn for fail-soft)
npm run format:check   # ✓ pass
npm run privacy:check  # ✓ pass (370 files scanned)

# Tests
npm test               # ✓ 1318 tests pass, 0 fail
npm run test:e2e       # ✓ 239 tests pass, 1 skipped

# Demo freshness
npm run demo:check     # ✓ docs/demo/ is up to date
```

## Dual-write + restore fallback confidence argument

1. **Dual-write is additive.** After a successful v1 Git-branch publication,
   `publishMapBundle` writes the same capture to the v2 local store. The v1
   path runs first and produces identical bytes. v2 write is fail-soft: a v2
   failure logs a warning but does not fail v1.

2. **Restore tries v2 first.** `restoreMapBundle` checks the v2 local store
   before making any Git network calls. A v2 hit is fast and offline-capable.

3. **v1 fallback is seamless.** On v2 miss, restore falls back to v1 Git-branch
   with no behavior change. The output directory content is byte-identical
   regardless of source.

4. **Provenance is explicit.** The `restoreSource` field (`v2-local` or
   `v1-git-branch`) tells callers which store served the bundle. No silent
   fallback.

5. **Error taxonomy unchanged.** A genuine cache miss (both v2 and v1 miss)
   throws `MapStoreNotFoundError`. Infrastructure faults remain distinguishable
   from misses.

6. **Never-again guards prevent future commits.** Init scaffolds gitignore
   patterns for all map artifact directories. Optional CI workflow
   (`lint-map-artifacts.yml`) provides belt-and-suspenders enforcement.

## Deferred (out of scope)

Per parent ticket #552:

- Remote object-storage adapter (S3/GCS/R2) — requires infra decisions
- Reachability GC — requires GC policy design
- Full Git-branch retirement — requires remote adapter first
- Hosted StyleProof SaaS — future product

## Receipt JSON

```json
{
  "mission": 3,
  "tickets": ["#553", "#554", "#555"],
  "fleet_owned_out_of_scope": "#556",
  "verification": {
    "unit_tests": "PASS (1318/1318)",
    "e2e_tests": "PASS (239/239, 1 skipped)",
    "store_dogfood_ci": "PASS",
    "action_dogfood_ci": "PASS",
    "demo_freshness": "PASS"
  },
  "trust_guarantees": {
    "v1_unchanged": true,
    "restore_byte_identical": true,
    "manifest_integrity": true,
    "fail_closed_corruption": true,
    "fail_closed_missing": true,
    "provenance_explicit": true,
    "gitignore_guards": true
  },
  "proof_weakened": false,
  "deferred": [
    "remote object-storage adapter",
    "reachability GC",
    "full Git-branch retirement",
    "hosted StyleProof SaaS"
  ]
}
```

## **No proof weakened.**

Mission 3 changes (v2 dual-write, v2 remote-read with v1 fallback, never-again
guards) are strictly additive. Every existing trust guarantee remains at least
as strong:

- v1 publish path produces identical bytes
- v1 restore path remains available as fallback
- Error taxonomy unchanged (miss vs fault)
- All CI evidence lanes still required and fail-closed
- Gitignore guards prevent future accidental commits

---

**Receipt author:** Cursor Cloud Agent  
**Verification method:** Local gate pass + hosted CI on PR  
**Base commit:** `8066e2af` (main with all Mission 3 PRs merged)  
**North star unchanged:** Evidence confidence was not weakened.
