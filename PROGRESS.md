# Progress

## Completed

- Rebasing PR #88 onto current `main`, which now includes the v3.1.0 release
  stack and follow-up release/action fixes.
- Preserved the v3.1.0 defaults from `main`: stacked-PR base inference,
  recovery-first CLI errors, no-arg report defaults, and clean-run PR comments.
- Preserved the PR #88 burden-shift changes:
  - `captureStyleMap` parks the real cursor over an ignored hover sink before
    reading the resting map.
  - `styleproof-map` removes HAR files after successful committed-map capture by
    default, with `--keep-har` / `STYLEPROOF_KEEP_HAR=1` for explicit replay
    workflows.
  - `styleproof-init` generated hooks run a semantic diff against `HEAD`, restore
    unchanged maps, and print a live-state/replay hint when maps really change.
- Moved the PR #88 CHANGELOG entries back under `[Unreleased]`, because v3.1.0
  is already released on current `main`.

## Findings

- The merge conflicts were real and expected: the PR touched README, CHANGELOG,
  init tests, and generated-hook docs that were also changed by the v3.1.0 stack.
- The implementation conflict was low-risk: source changes in `src/capture.ts`,
  `bin/styleproof-map.mjs`, and `bin/styleproof-init.mjs` applied cleanly.

## Next Action

- Force-push the rebased PR branch, then wait for CI/Fallow on PR #88.

## Blockers

- None currently.

## Verification Status

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  passed on the rebased `styleproof@3.1.0` tree.
- `npm test` passed: 181 tests.
- `npm run test:e2e` passed: 33 browser tests.
- `npm pack --dry-run --json` passed with 35 package entries, including
  `dist/cli-base-ref.*`, `dist/cli-errors.*`, `dist`, `bin`, README,
  changelog, license, and docs.
- Privacy grep passed with no private consuming-project names or paths.
