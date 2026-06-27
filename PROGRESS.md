# Progress

## Completed

- Started the StyleProof `3.1.1` release bump after PR #88 and PR #94 merged
  into `main`.
- Bumped `package.json` and `package-lock.json` from `3.1.0` to `3.1.1`.
- Moved the current `[Unreleased]` changelog entries into
  `## [3.1.1] - 2026-06-27` and updated compare links.
- PR #95 merged into `main`; the release rerun published `styleproof@3.1.1`,
  created the `v3.1.1` GitHub Release, and moved the `v3` tag.
- Started a release-hardening fix after the GitHub Packages mirror failed.

## Findings

- The first release run did publish `styleproof@3.1.1`, but failed immediately
  after publish because npm registry propagation briefly returned 404 during the
  verification step.
- Rerunning the release job completed npm verification, `v3.1.1`, GitHub
  Release creation, and moving the `v3` tag.
- The GitHub Packages mirror failed because it rewrites `package.json` to the
  scoped mirror name and then `npm publish` reruns `prepublishOnly`; the package
  smoke test correctly imports unscoped `styleproof`, which cannot resolve after
  the temporary scope rename.

## Next Action

- Open and merge the workflow-hardening PR, then rerun the GitHub Packages
  mirror for `3.1.1`.

## Blockers

- None currently.

## Verification Status

- `npm run prepublishOnly` passed on `styleproof@3.1.1`, including clean,
  build, typecheck, lint, format check, 182 unit tests, and 33 browser e2e
  tests.
- `npm pack --dry-run --json` passed and produced `styleproof-3.1.1.tgz` with
  35 package entries, including `dist`, `bin`, README, changelog, license, and
  docs.
- `npm view styleproof version` now reports `3.1.1`.
- `git ls-remote --tags origin 'v3.1.1' 'v3'` shows both tags at
  `4a3db7a4f7a2b3c31db893828419f7a1f80ee78b`.
- `gh release view v3.1.1` shows a published, non-draft GitHub Release.
- Failed GitHub Packages log isolated the mirror failure to
  `ERR_MODULE_NOT_FOUND: Cannot find package 'styleproof'` inside
  `test/package-smoke.test.mjs` after the mirror workflow temporarily scoped the
  package name.
- Privacy grep over the changed files found no private consuming-project
  references.
