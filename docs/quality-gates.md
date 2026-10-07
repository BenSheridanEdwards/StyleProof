# StyleProof quality gates (lean)

North Star for agents: **first-time-green PRs** — do not wait on gates that cannot care about the diff.

## CI path skips

| Lane | Runs when | Skips when |
|---|---|---|
| build / unit / coverage / lint / privacy | Always on PR + main | — |
| cli-smoke | Always | — |
| e2e shards + detection corpus | `E2E_PATH_GLOBS` in `scripts/ci-path-filters.mjs` | docs-only, changelog-only, pure `test/*.test.mjs` |
| styleproof / action / store / phase1 dogfood | `DOGFOOD_PATH_GLOBS` (workflow `paths:`) | same as above |
| required | Always; treats skipped browser lanes as success | — |

Shared globs live in `scripts/ci-path-filters.mjs` (mirrors `scripts/pre-push-e2e.mjs` for capture/diff/report/runner).

## Local hooks

| Hook | What |
|---|---|
| pre-commit | lint, format:check, optional gitleaks staged, fallow on staged — **no full build** (CI covers build/typecheck) |
| commit-msg | commitlint |
| pre-push | `npm test` + path-filtered Playwright e2e (`scripts/pre-push-e2e.mjs`) |

## Pattern reference

Fleet’s `gates.config.mjs` is the cross-repo model for path-scoped gates. CursorHalo’s `scripts/prepush-docs-only.sh` is the docs-only fast path model.

## Shared PR body (eight-section)

Canonical headings live in `scripts/eight-section-pr-body.mjs`. After the show-me
template PR merges, `scripts/validate-pr-body.mjs` should require the same list.
Other repos can call `.github/workflows/pr-body-reusable.yml` once they vendor
or share the validator, or keep a synced copy of the eight headings.
