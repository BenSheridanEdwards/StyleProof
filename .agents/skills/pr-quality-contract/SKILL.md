---
name: pr-quality-contract
description: Use before completing work or opening a PR in this repository.
---

# PR Quality Contract

## Steps

1. Read `.agents/project/DEFINITION_OF_DONE.md` before implementation starts. Completion criterion: the PR scope, required proof, and verification commands are known before coding.
2. Map behaviour changes to tests. Completion criterion: every user-visible behaviour changed by the PR has an automated behaviour/E2E test (or an exported-function unit test for pure logic), or an explicit technical reason it cannot be automated.
3. Produce behavioural proof for UI changes. Completion criterion: the PR contains current video and screenshots from the changed branch, or states `Not applicable` with the reason.
4. Run verification on the final branch. Completion criterion: `npm run build && npm run typecheck && npm run lint && npm run format:check`, `npm run privacy:check`, `npm test`, and `npm run test:e2e` (when the capture/diff/report/engine path changed) have been run after the last code change.
5. Write the PR body using `.github/PULL_REQUEST_TEMPLATE.md` exactly. Completion criterion: the PR body contains, in order, `Why does this feature exist?`, `What changed?`, `Behavioural Proof (with video and screenshots)`, and `Verification Summary`. Confirm with `node scripts/validate-pr-body.mjs` against the fetched title and body.
6. Do not mark work complete with placeholders. Completion criterion: every proof link, screenshot path, video path, test command, failure, skipped check, and residual risk is explicit.

## Evidence Rules

- Test claims require command output.
- UI behaviour claims require screenshots or video from the branch under review.
- E2E claims require named scenarios and their pass/fail result.
- Capture/diff/report claims require a privacy-clean generated report excerpt.
- Skipped proof requires a technical reason, not convenience.
- Existing unrelated failures must be separated from failures introduced by the PR.
