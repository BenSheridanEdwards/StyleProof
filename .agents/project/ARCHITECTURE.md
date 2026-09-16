# Architecture

StyleProof is a TypeScript library (`src/`) compiled to ESM (`dist/`), a set of
CLI entrypoints (`bin/`), and a GitHub Action (`action.yml`). The public API is
re-exported from `src/index.ts`.

## The pipeline

The tool runs one direction: **capture → store → diff → report**. Each stage has
one entry module at the top of `src/` that re-exports its public surface, and a
folder of the same name that holds the implementation.

1. **Capture** (`capture.ts` → `capture/`) — `capture/browser.ts` holds every
   function that runs inside the page (serialized to Playwright/CDP, so it must
   stay self-contained); `capture/forced-states.ts` drives the CDP forced-state
   layers; `capture/map-io.ts` reads and writes `StyleMap` files;
   `capture/network.ts` tracks in-flight requests and data residue;
   `capture/recipe-policy.ts` is the state-recipe privacy policy;
   `capture/url-glob.ts` and `capture/shared.ts` are small helpers.
   `capture-url.ts` is the spec-less one-shot capture.
2. **Spec runner** (`runner.ts` → `runner/`) — the `defineStyleMapCapture` /
   `defineCrawlCapture` API: `runner/settings.ts` (env + option resolution),
   `runner/variants.ts` (surface × variant expansion), `runner/self-check.ts`
   (determinism self-check and failure tolerance), `runner/popups.ts`,
   `runner/surface-capture.ts`, `runner/crawl-capture.ts`, and
   `runner/browser.ts` (in-page snapshot functions). `state-recipes.ts`
   parses and executes declarative state recipes.
3. **Discover / crawl** (`crawl-surfaces.ts` → `crawl/`) — `crawl/browser.ts`
   (in-page discovery), `crawl/page.ts` (navigation, setup steps, settle,
   capture-in-place), `crawl/sweep.ts` (the breadth-first sweep and worker
   pool), `crawl/report.ts` (pure aggregation the capture CLI prints),
   `crawl/types.ts`. `crawl.ts` selects links, `routes.ts` discovers Next.js
   routes, `components.ts` + `component-manifest.ts` handle component
   catalogs, `variant-crawler.ts` harvests open states, `breakpoints.ts`
   detects viewport widths, `auth-boundary.ts` / `incomplete-ui.ts` /
   `crawl-confidence.ts` / `confidence-ledger.ts` classify what the crawl
   could not reach.
4. **Store** (`map-store.ts` → `map-store/`) — `map-store/bundle.ts` (bundle
   file names, evidence digest, failure ledger), `map-store/manifest.ts`
   (compatibility key, manifest build/validate), `map-store/git-transport.ts`
   (auth headers, retries, sparse checkout), `map-store/store.ts` (publish,
   restore, list, cached capture dirs), `map-store/source-binding.ts`,
   `map-store/receipts.ts` (baseline-failure receipts and the Action's
   comment/status formatters), `map-store/json.ts`. `inventory.ts`,
   `data-residue.ts`, `legacy-pairs.ts`, `critical-obligations.ts` read the
   acknowledgement ledgers through `ack-ledger.ts`.
5. **Diff** (`diff.ts`, `findings-clean.ts`, `change-groups.ts`,
   `change-chrome.ts`, `path-correspondence.ts`, `comparability-status.ts`,
   `canonicalize.ts`, `describe.ts`, `prop-summary.ts`, `pixel-diff.ts`) —
   compares a base directory against a head directory into `Finding`s;
   `coverage.ts` enforces the coverage guard; `verdict.ts` turns the evidence
   into the single certification verdict the CLI, Action, and comment share.
6. **Report** (`report.ts` → `report/`) — `report/headline.ts`,
   `report/certification.ts`, `report/regions.ts`, `report/crop-pair.ts`,
   `report/png.ts`, `report/markdown.ts`, `report/content-layer.ts`,
   `report/migration-gallery.ts`, `report/sections.ts`, `report/geometry.ts`,
   `report/annotation-paths.ts`, `report/shared.ts`. Output must stay
   byte-identical to `docs/demo/` (`npm run demo:report -- --check`).

Configuration lives in `config.ts` → `config/` (`schema.ts` is the table-driven
validator, `load.ts` / `load-ts.ts` discover and evaluate the file, `spec.ts`
resolves the capture spec path). Shared helpers: `util.ts` (pure),
`node-util.ts` (git spawn, hashing, retried removal), `github-git-data.ts`
(the GitHub git-data client used by the branch-maintenance commands),
`safe-filesystem.ts`, `ci.ts` / `ci-worktree.ts` / `ci-spec-ref.ts` /
`ancestor-baseline.ts` / `gitref.ts` (CI glue), `action-context.ts` +
`report-delivery.ts` + `comment-supersession.ts` (Action glue).

## Entrypoints

- **Library:** `src/index.ts` → `dist/index.js` (`main`/`types` in package.json).
- **CLIs** (`bin/*.mjs`): `styleproof` dispatches to the `styleproof-*`
  commands. Every command declares its flags through `bin/cli.mjs`;
  `styleproof-diff` and `styleproof-report` share `bin/compare.mjs`;
  `styleproof-ci` and `styleproof-prepush` share `bin/ci-shared.mjs`;
  `styleproof-init` keeps its generated files in `bin/init/templates.mjs`
  and its safe writes / hook activation in `bin/init/files.mjs` and
  `bin/init/hooks.mjs`.
- **Action:** `action.yml` composes the CLIs into a PR gate that posts a report
  comment and can fail on diff or unacknowledged removals.

## Scripts

- `scripts/demo-report.mjs` — regenerates the live demo report under `docs/demo/`
  from deterministic synthetic inputs (`--check` verifies freshness in CI).
- `scripts/privacy-check.mjs` — scans public/published text files for private
  paths, URLs, and denylisted tokens.
- `scripts/action-dogfood-fixtures.mjs` — builds fixtures the action-dogfood
  workflow runs the Action against.
- `scripts/validate-pr-body.mjs` — machine-validates the PR title and body shape.

## Tests

`test/*.test.mjs` are Node built-in test-runner unit tests against `dist/`;
`test/*.e2e.spec.ts` are Playwright specs (the one place the real browser capture
path runs). `test/fixtures/` holds input trees.
