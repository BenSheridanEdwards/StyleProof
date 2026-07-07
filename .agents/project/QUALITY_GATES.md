# Quality gates

Every gate that guards this repo: its owner tool, when it runs, and the exact
command. Local hooks live in `.husky/`; CI lives in `.github/workflows/`. A gate
is listed here only if it exists and runs on a clean checkout.

## Gate matrix

| Gate                    | Tool                                 | When                          | Command / source                                                        |
| ----------------------- | ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| Commit message          | commitlint (`config-conventional`)   | commit (`.husky/commit-msg`)  | `npx --no-install commitlint --edit "$1"`                               |
| Build                   | `tsc`                                | commit + CI                   | `npm run build`                                                         |
| Typecheck               | `tsc --noEmit`                       | commit + CI                   | `npm run typecheck`                                                     |
| Lint                    | ESLint                               | commit + CI (Node 22)         | `npm run lint`                                                          |
| Format                  | Prettier                             | commit + CI (Node 22)         | `npm run format:check`                                                  |
| Privacy scan            | `scripts/privacy-check.mjs`          | commit (via chain) + CI       | `npm run privacy:check`                                                 |
| Complexity / dead code  | Fallow                               | commit + CI                   | `npx fallow audit --base HEAD --health-baseline .fallow/health-baseline.json`; `.github/workflows/fallow.yml` |
| Secret scan (staged)    | gitleaks                             | commit (`.husky/pre-commit`)  | `gitleaks protect --staged --redact --verbose` (warn-and-skip if absent locally) |
| Secret scan (history)   | `gitleaks/gitleaks-action@v2`        | CI (PR + push), fail-closed   | `.github/workflows/secret-scan.yml`                                     |
| SAST                    | CodeQL (`javascript-typescript`)     | CI (PR + push + weekly cron)  | `.github/workflows/codeql.yml`                                         |
| Dependency audit        | npm audit                            | CI (Node 22)                  | `npm audit --audit-level=high`                                         |
| PR body validation      | `scripts/validate-pr-body.mjs`       | CI (`pull_request`)           | `.github/workflows/pr-body.yml`                                        |
| Unit tests              | Node `--test`                        | push (`.husky/pre-push`) + CI | `npm test`                                                             |
| E2E                     | Playwright                           | CI                            | `npm run test:e2e`                                                    |
| CLI smoke               | Node `--test` (package-smoke)        | CI (macOS + Windows)          | `node --test test/package-smoke.test.mjs`                              |
| Demo report freshness   | `scripts/demo-report.mjs --check`    | CI (Node 22)                  | `npm run demo:check`                                                  |
| Action dogfood          | the Action itself, on fixtures       | CI (`pull_request`)           | `.github/workflows/action-dogfood.yml`                                 |
| Gate-bypass block       | `.claude/hooks/block-gate-bypass.sh` | PreToolUse (Claude Code)      | Exits non-zero on `git commit`/`push` with `--no-verify`/`-n`          |

## Where each gate fires

- **`.husky/commit-msg`** — commitlint.
- **`.husky/pre-commit`** — build, typecheck, lint, format check, Fallow audit,
  gitleaks staged-diff scan.
- **`.husky/pre-push`** — `npm test` (git hook env is unset first so it does not
  leak into the CLI tests' temp repos).
- **CI (`ci.yml`)** — build/typecheck on the full Node matrix; lint, format,
  privacy, npm audit, demo freshness, unit, and e2e on Node 22; CLI smoke on
  macOS + Windows.
- **CI (dedicated workflows)** — `secret-scan.yml`, `codeql.yml`, `pr-body.yml`,
  `fallow.yml`, `action-dogfood.yml`.

## Bypass policy

Gates are never bypassed. `--no-verify`/`-n` is forbidden, and weakening type,
lint, or test configuration to turn red green is a named violation. The
`.claude/hooks/block-gate-bypass.sh` PreToolUse hook blocks the bypass flags at
the agent boundary; CI gates cannot be skipped at all.
