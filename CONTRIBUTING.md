# Contributing to StyleProof

Thanks for helping make a CSS refactor provable. This is a small, focused TypeScript
library plus three CLIs and a composite GitHub Action; contributions that keep it that
way (one job, done well, no native deps) are the easiest to merge.

## Getting set up

```sh
git clone https://github.com/BenSheridanEdwards/StyleProof
cd styleproof
npm install                 # also runs `npm run build` via the `prepare` script
npx playwright install chromium   # for the smoke e2e
```

Node 18+ is required. The only runtime dependency is `pngjs` (pure JS); dev deps are
`@playwright/test`, `typescript`, the `eslint` + `typescript-eslint` + `globals` stack,
and `prettier`.

## Project layout

```
src/
  capture.ts   captureStyleMap / saveStyleMap / loadStyleMap + the browser-side walk
  runner.ts    defineStyleMapCapture (generates one Playwright test per surface × width)
  diff.ts      diffStyleMaps / diffStyleMapDirs / findingLabel + the Finding types
  report.ts    generateStyleMapReport + summarizeProps / prettyLabel
  index.ts     the public surface — everything users import
bin/
  styleproof-init.mjs     scaffold a capture spec into a project
  styleproof-diff.mjs     CLI over diff.ts (imports the built dist/)
  styleproof-report.mjs   CLI over report.ts (imports the built dist/)
test/
  *.test.mjs            node:test unit suite (diff, report, CLI)
  smoke.e2e.spec.ts     Playwright smoke against a file:// fixture (the only browser test)
action.yml     composite GitHub Action (diff → orphan-branch report → PR comment)
example/       a runnable capture spec you can point at any production build
docs/          the demo composite image used in the README
```

`src/index.ts` is the contract: anything not exported there is internal. Three functions
in `capture.ts` (`capturePage`, `snapSubtree`, `pathsForSelector`) are serialized into
the browser by `page.evaluate`, so they **cannot reference module-scope helpers** —
keep them self-contained.

## Build, run, and verify

Everything CI runs, locally:

```sh
npm run build         # tsc → dist/  (the bins import dist/, so build first)
npm run typecheck     # tsc --noEmit, strict
npm run lint          # eslint .
npm run format:check  # prettier --check  (use `npm run format` to fix)
npm test              # builds, then node --test over test/*.test.mjs (fast, no browser)
npm run test:e2e      # Playwright smoke: the page.evaluate + CDP capture path
```

The unit suite imports the **built `dist/`** (the same surface the bins and consumers
use), so a stale build can't yield a false green — `npm test` rebuilds first. Add or
update tests for any behaviour you change. The smoke e2e is the only coverage of the
browser-evaluated capture functions; run it when you touch `src/capture.ts`.

You can also **dogfood** the tool against a real production build, which is the fastest
way to see a change end to end:

```sh
BASE_URL=http://localhost:3000 STYLEMAP_DIR=before npx playwright test example/
# ...make a deliberate CSS change in the target site, rebuild it...
BASE_URL=http://localhost:3000 STYLEMAP_DIR=after  npx playwright test example/
npx styleproof-diff __stylemaps__/before __stylemaps__/after
```

When dogfooding the full consumer flow (`styleproof-init` → `styleproof-map`) in a
scratch project, install the repo as a **tarball**, not a path: `npm install
$(npm pack --pack-destination /tmp /path/to/StyleProof | tail -1)`. A path install
symlinks `node_modules/styleproof` to the repo, and in a CommonJS consumer
Playwright's transpiler then treats the linked ESM `dist/` as project code —
`styleproof-map` dies with a misleading `Cannot use 'import.meta' outside a module`
/ "No tests found". Registry and tarball installs are unaffected.

## Pull request norms

- **One concern per PR.** Keep diffs small and reviewable.
- **No new runtime dependencies** without discussion — "pure JS, no native build, CI
  anywhere" is a feature. `pngjs` is the only one.
- **All gates pass:** `build`, `typecheck`, `lint`, `format:check`, `test`, and
  `test:e2e` if you touched the capture/engine path.
- **Public API changes** (anything exported from `src/index.ts`, any CLI flag, any
  Action input/output) update the README's API/CLI/Action tables and the CHANGELOG.
- **Browser-evaluated code** (`capturePage`, `snapSubtree`, `pathsForSelector`) stays
  self-contained and dependency-free; cover it with the smoke e2e.
- **Keep the certification differ exact.** `styleproof-diff` must never gain a tolerance;
  the report may filter noise, the differ may not.
- Add a CHANGELOG entry under `## [Unreleased]` (Added/Changed/Fixed).

## Release process

Releases publish **on merge to main**, driven by the version in `package.json`.
`.github/workflows/release.yml` runs on every push to main: if there is no `vX.Y.Z`
tag for the current version (i.e. the merge bumped it), it builds, typechecks, lints,
tests, publishes to npm, tags the commit, cuts a GitHub Release from the CHANGELOG
section, **moves the floating major tag** (`v1`) so consumers pinning
`uses: …/styleproof@v1` always get the latest 1.x, and mirrors to GitHub Packages. A
merge that does not bump the version is a clean no-op.

So a release is just a version bump in a normal PR:

1. Move the `## [Unreleased]` notes into a new version section in `CHANGELOG.md`.
2. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` only
   (the workflow creates the tag, not you).
3. Open the PR, get it green, and merge. Merging publishes.

The publish step is **idempotent and token-aware**: it skips when that version is already
on npm or when the `NPM_TOKEN` secret is not set. Until you add `NPM_TOKEN`, the workflow
still tags, cuts the Release, and moves `v1`, and you publish with a manual
`npm publish --access public` (no provenance); add an **Automation** `NPM_TOKEN` secret to
publish automatically with provenance. You no longer create the tag or move the major tag
by hand.

`dist/` is git-ignored on purpose; it ships via the npm `files` array (built at publish
time), not via git — don't commit it. A manual `npm publish` works too but ships
**without** the provenance attestation, so prefer the merge path.

Semver: a change to captured/serialized map structure, an exported type, a CLI flag, or
an Action input is at least a minor; anything that would make an existing committed
baseline diff against an unchanged page is a major (it forces every consumer to
regenerate baselines).

## Reporting bugs

Open an issue with: the tool version, the surface `go` function (minimised), the output
of `styleproof-diff`, and whether captures were against a production build. A false
positive is best reported as the two `.json.gz` maps that shouldn't differ, or a minimal
HTML fixture.

## License

By contributing you agree your contributions are licensed under the project's MIT
license.
