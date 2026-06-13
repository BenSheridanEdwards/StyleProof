# Contributing to StyleProof

Thanks for helping make a CSS refactor provable. This is a small, focused TypeScript
library plus three CLIs and a composite GitHub Action; contributions that keep it that
way (one job, done well, no native deps) are the easiest to merge.

## Getting set up

```sh
git clone https://github.com/BenSheridanEdwards/styleproof
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

Releases are tag-driven: pushing a `v*` tag runs `.github/workflows/release.yml`, which
builds, typechecks, lints, tests, and runs `npm publish --provenance --access public`
(needs the `NPM_TOKEN` repo secret and `id-token: write`, both already wired), then cuts
a GitHub Release from the CHANGELOG section.

1. Move the `## [Unreleased]` notes into a new version section in `CHANGELOG.md`.
2. `npm version <patch|minor|major>` — bumps `package.json` and creates the `vX.Y.Z` tag.
3. `git push --follow-tags` — the release workflow publishes with provenance.
4. Move the floating major tag so `uses: …@v1` keeps working:
   ```sh
   git tag -f v1 vX.Y.Z && git push -f origin v1
   ```

`dist/` is git-ignored on purpose; it ships via the npm `files` array (built at publish
time), not via git — don't commit it. A manual `npm publish` works too but ships
**without** the provenance attestation, so prefer the tag path.

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
