# AGENTS.md

StyleProof is a public, MIT-licensed npm package and GitHub Action that gates
visual CSS changes on a pull request. You declare which app states matter; it
opens them in a real browser, records the browser's computed styles, compares
the PR head against the base branch, and posts a reviewable report. Intentional
visual changes get approved; unexpected ones block. It is framework-agnostic and
must stay backward-compatible and privacy-clean.

This file is the tool-agnostic entry point for every agent and human. Vendor
adapters (e.g. `CLAUDE.md`) defer here and add only vendor-specific content.

## Golden operating rules

- **Think before coding.** State assumptions, surface tradeoffs, ask before
  guessing on architecture, data shape, security, or irreversible changes.
- **Simplicity first.** Write the minimum code that solves the task. No
  speculative features, no single-use abstractions. Prefer stdlib and native
  platform features before adding dependencies.
- **Surgical changes.** Touch only what the task requires. Do not reformat,
  rename, or refactor adjacent code. Match existing style.
- **Deterministic control flow.** Routing, retries, status checks, thresholds,
  and branching belong in code, not model calls.
- **Fail loudly.** Report the exact failure of any command, test, build, or
  hook. Never relabel partial success as done.
- **Never bypass gates.** `--no-verify`/`-n` is forbidden; weakening type,
  lint, or test configuration to turn red green is a violation. See
  `.claude/hooks/block-gate-bypass.sh`.
- **Stay privacy-clean.** Never reference a private project (name, repos, PR
  numbers, internal URLs, or real UI/CSS shapes) in code, comments, tests,
  fixtures, commits, or PR text. `npm run privacy:check` enforces this. Grep the
  diff and the PR body before pushing.
- **Truth rule.** Do not claim a gate exists unless the hook, script, or
  workflow exists and runs on a clean checkout. Label targets as targets.

Full text: [`.agents/AGENT_OPERATING_RULES.md`](.agents/AGENT_OPERATING_RULES.md).

## Commands

| Task             | Command                                                          |
| ---------------- | ---------------------------------------------------------------- |
| Build            | `npm run build`                                                  |
| Typecheck        | `npm run typecheck`                                              |
| Lint             | `npm run lint` (`npm run lint:fix` to autofix)                   |
| Format           | `npm run format` (`npm run format:check` to verify)              |
| Privacy scan     | `npm run privacy:check`                                          |
| Unit tests       | `npm test`                                                       |
| E2E tests        | `npm run test:e2e`                                               |
| Demo report      | `npm run demo:report` (`npm run demo:check` to verify freshness) |
| Dependency audit | `npm audit --audit-level=high`                                   |

## Pointer table

| Read this                                                                        | For                                     |
| -------------------------------------------------------------------------------- | --------------------------------------- |
| [`.agents/README.md`](.agents/README.md)                                         | Index of the agent context layer        |
| [`.agents/project/ARCHITECTURE.md`](.agents/project/ARCHITECTURE.md)             | How the code is laid out and flows      |
| [`.agents/project/CONVENTIONS.md`](.agents/project/CONVENTIONS.md)               | Naming, style, and change rules         |
| [`.agents/project/TECH_STACK.md`](.agents/project/TECH_STACK.md)                 | Languages, deps, and tooling            |
| [`.agents/project/GLOSSARY.md`](.agents/project/GLOSSARY.md)                     | Domain terms (surface, variant, ...)    |
| [`.agents/project/QUALITY_GATES.md`](.agents/project/QUALITY_GATES.md)           | Every gate, tool, when it runs, command |
| [`.agents/project/PR_QUALITY.md`](.agents/project/PR_QUALITY.md)                 | PR body, proof, and title contract      |
| [`.agents/project/DEFINITION_OF_DONE.md`](.agents/project/DEFINITION_OF_DONE.md) | When a change is done                   |
| [`.agents/decisions/`](.agents/decisions/)                                       | Architecture decision records (ADRs)    |

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **styleproof** (1612 symbols, 3904 relationships, 137 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
