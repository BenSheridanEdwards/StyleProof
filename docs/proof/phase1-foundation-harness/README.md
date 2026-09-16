# Phase 1 foundation harness proof (#669)

Self-attested local evidence for AC1 (TDD red→green) and the privacy-clean report mapping reviewers read.

| File | Purpose |
| --- | --- |
| `red.log` | Playwright harness e2e **before** demo CSS delta — mapping test fails (8/9 pass, exit 1) |
| `green.log` | Same command **after** `?ctaTone=head` fix — full harness e2e pass (9/9, exit 0) |
| `report-excerpt.md` | Privacy-clean `report.md` excerpt naming `background-color` `#14b8a6` → `#dc2626` on `button.btn` / `demo-cta @ 900` |

Screenshots and video: not applicable — proof is automated capture→diff→report output and fail-closed assertions, not a renderer change.
