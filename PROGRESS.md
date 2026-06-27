# Progress

## Completed

- Confirmed PR #82 (`improve/cli-three-command-contract`) is open and green on
  GitHub CI/Fallow.
- Added shared base-ref inference in `src/gitref.ts` so CLI entrypoints do not
  duplicate the local/GitHub base selection logic.
- Updated `styleproof-report` to mirror `styleproof-diff`: no args infer the
  base and compare against `stylemaps/current`; a single arg pins the base ref;
  `--base-ref` can omit `mapsDir`; `--maps-dir` customizes the committed-map dir.
- Added CLI regression tests for no-arg report defaults, single-base-ref report,
  and omitted-`mapsDir` `--base-ref`.
- Fixed the CLI/e2e test helpers so temp git repos do not inherit GitHub
  Actions' ambient `GITHUB_BASE_REF`, which made stacked PR CI infer the outer
  PR base branch instead of the fixture's local `main`.
- Updated README and CHANGELOG for the report CLI defaults.
- Generated privacy-clean report proof and copied the visible crop to
  `docs/proof/report-defaults-crop.png`.
- Added stacked-PR base inference: after `GITHUB_BASE_REF` and explicit
  `branch.<name>.gh-merge-base`, no-arg diff/report ask `gh pr view` for the
  current PR base before falling back to main/master.
- Added a fake-`gh` CLI regression proving a branch stacked on `stack-base` uses
  that PR base instead of incorrectly diffing against `main`.

## Findings

- The repo had no existing committed proof-artifact convention, but the PR
  template requires proof in the body and the user requested screenshots. The
  proof crop is kept outside the package `files` list; `npm pack --dry-run`
  still includes only `docs/demo-composite.png` from `docs/`.

## Next Action

- Commit and open the stacked-PR base inference PR, stacked on PR #83.
- Continue with a separate PR for recovery-first CLI error messages.

## Blockers

- None currently.

## Verification Status

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  passed.
- `node --test test/cli.test.mjs` passed: 36 tests.
- `npm test` passed: 177 tests.
- `npm run test:e2e` passed: 32 tests.
- `npm pack --dry-run --json` passed with 31 package entries; proof crop is not
  packed.
