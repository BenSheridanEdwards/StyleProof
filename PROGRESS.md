# Progress

## Completed: truthful annotations after structural path churn

## Completed

- Confirmed the issue on a clean `origin/main` checkout at StyleProof 4.0.2.
- Traced misleading annotation boxes to positional `:nth-child()` path churn.
- Chosen annotation-only reconciliation so certification findings remain exhaustive.
- Restricted reconciliation to unambiguous one-to-one moves so duplicate siblings
  keep truthful addition, removal, and restyle annotations.

## Findings

- An inserted unkeyed sibling can renumber unchanged descendants.
- The clean composite remains truthful, but the annotated twin boxes path churn as if every element visibly changed.
- Exact-equivalent entries can be reconciled across paths for annotation without changing the diff gate.

## Verification Status

- Verification is recorded in the pull request for the final branch.

---

## Active Task: fact-check the Claude Code skills + README against current reality

## Completed

- Extracted ground truth (bin/\*.mjs flags/exit codes, `src/index.ts` exports,
  `action.yml` inputs/outputs, CHANGELOG 3.9→3.19) and diffed it against the ten
  `.claude/skills/styleproof*` skills and the README.
- Skills: removed dead cross-references (`design-to-production`,
  `styleproof-refactor`); replaced a non-generic `hud/` path with a generic one;
  fixed the `--key` default (`page`); documented the ledger-era gate contract in
  `styleproof-diff` (exit 1 also blocks on inventory removal / incomplete
  coverage / unproven determinism; exit 2 on a missing-empty map;
  `--json <file>`); added the crawl `expected`/`exclude` guard and the inventory
  guard to `styleproof-surfaces`; the browser-build compatibility key to
  `styleproof-baseline`; `--until-covered` + gate verdicts to
  `styleproof-coverage`; report exit codes + gates-first lead to
  `styleproof-report`; the crawl-by-default scaffold to `styleproof-install`;
  `report-branch` pruning + the inventory gate to `styleproof-ci-gate`; a
  selective-remap pointer to `styleproof-prepush`.
- README: new "What a green certifies" section (coverage / determinism /
  inventory verdicts, linking `docs/what-it-catches.md` and
  `docs/inventory-guard.md`); `styleproof-capture` added to the CLI reference;
  `gateInventoryRemovals` in the policy table; `--until-covered` in the crawl
  section; layout-equivalent-margin wording updated for the #187 fix.
  CHANGELOG `[Unreleased]` Docs entry added.

## Findings

- The skills were last touched at #144/#152 and predated the coverage (3.9),
  determinism (3.10), inventory (3.12–3.14), crawl-guard (3.18), and
  selective-remap (3.19) work; the README was PR-current except for the
  inventory/verdict story, the missing `styleproof-capture` CLI entry, and #187.

## Next Action

- None — docs-only change awaiting review.

## Blockers

- None.

## Verification Status

- `npm run format:check` passes (README prettier-reformatted).
- Stale-reference grep (`design-to-production|styleproof-refactor|hud/`) over
  skills + README: clean. Privacy grep of the diff: clean.

---

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
