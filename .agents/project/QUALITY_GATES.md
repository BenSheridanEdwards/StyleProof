# Quality gates

Every gate that guards this repo: its owner tool, when it runs, and the exact
command. Local hooks live in `.husky/`; CI lives in `.github/workflows/`. A gate
is listed here only if it exists and runs on a clean checkout.

## Gate matrix

| Gate                    | Tool                                                       | When                           | Command / source                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit message          | commitlint (`config-conventional`)                         | commit (`.husky/commit-msg`)   | `npx --no-install commitlint --edit "$1"`                                                                                                                                       |
| Build                   | `tsc`                                                      | commit + CI                    | `npm run build`                                                                                                                                                                 |
| Typecheck               | `tsc --noEmit`                                             | commit                         | `npm run typecheck`                                                                                                                                                             |
| Lint                    | ESLint                                                     | commit + CI (Node 22)          | `npm run lint`                                                                                                                                                                  |
| Format                  | Prettier                                                   | commit + CI (Node 22)          | `npm run format:check`                                                                                                                                                          |
| Privacy scan            | `scripts/privacy-check.mjs`                                | commit (via chain) + CI        | `npm run privacy:check`                                                                                                                                                         |
| Complexity / dead code  | Fallow                                                     | commit + CI                    | `npx fallow audit --base HEAD --health-baseline .fallow/health-baseline.json`; `.github/workflows/fallow.yml`                                                                   |
| Secret scan (staged)    | gitleaks                                                   | commit (`.husky/pre-commit`)   | `gitleaks protect --staged --redact --verbose` (warn-and-skip if absent locally)                                                                                                |
| Secret scan (history)   | `gitleaks/gitleaks-action@v2`                              | CI (PR + push), fail-closed    | `.github/workflows/secret-scan.yml`                                                                                                                                             |
| SAST                    | CodeQL (`javascript-typescript`)                           | CI (PR + push + weekly cron)   | `.github/workflows/codeql.yml`                                                                                                                                                  |
| Dependency audit        | npm audit                                                  | CI (Node 22)                   | `npm audit --audit-level=high`                                                                                                                                                  |
| PR body validation      | `scripts/validate-pr-body.mjs`                             | CI (`pull_request`)            | `.github/workflows/pr-body.yml`                                                                                                                                                 |
| Unit tests              | Node `--test`                                              | push (`.husky/pre-push`) + CI  | `npm test`; CI reuses its prior build via `npm run test:unit`                                                                                                                   |
| E2E                     | Playwright                                                 | CI (parallel Node 22 job)      | `npm run build`; `npx playwright test`; print + upload the determinism oracle receipt                                                                                           |
| CLI smoke               | Node `--test` (package-smoke)                              | CI (macOS + Windows)           | `node --test test/package-smoke.test.mjs`                                                                                                                                       |
| Demo report freshness   | `scripts/demo-report.mjs --check`                          | CI (Node 22)                   | `npm run demo:check`                                                                                                                                                            |
| Action dogfood          | the Action itself, on fixtures                             | CI (`pull_request`)            | `.github/workflows/action-dogfood.yml`                                                                                                                                          |
| Map-store dogfood       | real capture + map store + diff                            | CI (`pull_request`)            | `.github/workflows/store-dogfood.yml`                                                                                                                                           |
| Live StyleProof dogfood | Action on `styleproof.config.ts` surfaces (`example/demo`) | CI (`pull_request`, same-repo) | `.github/workflows/styleproof-dogfood.yml` — advisory (`fail-on-diff: false`); product-state ledger armed (declare-or-fail-closed); **not** part of the hosted `required` check |
| Phase 1 mapping (advisory) | Playwright foundation + structure harnesses (`capture → diff → report`) | CI (`pull_request`) | `.github/workflows/phase1-advisory-dogfood.yml` — job **`Phase 1 mapping (advisory)`**; soft-pass HOLD (fail closed on wrong/incomplete mapping); **not** part of the hosted `required` check |
| Gate-bypass block       | `.claude/hooks/block-gate-bypass.sh`                       | PreToolUse (Claude Code)       | Exits non-zero on `git commit`/`push` with `--no-verify`/`-n`                                                                                                                   |

## Where each gate fires

- **`.husky/commit-msg`** — commitlint.
- **`.husky/pre-commit`** — build, typecheck, lint, format check, Fallow audit,
  gitleaks staged-diff scan.
- **`.husky/pre-push`** — `npm test` (git hook env is unset first so it does not
  leak into the CLI tests' temp repos).
- **CI (`ci.yml`)** — build and unit on the full Node matrix; lint, format,
  privacy, npm audit, and demo freshness on Node 22; complete e2e plus the
  determinism receipt in a parallel Node 22 job; CLI smoke on macOS + Windows;
  one stable `required` check that fails unless all three lanes succeed.
- **CI (dedicated workflows)** — `secret-scan.yml`, `codeql.yml`, `pr-body.yml`,
  `fallow.yml`, `action-dogfood.yml`, `store-dogfood.yml`,
  `styleproof-dogfood.yml` (advisory, not required),
  `phase1-advisory-dogfood.yml` (Phase 1 mapping gate — advisory, not required).
  `.github/workflows/styleproof-approve.yml` is the thin adopter-shaped approve
  caller (`styleproof-approve-reusable.yml@main`). It is not a required check;
  reviewer ticks stay inert until advisory dogfood enables `require-approval`.

## Bypass policy

Gates are never bypassed. `--no-verify`/`-n` is forbidden, and weakening type,
lint, or test configuration to turn red green is a named violation. The
`.claude/hooks/block-gate-bypass.sh` PreToolUse hook blocks the bypass flags at
the agent boundary; CI gates cannot be skipped at all.
