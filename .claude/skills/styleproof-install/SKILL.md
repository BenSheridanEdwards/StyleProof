---
name: styleproof-install
description: Use when adding StyleProof to a project for the first time — install the package and run styleproof-init to scaffold the capture spec, a dedicated production-build Playwright config, and the cache-first CI report workflow.
---

# StyleProof — install & scaffold

One job: get StyleProof installed and `styleproof-init` run, so the repo has the
capture spec, config, and CI workflow that every other step builds on.

## Steps

```bash
npm install -D styleproof @playwright/test
npx playwright install chromium   # forced :hover/:focus/:active states are Chromium-only
npx styleproof-init
```

Requires **Node ≥ 18** (ESM) and **@playwright/test ≥ 1.40** (peer dep).

`styleproof-init` scaffolds, non-destructively (it sits beside your existing
Playwright config, never edits it):

- **`e2e/styleproof.spec.ts`** — the capture spec, with the inventory guard
  (`inventory: true`) on. A **Next.js** repo gets its App-Router + Pages-Router
  routes _and_ the `expected` coverage guard wired via `discoverNextRoutes()`;
  any other repo gets a **crawl-by-default** spec (`defineCrawlCapture` from
  `/`) that discovers surfaces from the rendered nav — either way it's
  protected out of the box.
- **`playwright.styleproof.config.ts`** — a dedicated config that **builds and
  serves a production build** (never a flaky dev server — dev's per-route JIT
  compile under CI load is what makes captures race late content), scopes
  discovery to the StyleProof spec, and captures in parallel (`fullyParallel`).
- **`styleproof.config.ts`** — typed config with `blocking: 'advisory'` and
  `requireApproval: true` defaults, using `defineConfig()` for IDE support.
- **`.gitignore`** entries for `.styleproof/`, `test-results/`, `playwright-report/`.
- a **cache-first CI workflow** (`styleproof.yml`) that restores maps from the
  `styleproof-maps` branch and reports without a browser when both maps already
  exist; includes on-close prune for both map and report branches plus a daily
  report sweep.
- **`styleproof-report.yml`** — the `workflow_run` reporter that downloads
  capture artifacts and runs the Action with write permissions.
- **`styleproof-approve.yml`** — a thin caller workflow that invokes the
  upstream reusable approval workflow, so logic updates ship with releases.
- **`styleproof-lint-artifacts.yml`** — a belt-and-suspenders guard that fails
  the PR if map artifacts (`.json.gz`, `styleproof-manifest.json`) are
  accidentally committed to a PR branch — mirrors the `.gitignore` patterns.

Generated commands follow the repo's lockfile (`bun`/`pnpm`/`yarn`/npm), respect
Corepack pins, and detect Vite/Next preview commands — it won't assume `npm start`
exists.

## Gotcha

The spec is **inert until `STYLEMAP_DIR` is set** — it only captures when a run
labels an output dir, so it's safe to leave beside your other specs. Nothing
under `.styleproof/` belongs in a PR branch; the map store is a separate branch.

## Next

`styleproof-surfaces` (declare what to certify) → `styleproof-baseline` (publish
the base maps) → `styleproof-ci-gate` (wire the PR gate). The whole arc is the
`styleproof` skill.
