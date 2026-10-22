# Start here

Every agent doc for this repo lives in `.agents/`. The root `AGENTS.md` and
`CLAUDE.md` only point here ([ADR 0007](decisions/0007-adopt-the-agentic-repo-template.md)).
This file is the operating contract for **any** agent or engineer. When the way
we work changes, change it here.

## What this repo is

StyleProof is a public, MIT-licensed npm package and GitHub Action that reports
the visual CSS changes a pull request makes. You declare which app states matter;
it opens them in a real browser, records the browser's computed styles, compares
the PR head against the base branch, and posts a report on the pull request. The
reviewer, a person or an agent, checks that the report shows the visual change
the PR intends, then approves it. It is framework-agnostic and must stay
privacy-clean. Breaking changes ship only in a major release, with migration
notes in the CHANGELOG.

## Commands

| Task               | Command                                                          |
| ------------------ | ---------------------------------------------------------------- |
| Every local gate   | `npm run verify`                                                 |
| Build              | `npm run build`                                                  |
| Typecheck          | `npm run typecheck`                                              |
| Lint               | `npm run lint` (`npm run lint:fix` to autofix)                   |
| Format             | `npm run format` (`npm run format:check` to verify)              |
| Privacy scan       | `npm run privacy:check`                                          |
| Context layer      | `npm run check:context`                                          |
| Suppressions       | `npm run check:suppressions`                                     |
| Unit tests         | `npm test`                                                       |
| E2E tests          | `npm run test:e2e`                                               |
| Demo report        | `npm run demo:report` (`npm run demo:check` to verify freshness) |
| Dependency audit   | `npm audit --audit-level=high`                                   |

`npm run verify` runs the context and suppression checks, typecheck, lint,
format check, privacy scan and unit tests. Run `npm run test:e2e` as well when
capture, diff, report, Action, or engine behaviour changes.

## Golden operating rules

1. **Read before you write.** The architecture, conventions, Definition of Done,
   glossary and ADRs live in this folder.
2. **Think before coding.** State assumptions, surface tradeoffs, ask before
   guessing on architecture, data shape, security, or irreversible changes.
3. **Simplicity first.** Write the minimum code that solves the task. No
   speculative features, no single-use abstractions. Prefer stdlib and native
   platform features before adding dependencies.
4. **Surgical changes.** Touch only what the task requires. Do not reformat,
   rename, or refactor adjacent code. Match existing style.
5. **Deterministic control flow.** Routing, retries, status checks, thresholds,
   and branching belong in code, not model calls.
6. **When a gate fails, fix the cause.** Keep every gate and its config as it
   is. `--no-verify`/`-n`, `HUSKY=0` and rewriting `core.hooksPath` are
   refused; weakening type, lint, or test configuration to turn red green is a
   violation.
7. **Fail loudly.** Report the exact failure of any command, test, build, or
   hook. Never relabel partial success as done.
8. **Done means the gates are green.** Report a task complete once
   `npm run verify` passes, plus `npm run test:e2e` when the browser surface
   changed; see [`project/DEFINITION_OF_DONE.md`](project/DEFINITION_OF_DONE.md).
9. **PRs carry proof.** Complete the pull request template and follow
   [`project/PR_QUALITY.md`](project/PR_QUALITY.md) before opening a PR or
   marking it ready.
10. **Stay privacy-clean.** Never reference a private project (name, repos, PR
    numbers, internal URLs, or real UI/CSS shapes) in code, comments, tests,
    fixtures, commits, or PR text. Grep the diff and the PR body before pushing.
11. **Truth rule.** Claim a gate only when the hook, script, or workflow exists
    and runs on a clean checkout. Label targets as targets.
12. **Change rules in the open.** When a constraint is wrong, propose an ADR in
    [`decisions/`](decisions/) and change the rule there.

Full text: [`AGENT_OPERATING_RULES.md`](AGENT_OPERATING_RULES.md).

## Rules and what enforces them

Each rule below fails a check when it is broken, so the check's message is the
first place to look. A rule marked **Not enforced yet** is a target that review
holds until a check exists.

| Rule | Enforced by |
| --- | --- |
| Commits and PR titles follow Conventional Commits. | commitlint on `commit-msg`; `PR body` workflow (`scripts/validate-pr-body.mjs`) |
| Every hook runs; `--no-verify` (and abbreviations), `git commit -n` (and clusters such as `-nm`), `HUSKY=0`, and writes to `core.hooksPath`, a git alias, or a config include are refused. | `.claude/hooks/block-gate-bypass.sh` for Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`); CI re-runs every gate |
| A change to a gate file (`.husky/**`, `.github/workflows/**`, `eslint.config.js`, `commitlint.config.js`, the suppression and context checks, the sign-off gate itself) waits for BenSheridanEdwards to tick a sign-off bound to the head commit. | `enforcement-approval` commit status from `.github/workflows/enforcement-approval.yml` (`scripts/enforcement-approval.mjs`, [ADR 0008](decisions/0008-sign-off-enforcement-changes.md)); it blocks a merge once branch protection requires it |
| Lint passes with zero warnings, and every inline `eslint-disable` is used. | `npm run lint` (`--max-warnings=0`, `reportUnusedDisableDirectives: 'error'`) in `pre-commit` and CI |
| Every inline `eslint-disable*` names its rules and a `-- reason`; every type suppression is a `@ts-expect-error` with its reason. | `npm run check:suppressions` in CI |
| Formatting matches Prettier. | `npm run format:check` in `pre-commit` and CI |
| `strict` TypeScript compiles. | `npm run build` in CI on Node 22.13.0, 22 and 24 |
| No private project names, local paths or denylisted tokens in any tracked text file. | `npm run privacy:check` in CI and `prepublishOnly` |
| Secrets stay out of commits. | gitleaks in `pre-commit` (skipped with a warning when absent) and `secret-scan.yml` |
| No new dead code, duplication, or complexity over the baseline. | Fallow in `pre-commit` and `fallow.yml` |
| `CLAUDE.md` defers to `AGENTS.md`, which points here; ADR numbers are unique and match their titles; no agent doc repeats a section. | `npm run check:context` in CI |
| The PR body keeps the eight template sections in order and carries inline proof. | `PR body` workflow (`scripts/validate-pr-body.mjs`) |
| The committed demo report matches the renderer. | `npm run demo:check` in CI |
| Unit coverage stays at or above the floor. | `npm run test:coverage` in CI (Node 22) |
| Done means the hosted `required` check is green on the latest commit. | `required` job in `ci.yml` |
| Every behaviour change ships a test; every bug fix ships the test that fails without it. | **Not enforced yet** (review) |
| Breaking changes ship only in a major release, with migration notes in the CHANGELOG. | **Not enforced yet** (review) |

## Evidence quality standard

Before presenting, committing, pushing, or calling work complete:

- Read every visible word in the evidence, including warnings, caveats, badges,
  captions, labels, and status details.
- Test the claim against the source artifact. A green headline, passing check,
  or screenshot is not proof when the underlying content narrows or contradicts
  it.
- Classify evidence honestly as certified, complete, partial, advisory,
  passing-only, stale, or unknown. Never promote a weaker state into a stronger
  claim.
- Inspect the final rendered artifact in the surface and size that users and
  reviewers will actually see. Verify crops, legibility, links, and surrounding
  context.
- After the final change, rerun the applicable gates and verify the live exact
  head: PR body, committed proof assets, hosted checks, and merge state.
- If evidence weakens a claim, fix the evidence or qualify/remove the claim.
  Never hide a warning through cropping, omission, or selective description.

## What is here, and when to read it

| Path | Read it when… |
| --- | --- |
| [`AGENT_OPERATING_RULES.md`](AGENT_OPERATING_RULES.md) | …you need the full text of the operating rules. |
| [`project/ARCHITECTURE.md`](project/ARCHITECTURE.md) | …before adding or moving a module: the layout and the capture → diff → report flow. |
| [`project/CONVENTIONS.md`](project/CONVENTIONS.md) | …while writing code: naming, style, testing, and change rules. |
| [`project/DEFINITION_OF_DONE.md`](project/DEFINITION_OF_DONE.md) | …before you claim a task is finished. |
| [`project/QUALITY_GATES.md`](project/QUALITY_GATES.md) | …before changing hooks, scripts, CI, or tool ownership. |
| [`project/PR_QUALITY.md`](project/PR_QUALITY.md) | …before opening, updating, or marking a pull request ready. |
| [`project/TECH_STACK.md`](project/TECH_STACK.md) | …to know which tool owns which concern (and what *not* to add). |
| [`project/GLOSSARY.md`](project/GLOSSARY.md) | …when you meet a domain term: surface, variant, popup, coverage, … |
| [`decisions/`](decisions/) | …to understand *why* a constraint exists before you challenge it. |
| [`skills/`](skills/) | …before a PR: the PR quality contract and inline screenshot proof. |
| [`CLAUDE_CODE.md`](CLAUDE_CODE.md) | …if you are Claude Code: skills, settings, hooks, and tooling. |
| [`GITNEXUS.md`](GITNEXUS.md) | …before editing a symbol: impact analysis and change detection. |
| [`openai.yaml`](openai.yaml) | …if you are an OpenAI-family agent: the same entry points as a manifest. |
