# Architecture

StyleProof is a TypeScript library (`src/`) compiled to ESM (`dist/`), a set of
CLI entrypoints (`bin/`), and a GitHub Action (`action.yml`). The public API is
re-exported from `src/index.ts`.

## The pipeline

The tool runs one direction: **capture → store → diff → report**.

1. **Capture** (`capture.ts`, `capture-url.ts`) — opens a surface in a real
   browser (Playwright/CDP) and records the browser's computed styles for every
   captured element into a `StyleMap` (JSON), per breakpoint width.
2. **Discover / crawl** — surfaces can be listed by hand or discovered:
   `routes.ts` (`discoverNextRoutes`), `crawl.ts` + `crawl-surfaces.ts` (link
   crawling), `components.ts` (component catalogs), `variant-crawler.ts` (open
   states / variants).
3. **Store** (`map-store.ts`, `inventory.ts`) — style maps are written to a
   directory keyed by surface and width; the inventory tracks what exists.
4. **Diff** (`diff.ts`, `change-groups.ts`, `affected-surfaces.ts`,
   `canonicalize.ts`) — compares a base directory against a head directory and
   produces `Finding`s grouped into changes; `coverage.ts` enforces the coverage
   guard (a registered-but-uncaptured surface fails).
5. **Report** (`report.ts`, `describe.ts`, `png-util.ts`) — renders the Markdown
   report with screenshots that a reviewer reads on the PR.

Supporting modules: `runner.ts` (the `defineStyleMapCapture` / `defineCrawlCapture`
spec API), `breakpoints.ts` (viewport width detection), `action-context.ts` +
`danger.ts` + `gitref.ts` (Action/CI glue), `cli-errors.ts` (`UsageError`).

## Entrypoints

- **Library:** `src/index.ts` → `dist/index.js` (`main`/`types` in package.json).
- **CLIs** (`bin/*.mjs`): `styleproof-init`, `styleproof-map`,
  `styleproof-capture`, `styleproof-diff`, `styleproof-report`,
  `styleproof-variants`.
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
