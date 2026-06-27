# Progress

## Completed

- Started the StyleProof `3.1.1` release bump after PR #88 and PR #94 merged
  into `main`.
- Bumped `package.json` and `package-lock.json` from `3.1.0` to `3.1.1`.
- Moved the current `[Unreleased]` changelog entries into
  `## [3.1.1] - 2026-06-27` and updated compare links.

## Findings

- npm still reports `styleproof@3.1.0`, so the merged default hardening and
  generated-hook cleanup are not installable from npm until this version bump is
  merged and the release workflow publishes `3.1.1`.
- The release workflow uses the package version as the release signal and will
  build, test, publish to npm, tag `v3.1.1`, create the GitHub Release, and move
  the `v3` alias after merge.

## Next Action

- Commit, push, and open the release PR.

## Blockers

- None currently.

## Verification Status

- `npm run prepublishOnly` passed on `styleproof@3.1.1`, including clean,
  build, typecheck, lint, format check, 182 unit tests, and 33 browser e2e
  tests.
- `npm pack --dry-run --json` passed and produced `styleproof-3.1.1.tgz` with
  35 package entries, including `dist`, `bin`, README, changelog, license, and
  docs.
- `npm view styleproof version` still reports `3.1.0`.
- `npm view styleproof@3.1.1 version` returns 404, confirming `3.1.1` has not
  already been published.
- `git tag --list 'v3.1.1'` returned no local tag.
- Privacy grep over the changed files found no private consuming-project
  references.
