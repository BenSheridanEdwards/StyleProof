# ADR 0007: Adopt the AgenticRepoTemplate operating principles

- **Status:** Proposed (accepted by approving the PR)
- **Date:** 2026-10-21
- **Source:** the public AgenticRepoTemplate repository at `a8ccd52`, chiefly
  its ADRs 0021, 0022, 0025, 0026, 0027, 0028, 0039 and 0046

## Context

StyleProof already had most of the template's agent layer: `AGENTS.md`,
`.agents/project/`, ADRs, commitlint, Fallow, gitleaks, a PR-body validator and
a Claude hook that refused `--no-verify`. Some of it rested on prose alone:

- The operating contract lived in `AGENTS.md`, while `CLAUDE.md` carried its
  own tooling notes and a 50-line block that `gitnexus analyze` rewrites. An
  agent read two root files to find where to start, and `README.md` called
  them "the same file".
- Nothing failed when an agent doc was renamed, emptied, or regrown, when a
  link went stale, or when two branches each added "the next" ADR.
- `QUALITY_GATES.md` and `DEFINITION_OF_DONE.md` said `pre-commit` runs build
  and typecheck. #811 removed both from the hook; the docs kept the claim.
- The hook refused `--no-verify` and a bare `-n`, but let through `HUSKY=0`,
  `-nm` clusters, `--no-veri`, and writes to `core.hooksPath`, a git alias or a
  config include. It also spawned on every Bash call.
- Six inline `eslint-disable` comments gave no reason, and nothing required one.
- There was no single command for "every local gate".

The template's North Star is that the repository, not the agent, makes the
wrong change hard to land: every written rule names the check that enforces it.

## Decision

Adopt the template's principles where StyleProof can run and prove them:

1. **Pointer chain.** `CLAUDE.md` defers to `AGENTS.md` (and imports it with
   `@AGENTS.md`); `AGENTS.md` points to `.agents/README.md`, the start-here
   guide and operating contract. The Claude notes move to
   `.agents/CLAUDE_CODE.md` (absorbing `TOOLING.md`), the GitNexus block to
   `.agents/GITNEXUS.md`, and `.agents/openai.yaml` lists the same entry points
   for OpenAI-family agents. GitNexus re-indexes with `--skip-agents-md`.
2. **Rules name their enforcer.** `.agents/README.md` has one table mapping each
   rule to its check, or marks it **Not enforced yet**.
3. **`npm run check:context`** (`scripts/check-context-layer.mjs`) fails when
   the root files stop pointing or grow past 12 non-empty lines, the start-here
   guide is thin, a project doc is missing, a relative link in an agent doc is
   broken, a doc repeats a section under one parent, or two ADRs share a number.
   `CHANGELOG.md` is left out: each release repeats its headings.
4. **`npm run check:suppressions`** (`scripts/check-suppressions.mjs`) fails on
   an inline `eslint-disable*` that names no rule or gives no `-- reason`, on
   inline ESLint rule config, on `@ts-ignore` and `@ts-nocheck`, and on a
   `@ts-expect-error` without a reason. StyleProof keeps reasoned inline
   disables instead of the template's `noInlineConfig`: a line-level exception
   is narrower than a file-level one in `eslint.config.js`.
5. **Lint fails on warnings** (`--max-warnings=0`) and on unused disable
   directives (`reportUnusedDisableDirectives: 'error'`). The tree had none of
   either, so this only stops new ones.
6. **The gate-bypass hook** is the template's: it flattens quotes and
   backslashes, then refuses `--no-verify` and its abbreviations, `git commit -n`
   in any short-flag cluster, `HUSKY=0` or a `HUSKY` value built by expansion,
   and writes to `core.hooksPath`, `alias.*`, `include.path` or `includeIf.*`.
   `.claude/settings.json` spawns it only for commands that run `git`, `env`,
   `sh` or `bash`; `.codex/hooks.json` registers it for Codex.
   `test/block-gate-bypass.test.mjs` pins both lists of shapes.
7. **`npm run verify`** runs the context and suppression checks, typecheck,
   lint, format check, privacy scan and unit tests. The Definition of Done names
   it. CI runs the two new checks in the Node 22 build job.

## Not adopted, or not yet

- **Pre-push runs `verify` (template ADR 0028).** #811 deliberately slimmed the
  local hooks and kept CI as the gate. `pre-push` stays `npm test` plus the
  staged e2e; the new checks run in CI. Revisit if CI catches what a local
  `verify` would have.
- **Enforcement sign-off (template ADRs 0023, 0024).** A status that waits for
  the maintainer's tick before a change that loosens a gate lands. It needs a
  workflow, a script and a branch-protection change; it is a separate PR.
- **PR body names its head commit (template ADR 0029).** The PR-body validator
  is shared with other repos through `pr-body-reusable.yml`; changing its
  contract is a separate PR.
- **Template-specific rules:** the role table, Biome, React rules, Effect
  Schema, a dependency-needs-an-ADR check, PRDs and trials do not fit a
  framework-agnostic npm package with no UI of its own.

## Consequences

- An agent reads one short root file and lands in `.agents/README.md`.
- A plain `gitnexus analyze` re-adds its block to the root files, and
  `check:context` then fails until the block moves to `.agents/GITNEXUS.md`.
- A stale doc link or an ADR number clash fails CI instead of waiting for a
  reader.
- The hook is a speed bump, not a sandbox. It still misses `eval`, `xargs`,
  `command git`, `/usr/bin/git`, `zsh -c`, git plumbing such as
  `git commit-tree`, editing `.husky/` or `.git/config` with file tools, and
  shell tricks that build a flag at run time. It blocks some harmless commands,
  such as `git log --grep commit -n 3`; write a commit message that names a
  bypass to a file and use `git commit -F <file>`. CI on a clean checkout stays
  the backstop.
- New bypass shapes go into the test table first, then the script.
