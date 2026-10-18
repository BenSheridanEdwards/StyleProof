# StyleProof quality gates (lean)

North Star for agents: **first-time-green PRs** — do not wait on gates that cannot care about the diff.

## CI path skips

| Lane                                         | Runs when                                                                                      | Skips when                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| build / unit / coverage / lint / privacy     | Always on PR + main                                                                            | —                                     |
| cli-smoke                                    | Always                                                                                         | —                                     |
| e2e shards, e2e evidence, detection corpus   | Any changed file is not in `SAFE_PATHS`                                                        | Every changed file is in `SAFE_PATHS` |
| action / store / styleproof / phase1 dogfood | Same decision                                                                                  | Same decision                         |
| required                                     | Always; accepts skipped browser lanes only when the path filter succeeded with `e2e` = `false` | —                                     |

`SAFE_PATHS` in `scripts/ci-path-filters.mjs` is the only list. It is fail-closed:
an unlisted path (new directory, workflow, `bin/`, `src/`, config, lockfile)
runs every lane. Each workflow embeds the same dorny filter (`'**'` plus one
negation per safe path, `predicate-quantifier: every`), and
`test/ci-path-filters.test.mjs` fails when a copy drifts. `src/**` is never safe:
`bin/styleproof.mjs` spawns every CLI by computed name, so the e2e lane can reach
all of `src/`.

## Local hooks

| Hook       | What                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| pre-commit | lint, format:check, optional gitleaks staged, fallow on staged — **no full build** (CI covers build/typecheck) |
| commit-msg | commitlint                                                                                                     |
| pre-push   | `npm test` + path-filtered Playwright e2e (`scripts/pre-push-e2e.mjs`)                                         |

## Pattern reference

Cross-repo model: a shared `gates.config`-style map of path globs → required lanes, plus a docs-only fast path on pre-push when the staged diff is documentation-only.

## Shared PR body (eight-section)

Canonical headings live in `scripts/eight-section-pr-body.mjs`. After the show-me
template PR merges, `scripts/validate-pr-body.mjs` should require the same list.
Other repos can call `.github/workflows/pr-body-reusable.yml` once they vendor
or share the validator, or keep a synced copy of the eight headings.
