# Claude Code

The Claude Code layer on top of the [start-here guide](README.md). Read that
first.

## Agent tooling

This repo is wired for four Claude Code tools.

- **Ponytail** — the default working mode for coding, review, refactor, and
  design (see _Simplicity first_ in the [start-here guide](README.md)).
  Installed as a global plugin; switch intensity with
  `/ponytail lite|full|ultra`. Turn off per session with `stop ponytail`.
- **GitNexus** — code-intelligence graph. The MCP server is committed in
  [`.mcp.json`](../.mcp.json) (runs via `npx -y gitnexus mcp`, no global install
  needed); the skills live in `.claude/skills/gitnexus/`; the index lives in
  `.gitnexus/` (gitignored). How to use it is in [`GITNEXUS.md`](GITNEXUS.md).
- **Graphify** — `/graphify` turns this repo (or any path/URL) into a navigable
  knowledge graph under `graphify-out/` (gitignored). Reach for it for
  architecture, file-relationship, or "how does this fit together" questions.
- **Show Me** — `/show-me` creates a concise visual explanation of a change.
  For a non-trivial PR, choose the smallest view that removes review ambiguity.
  Keep every label grounded in the changed files, symbols, states, or evidence.
  The explanation supports the proof in the PR. It does not replace tests,
  StyleProof reports, screenshots, or exact-head CI. Read
  `.claude/skills/show-me/REPOSITORY.md` with the upstream skill.
  Installed from HumanLayer with `npx skills add humanlayer/skills --skill show-me`,
  pinned to source commit `3c2629142c5d437428269b1b722b08c0b87f574d`, and
  distributed here under HumanLayer's MIT license.

The StyleProof product skills (`styleproof`, `styleproof-install`, …) are
indexed in [`.claude/skills/README.md`](../.claude/skills/README.md).

## Working expectations

- **Fresh clone:** the graph index (`.gitnexus/`) is gitignored, so build it once
  with `npx gitnexus analyze --skip-agents-md`. Re-index after large changes or
  when `context` reports staleness.
- **Before editing a symbol:** run GitNexus `impact` to see the blast radius; warn
  on HIGH/CRITICAL risk. Rename via `rename`, not find-and-replace.
- **Before committing:** run `detect_changes` to confirm only the expected symbols
  and flows moved. This complements, and does not replace, the deterministic
  proof in [`project/DEFINITION_OF_DONE.md`](project/DEFINITION_OF_DONE.md).

## Settings and hooks

`.claude/settings.json` registers a **PreToolUse hook**
(`.claude/hooks/block-gate-bypass.sh`) that refuses the common ways to switch
the git hooks off: `--no-verify` and its abbreviations, `git commit -n` alone or
in a flag cluster, `HUSKY=0`, and writes to `core.hooksPath`, a git alias, or a
config include. Claude Code spawns it only for Bash commands that run `git`,
`env`, `sh`, or `bash`. `.codex/hooks.json` registers the same script for
Codex sessions that trust project hooks. It is a speed bump, not a sandbox; CI
on a clean checkout is the backstop. When a gate fails, fix the cause.

## Don't leak, don't clobber

- A plain `gitnexus analyze` writes its generated block into `AGENTS.md` and
  `CLAUDE.md`, which stay pointers. Always pass `--skip-agents-md`, and copy any
  new generated guidance into [`GITNEXUS.md`](GITNEXUS.md).
- Machine-specific Claude settings belong in `.claude/settings.local.json`
  (gitignored). Never commit absolute paths or usernames to this public repo.
