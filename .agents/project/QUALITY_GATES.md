# Quality gates

Every gate that guards this repo: its owner tool, when it runs, and the exact
command. Local hooks live in `.husky/`; CI lives in `.github/workflows/`. A gate
is listed here only if it exists and runs on a clean checkout.

## Gate matrix

| Gate                    | Tool                                                       | When                           | Command / source                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit message          | commitlint (`config-conventional`)                         | commit (`.husky/commit-msg`)   | `npx --no-install commitlint --edit "$1"`                                                                                                                                       |
| Build                   | `tsc`                                                      | CI (Node 22.13.0, 22, 24)      | `npm run build`                                                                                                                                                                 |
| Typecheck               | `tsc --noEmit`                                             | `npm run verify` (no hook; CI typechecks through `npm run build`) | `npm run typecheck`                                                                                                                                    |
| Lint                    | ESLint (`--max-warnings=0`; unused disable directives are errors) | commit + CI (Node 22)   | `npm run lint`                                                                                                                                                                  |
| Format                  | Prettier                                                   | commit + CI (Node 22)          | `npm run format:check`                                                                                                                                                          |
| Context layer           | `scripts/check-context-layer.mjs`                          | CI (Node 22) + `npm run verify` | `npm run check:context`: root pointers, project docs, relative links, repeated sections, unique ADR numbers                                                                   |
| Suppressions            | `scripts/check-suppressions.mjs`                           | CI (Node 22) + `npm run verify` | `npm run check:suppressions`: every inline `eslint-disable` names its rules and a `-- reason`; a type suppression is a reasoned `@ts-expect-error`                            |
| Privacy scan            | `scripts/privacy-check.mjs`                                | CI (Node 22) + `prepublishOnly` (not a local hook) | `npm run privacy:check`                                                                                                                                                         |
| Complexity / dead code  | Fallow                                                     | commit + CI (`pull_request`)   | `npx --no-install fallow audit --base HEAD --health-baseline .fallow/health-baseline.json`; `.github/workflows/fallow.yml`                                                      |
| Production health       | Fallow (`fallow health --production`)                      | commit + CI (`pull_request`)   | `npx --no-install fallow health --production --baseline .fallow/health-baseline.json --changed-since HEAD --diff-file <staged diff> --fail-on-issues`; CI runs the same health pass with `--changed-since <PR base SHA>` in `.github/workflows/fallow.yml` |
| Secret scan (staged)    | gitleaks                                                   | commit (`.husky/pre-commit`)   | `gitleaks protect --staged --redact --verbose` (warn-and-skip if absent locally)                                                                                                |
| Secret scan (history)   | `gitleaks/gitleaks-action@v3` (SHA-pinned)                 | CI (PR + push), fail-closed    | `.github/workflows/secret-scan.yml`                                                                                                                                             |
| SAST                    | CodeQL (`javascript-typescript`)                           | CI (PR + push + weekly cron)   | `.github/workflows/codeql.yml`                                                                                                                                                  |
| Dependency audit        | npm audit                                                  | CI (Node 22)                   | `npm audit --audit-level=high`                                                                                                                                                  |
| PR body validation      | `scripts/validate-pr-body.mjs`                             | CI (`pull_request`)            | `.github/workflows/pr-body.yml`                                                                                                                                                 |
| Unit tests              | Node `--test`                                              | push (`.husky/pre-push`) + CI  | `npm test`; CI reuses its prior build via `npm run test:unit`                                                                                                                   |
| E2E                     | Playwright                                                 | CI (Node 22, 4 shards + evidence job) | `npm run build`; `npx playwright test --config=playwright.ci.config.ts --shard=N/4` (base projects plus the `firefox-unsupported-state` Firefox project); `e2e-evidence` runs `scripts/verify-e2e-shards.mjs` to check full inventory coverage and print the determinism oracle receipt. Locally: `npm run test:e2e` (base `playwright.config.ts`, no Firefox project) |
| CLI smoke               | Node `--test` (package-smoke)                              | CI (macOS + Windows)           | `node --test test/package-smoke.test.mjs`                                                                                                                                       |
| Demo report freshness   | `scripts/demo-report.mjs --check`                          | CI (Node 22)                   | CI: `node scripts/demo-report.mjs --check`; locally `npm run demo:check`                                                                                                        |
| Action dogfood          | the Action itself, on fixtures                             | CI (`pull_request`)            | `.github/workflows/action-dogfood.yml`                                                                                                                                          |
| Map-store dogfood       | real capture + map store + diff                            | CI (`pull_request`)            | `.github/workflows/store-dogfood.yml`                                                                                                                                           |
| Live StyleProof dogfood | Action on `styleproof.config.ts` surfaces (`example/demo`) | CI (`pull_request`, same-repo) | `.github/workflows/styleproof-dogfood.yml` — advisory (`fail-on-diff: false`); product-state ledger armed (declare-or-fail-closed); **not** part of the hosted `required` check |
| Phase 1 mapping (advisory) | Playwright foundation + structure harnesses (`capture → diff → report`) | CI (`pull_request`) | `.github/workflows/phase1-advisory-dogfood.yml` — job **`Phase 1 mapping (advisory)`**; soft-pass HOLD (fail closed on wrong/incomplete mapping); **not** part of the hosted `required` check |
| Enforcement sign-off    | `scripts/enforcement-approval.mjs` (main's copy)           | CI (`pull_request_target`; `issue_comment` edits of its comment) | `.github/workflows/enforcement-approval.yml`: a PR that changes `.husky/**`, `.github/workflows/**`, `eslint.config.js`, `commitlint.config.js`, `scripts/check-suppressions.mjs`, `scripts/check-context-layer.mjs` or the gate's own files gets a pending `enforcement-approval` status until BenSheridanEdwards ticks the box bound to the head commit; `test/enforcement-approval.test.mjs` pins it ([ADR 0008](../decisions/0008-sign-off-enforcement-changes.md)). Not yet a required check |
| Gate-bypass block       | `.claude/hooks/block-gate-bypass.sh`                       | PreToolUse (Claude Code for `git`/`env`/`sh`/`bash` commands; Codex via `.codex/hooks.json`) | Exits 2 on `--no-verify` and its abbreviations, `git commit -n` in any flag cluster, `HUSKY=0`, and writes to `core.hooksPath`, a git alias, or a config include; `test/block-gate-bypass.test.mjs` pins the shapes ([ADR 0007](../decisions/0007-adopt-the-agentic-repo-template.md)) |

## Where each gate fires

- **`.husky/commit-msg`** — commitlint.
- **`.husky/pre-commit`** — lint, format check, gitleaks staged-diff scan,
  Fallow audit, then `fallow health --production` over the staged diff. Build
  and typecheck left the hook in #811; CI runs them. The privacy scan is **not**
  a local hook; run `npm run privacy:check` (or `npm run verify`) yourself
  before pushing.
- **`.husky/pre-push`** — `npm test` (git hook env is unset first so it does not
  leak into the CLI tests' temp repos), then `scripts/pre-push-e2e.mjs`, the
  shared CI path policy over staged and pushed files. Every nonempty changed
  path selects the full browser suite, including prose and tooling files;
  filenames have no exemptions. Unknown inventories, including a first push
  without a remote base, also run it. Only a proven empty or deletion-only
  inventory may skip it. Missing Chromium, malformed push metadata and Git read
  failures block the push.
- **`npm run verify`** — every local gate in one command: context and
  suppression checks, typecheck, lint, format check, privacy scan, and
  `npm test`. No hook runs it
  ([ADR 0007](../decisions/0007-adopt-the-agentic-repo-template.md)).
- **CI (`ci.yml`)** — build and unit on the full Node matrix; lint, format,
  context layer, suppressions, privacy, npm audit, and demo freshness on
  Node 22; e2e in four parallel
  Node 22 shards (`playwright.ci.config.ts`, which adds a Firefox project) plus
  an `e2e-evidence` job that verifies shard coverage and prints the determinism
  receipt; CLI smoke on macOS + Windows; one stable `required` check that fails
  unless the path filter, `build` and `cli-smoke` succeed. The browser lanes
  (`e2e`, `e2e-evidence`, `detection-corpus`) must succeed too. They may skip
  only when the path filter succeeded and its `e2e` output is exactly `false`.
  An empty, missing or malformed decision fails closed.
  `test/ci-required-policy.test.mjs` executes the step against a table of
  cases.
- **`prepublishOnly`** — clean, build, typecheck, lint, format check, privacy
  scan, `npm test`, and `npm run test:e2e` before any `npm publish`.
- **CI (dedicated workflows)** — `secret-scan.yml`, `codeql.yml`, `pr-body.yml`,
  `fallow.yml`, `action-dogfood.yml`, `store-dogfood.yml`,
  `styleproof-dogfood.yml` (advisory, not required),
  `phase1-advisory-dogfood.yml` (Phase 1 mapping gate — advisory, not required).
  `.github/workflows/styleproof-approve.yml` is the thin adopter-shaped approve
  caller (`styleproof-approve-reusable.yml@main`). It is not a required check;
  reviewer ticks stay inert until advisory dogfood enables `require-approval`.
  `enforcement-approval.yml` runs `main`'s copy of
  `scripts/enforcement-approval.mjs` and posts the `enforcement-approval`
  status; it blocks a merge only once branch protection requires that status.

## Bypass policy

Gates are never bypassed. `--no-verify`/`-n`, `HUSKY=0`, and pointing
`core.hooksPath` elsewhere are forbidden, and weakening type, lint, or test
configuration to turn red green is a named violation. The
`.claude/hooks/block-gate-bypass.sh` PreToolUse hook blocks the common bypass
shapes at the agent boundary. It is a speed bump; ADR 0007 lists what it
misses. CI gates cannot be skipped at all.
