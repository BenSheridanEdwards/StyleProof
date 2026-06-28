# Progress

## Active Task: local-first StyleProof map cache

## Completed

- Pulled latest `main` and branched `codex/local-first-styleproof-cache`.
- Verified the current default is the source of the conflict class: `styleproof-map`
  writes `stylemaps/current`, `styleproof-init` generates a pre-push hook that
  commits/pushes `stylemaps`, and generated CI diffs committed maps from git.
- Replaced the default with local-first map bundles under `.styleproof/maps`,
  manifest compatibility keys, a `styleproof-maps` branch store, cache restore
  for `styleproof-diff` / `styleproof-report`, and a generated cache-first CI
  workflow with a two-sided capture fallback.
- Removed generated pre-push hook activation and added `.styleproof/`,
  `test-results/`, and `playwright-report/` ignore scaffolding.
- Removed the old committed-map `--base-ref` / `--maps-dir` compatibility path
  from the v3 CLI and Action surface so generated maps no longer have a supported
  route into PR branch history.
- Narrowed manifest compare checks to the runtime environment; the stricter
  compatibility key still selects cache bundles, but spec/lockfile changes can
  recapture both sides in CI and compare normally.
- Updated README, CHANGELOG, and tests for the new v3 default.

## Findings

- The committed-map default solves CI time by putting generated binary state in
  normal branch history. That is not the right default for v3 because branches
  naturally collide on the same generated paths.
- The next default should be local-first reusable bundles: `styleproof-map`
  builds maps outside git history, CI restores/downloads those bundles, and CI
  captures only when the bundle is missing or incompatible.
- Local map builds can happen outside CI when the local capture environment
  matches the CI compatibility key. If not, the generated workflow recaptures
  both sides in CI rather than comparing unlike maps.
- The cache key must stay stricter than the compare check. A PR that changes the
  StyleProof spec or dependencies may legitimately invalidate cached bundles and
  fall back to CI capture, but that recaptured pair should still compare.

## Next Action

- Commit, push, and open the PR with the proof below.

## Blockers

- None currently.

## Verification Status

- `npm run prepublishOnly` passed: clean, build, typecheck, lint, format check,
  178 Node tests, and 35 Playwright e2e tests.
- `npm pack --dry-run --json` passed and produced `styleproof-3.1.2.tgz` with
  35 package entries, including `dist/map-store.d.ts` / `dist/map-store.js` and
  no `dist/cli-base-ref.*` files.
- Privacy grep over the worktree found no private consuming-project references.

---

## Previous Task: 3.1.1 release follow-up

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
