# Agent Operating Rules

Source: https://x.com/mikenevermiss/status/2068197417506222428?s=46

## Behavioural Rules

### Think Before Coding

State assumptions before writing code. Surface tradeoffs. Ask before guessing on architecture, data shape, security, or irreversible changes. Push back when a simpler approach exists.

### Simplicity First

Write the minimum code that solves the task. No speculative features. No abstractions for single-use code. If the solution looks over-engineered, simplify it.

Use Ponytail for coding, review, refactor, and design tasks unless the user says
otherwise. Default level: `full`: delete code, reuse existing patterns, and use
stdlib or native platform features before adding abstractions or dependencies.

### Surgical Changes

Touch only what the task requires. Do not reformat, rename, or refactor adjacent code unless it is required for the change. Match existing style.

### Goal-Driven Execution

Define success before implementation. Keep working until that definition is met and verified. Do not ask for step-by-step instructions when the path can be inferred.

### Deterministic Control Flow

Do not use model calls for deterministic decisions. Routing, retries, status checks, thresholds, and branching rules belong in code.

### Hard Token Budgets

For long tasks, set a clear investigation budget. If the budget is reached without a verified solution, write findings and next steps to `PROGRESS.md` and stop cleanly.

### One Agent, One Directory

Parallel agents must use separate git worktrees or directories. No two agents should mutate the same checkout at the same time.

### Checkpoint Multi-Step Work

For tasks longer than three steps, create or update `PROGRESS.md` with: completed work, findings, next action, blockers, and verification status.

### Fail Loudly

If a command, test, build, hook, or assumption fails, report the exact failure. Do not relabel partial success as done. Passing tests only count when they cover the changed behavior.

### Unique Skill Descriptions

Each skill must describe exactly one job. If two skills could be selected for the same reason, rename or split them before relying on them.

### Separate Research From Implementation

If a task needs broad reading or multiple source lookups, do research first and produce a compact report. Start implementation from that report, not from a sprawling context window.

### Scoped Hooks Only

Hooks must have explicit scope: file extension, path, command, or session event. Avoid unconditional hooks on every tool call. Batch logging to session end where possible.

## What Not To Touch Without Explicit Approval

- Secrets, credentials, tokens, keys, and local environment files.
- Production configuration, deployment settings, billing, permissions, and security controls.
- Generated artifacts or snapshots unless the task explicitly requires updating them.
- Public publishing, releases, package publication, or external messaging.
- Destructive git operations including branch deletion, force-push, and history rewrite.

## Default Success Criteria

A task is not done until the changed behavior is verified by deterministic evidence: tests, build output, typecheck/lint results, screenshots/video for UI behavior, or another concrete artifact that does not depend on the model's judgment.

---

# StyleProof specifics

StyleProof is a **public, MIT, npm-published** library + GitHub Action. Keep it framework-agnostic, backward-compatible, and privacy-clean.

## Prove every change in the PR description (required)

The deterministic evidence above must be **visible in the PR description** — a reviewer should _see_ the result, not just read "tests pass":

- **Capture / diff / report changes:** paste an **example of the generated report**. Dogfood the tool on a small before/after and paste the Markdown:

  ```js
  import { generateStyleMapReport } from 'styleproof';
  generateStyleMapReport({ beforeDir, afterDir, outDir }); // → reportMdPath
  ```

  Include a real restyle and a `🆕 new surface` when relevant.

- **Behaviour / guards / CLI:** paste the actual command or test output that demonstrates it (e.g. the coverage guard failing on a gap, then passing once covered).

The PR template has a required **Proof** section — fill it in.

## Before opening a PR

- `npm run build && npm run typecheck && npm run lint && npm run format:check` pass.
- `npm test` passes; `npm run test:e2e` too if the capture/engine path changed.
- Tests added/updated; README + CHANGELOG (`[Unreleased]`) updated if the public API or behaviour changed. New optional API stays opt-in so existing specs are unaffected.

## Stay privacy-clean

Never reference a private project (its name, repos, PR numbers, internal URLs, or real UI/CSS shapes) in code, comments, tests, fixtures, commit messages, or PR text. Use generic examples (`home`, `pricing`, `ROUTES`). Grep the diff and the PR body before pushing.

## PR Proof Law

Before opening, updating, or marking a PR ready, read
`.agents/DEFINITION_OF_DONE.md` and
`.agents/skills/pr-inline-screenshot-proof/SKILL.md`.

- Screenshot proof must be committed to the branch and embedded inline in the PR
  body with `![alt](...png?raw=1)`.
- Bare screenshot links, local paths, relative paths, and placeholders are not
  proof.
- If no rendered or behavioural proof applies, write `Not applicable` with the
  technical reason in the PR proof section.

## Agent tooling

This repo is wired for three Claude Code tools. `AGENTS.md` is a symlink to this
file, so both stay in sync.

- **Ponytail** — the default working mode for coding, review, refactor, and design
  (see _Simplicity First_ above). Installed as a global plugin; switch intensity
  with `/ponytail lite|full|ultra`. Turn off per session with `stop ponytail`.
- **GitNexus** — code-intelligence graph. The MCP server is committed in
  [`.mcp.json`](.mcp.json) (runs via `npx -y gitnexus mcp`, no global install
  needed); the skills live in `.claude/skills/gitnexus/`; the index lives in
  `.gitnexus/` (gitignored). (Re)index with `node .gitnexus/run.cjs analyze`, or
  `npx gitnexus analyze` on a fresh clone. Details and the "always/never" rules are
  in the auto-generated **GitNexus — Code Intelligence** section below. That block
  is managed by `gitnexus analyze` (`<!-- gitnexus:start/end -->`) and rewritten on
  every re-index — **do not hand-edit inside it**; keep curated content above it.
- **Graphify** — `/graphify` turns this repo (or any path/URL) into a navigable
  knowledge graph under `graphify-out/` (gitignored). Reach for it for
  architecture, file-relationship, or "how does this fit together" questions.

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **styleproof** (1029 symbols, 2443 relationships, 88 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource                                    | Use for                                  |
| ------------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/styleproof/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/styleproof/clusters`       | All functional areas                     |
| `gitnexus://repo/styleproof/processes`      | All execution flows                      |
| `gitnexus://repo/styleproof/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->
