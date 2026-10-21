#!/usr/bin/env sh
# PreToolUse(Bash) guard (ADR 0007), ported from AgenticRepoTemplate.
# .claude/settings.json spawns it for Bash commands that run git, env, sh, or
# bash; .codex/hooks.json spawns it for every Codex Bash call. It refuses the
# common ways to switch the git hooks off:
#
#   --no-verify, and its abbreviations down to --no-veri
#   git commit -n, alone or in a short-flag cluster such as -nm or -an
#   HUSKY=0, or a HUSKY value built by $ or backtick expansion
#   writing core.hooksPath, a git alias, or a config include, through git
#     config, git -c, --config-env, or GIT_CONFIG_* variables
#
# It is a speed bump, not a sandbox. ADR 0007 lists the shapes it misses; CI on
# a clean checkout is the backstop. Exit code 2 blocks the tool call.

block() {
  echo "Blocked: $1 switches off the quality gates." >&2
  echo "Fix what the gate reports instead; see .agents/project/DEFINITION_OF_DONE.md." >&2
  echo "If a commit message only names the flag, write it to a file and use git commit -F <file>." >&2
  exit 2
}

# Read tool_input.command from the hook JSON and flatten it:
# - A quoted -m/--message argument becomes MSG, so a message may name a flag.
#   Only an unquoted -m counts, and only a message with no quote, $, or
#   backtick inside, so a fake "-m '" inside another string hides nothing.
# - Every quote and backslash is then deleted, so --no-ver''ify, "-n", and
#   core.hooks\Path read as the flag they are. This can only add blocks.
# (No single quote may appear in this program: \x27 stands for one.)
flatten='
const MESSAGE = /^(-[apsvqeioz]*m|--message)(=|\s+)(\x27[^\x27"$`]*\x27|"[^\x27"$`\\]*")/;
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const command = JSON.parse(raw).tool_input?.command;
  const text = typeof command === "string" ? command : "";
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const message = quote === "" && (i === 0 || /\s/.test(text[i - 1])) && MESSAGE.exec(text.slice(i));
    if (message) {
      out += `${message[1]} MSG`;
      i += message[0].length - 1;
      continue;
    }
    const ch = text[i];
    out += ch;
    if (ch === "\\" && quote !== "\x27") out += text[++i] ?? "";
    else if (ch === quote) quote = "";
    else if (quote === "" && (ch === "\x27" || ch === "\"")) quote = ch;
  }
  process.stdout.write(out.replace(/["\x27\\]/g, "").replace(/\s+/g, " "));
});
'
if ! flat="$(node -e "$flatten")"; then
  echo "Blocked: the hook could not read the command (is node on PATH?)." >&2
  exit 2
fi

has() { printf '%s' "$flat" | grep -Eq -e "$1"; }

has '--no-veri' && block '--no-verify'

# n must come before any flag that takes a value (m, F, c, C, t, S, u), so -nm
# and -an block but -mn (message "n") and -uno (untracked=no) do not.
has 'git[[:space:]]([^;&|]*[[:space:]])?commit[[:space:]]([^;&|]*[[:space:]])?-[apsvqeioz]*n[A-Za-z]*([^A-Za-z-]|$)' &&
  block 'git commit -n'

# Husky skips every hook when HUSKY is exactly 0. A value made by expansion
# could be 0, so only plain literals pass.
has '(^|[^A-Za-z0-9_])HUSKY=0([^A-Za-z0-9_./:+-]|$)' && block 'HUSKY=0'
has '(^|[^A-Za-z0-9_])HUSKY=[^[:space:];&|]*[$`]' && block 'HUSKY set by expansion'

# Config keys that move or skip the hooks: core.hooksPath directly, an alias
# such as `ci = commit -n`, or an include file that sets either. Remove the
# allowed forms (reads, and core.hooksPath set back to Husky's own .husky/_ or
# .husky), then any remaining mention is a write. Keys are case-insensitive.
config='git config( --[a-z-]+)*'
scope='( --(local|global|system|worktree))?'
end='( |;|&|\||\)|$)'
rest="$(printf '%s' "$flat" | tr '[:upper:]' '[:lower:]' | sed -E \
  -e "s/${config} (--get|--get-all|--get-regexp|get)( --[a-z-]+)* [^ ;&|]+/ ; /g" \
  -e "s/git config${scope}( set)? core\.hookspath \.husky(\/_)?\/?${end}/ ; /g" \
  -e "s/git config${scope} core\.hookspath ?([;&|)]|$)/ ; /g")"
printf '%s' "$rest" | grep -Eq 'core\.hookspath' && block 'rewriting core.hooksPath'
printf '%s' "$rest" | grep -Eq '(^|[^a-z0-9_])alias\.[a-z0-9]' && block 'writing a git alias'
printf '%s' "$rest" | grep -Eq 'include\.path|includeif\.' && block 'writing a git config include'

exit 0
