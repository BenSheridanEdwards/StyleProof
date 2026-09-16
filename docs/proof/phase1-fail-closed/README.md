# Phase 1 fail-closed proof (#671)

Issue #671 requires Phase 1 dogfood harnesses to **fail closed** when report
mapping is wrong or evidence is incomplete — never soft-pass as green. Soft-pass:
**HOLD**.

This directory documents where those acceptance criteria are already covered on
`main` (landed via #676 / #669). No new harness code is required for #671.

## Acceptance coverage map

| AC | Requirement | Covered by (file → test / symbol) |
| --- | --- | --- |
| 1 | Explicit fail-closed checks for incomplete/wrong mapping | `test/phase1-foundation-harness-lib.ts` → `assertPhase1CssDiffFinding`, `assertPhase1CssReportMapping` (`FAIL-CLOSED:` throws) |
| 2 | Negative fixture proves failure on broken/missing evidence | `test/phase1-foundation-harness.e2e.spec.ts` → `fail-closed: incomplete report mapping is rejected` |
| 3 | Soft-pass HOLD in test design | `example/demo/phase1-css-delta.json` → `softPass`; harness spec/lib header comments |

## Negative fixture (AC2)

The dedicated negative test injects a synthetic incomplete report (zero style
changes, empty surfaces, “No reviewable computed-style changes”) and asserts
`assertPhase1CssReportMapping` throws `/FAIL-CLOSED/`:

```
test/phase1-foundation-harness.e2e.spec.ts :: fail-closed: incomplete report mapping is rejected
```

Run locally:

```
npx playwright test test/phase1-foundation-harness.e2e.spec.ts -g "fail-closed"
```

## Wrong-mapping guard (AC1, positive path)

When the demo oracle does not match captured output, the full harness e2e fails
before report mapping — see TDD red proof in
`docs/proof/phase1-foundation-harness/red.log` (wrong `background-color` on head
capture). Green after the demo fix: `docs/proof/phase1-foundation-harness/green.log`.

## Related (on main)

Structure fail-closed for #670 is covered on `main` (#678 / #670):
`test/phase1-structure-harness.e2e.spec.ts`, structure assertions in
`test/phase1-foundation-harness-lib.ts`, and proof notes in
`docs/proof/phase1-structure-harness/`. CSS-path ACs for #671 remain the primary
close-out here; structure coverage is related and already landed.
