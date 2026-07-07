#!/usr/bin/env sh
# PreToolUse hook: block any git commit/push that bypasses the local gates.
# Reads the tool-call JSON on stdin. Exits 2 (blocking) when a Bash command runs
# `git commit` or `git push` with `--no-verify` or a bare `-n`, which would skip
# the husky hooks (commitlint, build/typecheck/lint/format, Fallow, gitleaks,
# unit tests). Exit 0 otherwise. See .agents/project/QUALITY_GATES.md.
set -eu

input="$(cat)"

# Only inspect Bash tool calls; anything else is allowed through.
tool_name="$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ "$tool_name" = "Bash" ] || exit 0

# Extract the command string. Fall back to scanning the whole payload if the
# minimal parse misses (keeps the guard fail-safe, never fail-open on git verbs).
command="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
[ -n "$command" ] || command="$input"

# Not a commit/push? Allow.
case "$command" in
  *"git commit"* | *"git push"*) : ;;
  *"git "*commit* | *"git "*push*) : ;;
  *) exit 0 ;;
esac

# Bypass flags: --no-verify, or a standalone -n (commit's short no-verify).
case "$command" in
  *--no-verify*)
    echo "Blocked: --no-verify skips the local gates (commitlint, build/typecheck/lint/format, Fallow, gitleaks, tests). Remove it and fix the failure. See .agents/project/QUALITY_GATES.md." >&2
    exit 2
    ;;
esac

# Match a bare -n token (flag), not substrings like "-name" or "branch-n".
for token in $command; do
  if [ "$token" = "-n" ]; then
    echo "Blocked: 'git commit -n' bypasses the commit-msg and pre-commit gates. Remove -n and fix the failure. See .agents/project/QUALITY_GATES.md." >&2
    exit 2
  fi
done

exit 0
