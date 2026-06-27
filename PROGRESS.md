# Progress

## Completed

- Confirmed the v3 Action failure comes from running checked-out `bin/styleproof-*`
  files without a built `dist/` directory in the action checkout.
- Bumped the package to `3.0.2` for a patch release.
- Updated the composite Action runtime install step to use dev dependencies with
  scripts disabled, then run `npm run build`.
- Added a regression test for the Action runtime install contract.

## Findings

- `dist/` is intentionally ignored by git, so the composite Action must build the
  checked-out source before invoking local entrypoints.

## Next Action

- Push the branch, open the PR, and wait for CI before merging/releasing.

## Blockers

- None currently.

## Verification Status

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  passed.
- `npm test` passed: 161 tests.
- `npm run test:e2e` passed: 30 tests.
- `npm pack --dry-run --json` passed and included `dist`, `bin`, README,
  changelog, license, and docs.
- Clean action-checkout smoke passed with `dist/` absent before install.
- `npx fallow audit --base origin/main --format compact` passed.
