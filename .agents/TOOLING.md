# Agent tooling

This repo is wired for Claude Code with three tools. The tool-agnostic operating
rules live in [`AGENTS.md`](../AGENTS.md); the Claude-specific tooling notes and
the auto-generated **GitNexus — Code Intelligence** block live in
[`CLAUDE.md`](../CLAUDE.md). This file records how they fit the workflow here.

## The stack

- **Ponytail** — default lazy-coding mode (global plugin). `/ponytail lite|full|ultra`.
- **GitNexus** — code graph. MCP server in [`.mcp.json`](../.mcp.json) (`npx -y gitnexus mcp`);
  skills in `.claude/skills/gitnexus/`; index in `.gitnexus/` (gitignored).
- **Graphify** — `/graphify` → knowledge graph in `graphify-out/` (gitignored).

## Working expectations

- **Fresh clone:** the graph index (`.gitnexus/`) is gitignored, so build it once
  with `npx gitnexus analyze` (or `node .gitnexus/run.cjs analyze` if the runner
  already exists). Re-index after large changes or when `context` reports staleness.
- **Before editing a symbol:** run GitNexus `impact` to see the blast radius; warn
  on HIGH/CRITICAL risk. Rename via `rename`, not find-and-replace.
- **Before committing:** run `detect_changes` to confirm only the expected symbols
  and flows moved. This complements — does not replace — the deterministic proof in
  [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md).

## Don't leak, don't clobber

- `gitnexus analyze` rewrites the `<!-- gitnexus:start/end -->` block in `CLAUDE.md`
  on every run — never hand-edit inside it; keep curated content above it.
- Machine-specific Claude settings belong in `.claude/settings.local.json`
  (gitignored) — never commit absolute paths or usernames to this public repo.
