# CLAUDE.md

**Start with [`AGENTS.md`](AGENTS.md).** It is the tool-agnostic source of truth:
what StyleProof is, the golden operating rules, the command table, and the pointer
table into `.agents/`. This file is a thin Claude-specific adapter — it adds only
Claude Code tooling and the auto-generated GitNexus block below.

## Agent tooling

This repo is wired for three Claude Code tools.

- **Ponytail** — the default working mode for coding, review, refactor, and design
  (see _Simplicity First_ in `AGENTS.md`). Installed as a global plugin; switch
  intensity with `/ponytail lite|full|ultra`. Turn off per session with
  `stop ponytail`.
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

Machine-specific Claude settings belong in `.claude/settings.local.json`
(gitignored) — never commit absolute paths or usernames to this public repo.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **styleproof** (1528 symbols, 3743 relationships, 130 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/styleproof/context` | Codebase overview, check index freshness |
| `gitnexus://repo/styleproof/clusters` | All functional areas |
| `gitnexus://repo/styleproof/processes` | All execution flows |
| `gitnexus://repo/styleproof/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
