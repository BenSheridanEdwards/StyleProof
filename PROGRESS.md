# Progress

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

- Created isolated worktree `/Users/agents/Projects/StyleProof-auto-popup-capture`
  on branch `codex/auto-popup-capture`.
- Verified the existing capture runner expands explicit `variants` and
  `liveStates`, but it does not discover visible modal/popup states on its own.
- Confirmed the fix belongs in `src/runner.ts`, where every explicit and crawled
  surface passes through `captureSurface`.
- Added opt-in `popups` capture for declared and crawled surfaces, with popup
  metadata/report labels and deterministic `surface-popup-XX` map names.
- Bumped the package to `3.1.3` and moved the changelog entries into a
  `2026-06-29` release section.

## Findings

- A declared surface only captures the state reached by its `go()` function.
  Existing `variants` can model modal-open states, but the tool currently cannot
  discover those states from visible trigger controls.
- `captureStyleMap` neutralizes hover/focus before reading styles, so automatic
  discovery should target persistent click-open states (dialogs, popovers, menus,
  listboxes, and open data-state overlays). Hover-only states remain explicit
  variants.

## Next Action

- Push the StyleProof branch, open/merge the release PR, confirm npm publishes
  `styleproof@3.1.3`, then bump the consuming project and run its StyleProof
  check.

## Blockers

- None currently.

## Verification Status

- `npm run prepublishOnly` passed on `styleproof@3.1.3`: clean, build,
  typecheck, lint, format check, 180 Node tests, and 38 Playwright e2e tests.
- `npm pack --dry-run --json` passed and produced `styleproof-3.1.3.tgz` with
  35 package entries, including `dist`, `bin`, README, changelog, license, and
  demo image files.
- `npm view styleproof version` reports `3.1.2`; `npm view styleproof@3.1.3`
  reports not published yet.
- `npm whoami` fails with E401 locally, so publication needs the repository
  release workflow and its `NPM_TOKEN` secret.
- Privacy grep over the current worktree found no private consuming-project
  references in changed source/docs/tests.
