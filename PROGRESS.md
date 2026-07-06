# Progress

## Active Task: popup reset verification + identity-bound triggers (#183)

## Completed

- `openPopupCandidate` now verifies the between-popups reset (Escape + `go()`)
  against the surface's pristine overlay keys instead of assuming Escape closed
  everything; a leaked overlay skips the candidate loudly (named `styleproof:`
  warning) rather than capturing contaminated state.
- Popup triggers are re-bound by the DOM path recorded at first enumeration
  (same pattern as the forced-state `data-styleproof-state-id` marks), never by
  index into a fresh enumeration; a vanished trigger skips loudly.
- With self-check on, a popup that itself defeats the reset (e.g. a toast) is
  discarded loudly instead of saved unproven or failed with a misleading
  "did not reopen" error.
- Added `test/popup-reset.e2e.spec.ts` (leak skip, trigger-shift binding,
  self-check discard); README + CHANGELOG updated; proof screenshots in
  `docs/proof/popup-reset/`.

## Findings

- Base/navigating surfaces were already safe (navigation resets everything) and
  keep their exact behaviour — the dogfood popup suite passes unchanged, and the
  relocate-by-path step also works across full DOM replacement.
- Under the old code the defects reproduce exactly as issue #183 describes:
  `popup-03` captured with the leaked toast in its overlays, and a shifted
  trigger set keyed Alpha's dialog under `popup-02` (Beta's was never captured).

## Next Action

- Open the PR for issue #183.

## Blockers

- None.

## Verification Status

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  and `npm run privacy:check` pass.
- `npm test` passes (339 tests); full e2e (101 tests) passes including the new
  spec, which fails on the pre-fix code (4 failures).

---

## Active Task: new surfaces require approval

## Completed

- Changed the composite Action so `styleproof-diff` exit `3` (new surfaces with
  no baseline) sets `changed=true`, posts the report, and requires approval in
  review-gate mode.
- Updated report/CLI wording, README, CHANGELOG, approval workflow comments, and
  action dogfood expectations to match the new policy.

## Findings

- `styleproof-diff` remains a pure map comparator: new surfaces still exit `3`
  rather than being counted as computed-style findings.
- Certify mode was already strict because it fails on any report; the gap was
  review-gate mode treating new-surface-only reports as green.

## Next Action

- Open a PR when requested.

## Blockers

- None currently.

## Verification Status

- `npm run build && node --test test/action.test.mjs test/report.test.mjs`
  passed.
- `npm test` passed: 192 Node tests.
- `npm run lint && npm run format:check && npm run privacy:check` passed.

---

## Active Task: variant crawler

## Completed

- Added `harvestStyleVariants` and `styleproof-variants` for one-step state
  discovery from a running app.
- Added browser coverage that replays harvested in-place variants against fresh
  before/after computed-style maps.

## Findings

- The crawler is a manifest generator. Destructive labels, navigation, action
  failures, and live-state candidates remain explicit review outputs.

## Next Action

- Open the PR and merge after GitHub checks pass.

## Blockers

- None currently.

## Verification Status

- `npm run build` passed.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run format:check` passed.
- `npx fallow audit --base HEAD` passed.
- `./node_modules/.bin/playwright test test/variant-crawler.e2e.spec.ts`
  passed.
- `npm test` passed: 181 Node tests.
- `npm run test:e2e` passed: 39 Playwright tests.
- `npm pack --dry-run --json` passed and includes `bin/styleproof-variants.mjs`
  plus `dist/variant-crawler.d.ts` / `dist/variant-crawler.js`.

---

## Active Task: automatic popup and modal capture

## Completed

- PR #111 is on branch `codex/modal-popup-variant-scaffold` for package version
  `3.1.5`.
- Merged current `origin/main` into the branch and resolved conflicts in
  `CHANGELOG.md`, `PROGRESS.md`, and `README.md`.
- Preserved the merged `styleproof-variants` crawler docs/exports alongside this
  PR's component inventory and captured-state coverage docs.
- Implemented enforceable expanded variant coverage, non-live variants that keep
  the base capture, component inventory helpers, semantic overlay metadata, and
  broader default popup selectors for dialogs, menus, listboxes, popovers, and
  toast/status roots.
- Verified the popup e2e fixture asserts `role="dialog"`, `aria-modal`,
  `role="menu"`, `role="listbox"`, and hot-toast/status text are present in the
  saved maps.
- Clarified the README around why a team would use StyleProof: behavior tests
  prove behavior, StyleProof proves the rendered style contract for declared
  UI states and fails missing coverage through `expected`.

## Findings

- The current PR body and committed proof images were too downstream-specific
  for a public library PR and did not plainly explain the goal.
- The right proof is privacy-clean: generic semantic overlay fixtures plus the
  focused e2e assertion that saved computed-style maps contain those overlay
  roots and catch restyles inside them.

## Next Action

- Push the resolved merge branch and let GitHub checks rerun on the merge result.

## Blockers

- None currently.

## Verification Status

- `npm ci` passed after the merge worktree was missing local dependencies.
- `npm run build && npm run typecheck` passed.
- `npm run lint && npm run format:check` passed.
- `npm test` passed: 201 Node tests.
- `npm run test:e2e` passed: 39 Playwright tests.
- `npm run demo:report` regenerated the committed demo report cleanly.
- `npm run privacy:check` passed: 53 public text files scanned.
- `npm pack --dry-run --json` passed for `styleproof@3.1.5` with 42 package
  entries including `dist/components.*`, `dist/variant-crawler.*`, and
  `bin/styleproof-variants.mjs`.
