# Phase 1 foundation harness proof (#669)

Self-attested local evidence for AC1 (TDD red→green) and the privacy-clean report mapping reviewers read.

## Hosted gate (#673)

| Check | Workflow | Posture |
| --- | --- | --- |
| **`Phase 1 mapping (advisory)`** | `.github/workflows/phase1-advisory-dogfood.yml` | Advisory — **not** part of hosted `required`. Soft-pass: **HOLD** — fails closed when mapping is wrong or evidence incomplete. |

Commands the job runs (via `PHASE1_MAPPING_SPECS`):

```bash
npx playwright test test/phase1-foundation-harness.e2e.spec.ts test/phase1-structure-harness.e2e.spec.ts --reporter=line
```

Sibling Phase 1 specs (noop #671, extra harness #672) plug into `PHASE1_MAPPING_SPECS` after they land.

## Local proof artifacts

| File | Purpose |
| --- | --- |
| `red.log` | Playwright harness e2e **before** demo CSS delta — mapping test fails (8/9 pass, exit 1) |
| `green.log` | Same command **after** `?ctaTone=head` fix — full harness e2e pass (9/9, exit 0) |
| `report-excerpt.md` | Privacy-clean `report.md` excerpt naming `background-color` `#14b8a6` → `#dc2626` on `button.btn` / `demo-cta @ 900` |

Screenshots and video: not applicable — proof is automated capture→diff→report output and fail-closed assertions, not a renderer change.
