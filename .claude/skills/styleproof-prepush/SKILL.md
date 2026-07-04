---
name: styleproof-prepush
description: Use when setting up a local pre-push hook that captures the StyleProof map before pushing (so CI restores it and runs report-only) — the capture→diff→auto-commit-map pattern, the re-entry guard, and a docs-only skip.
---

# StyleProof — capture the map at pre-push

One job: build the head map **locally, before the push**, so CI's hot path is
report-only (no build, no browser). The README's guidance — "build the map
outside CI when possible by running `styleproof-map` after committing" — as a
git hook. Optional but a big CI-latency win for same-repo teams.

## The pattern

A `pre-push` hook that:

1. **Bails early** for changes that can't affect render — if the push touches no
   `hud/`, styleproof config, or the hook itself, `exit 0`.
2. **Captures** the working tree's map (`npm run styleproof:capture` / `styleproof-map`).
3. **Diffs** the fresh map against the base ref (`styleproof-diff HEAD`), so you
   see drift before it reaches CI.
4. **Commits the updated map** alongside the branch and pushes it, so the store
   and the PR head agree.

```sh
#!/bin/sh
set -e
# Re-entry guard: the map commit is pushed by this hook, which fires the hook a
# SECOND time — skip the expensive capture on that inner push.
[ "${STYLEPROOF_SKIP_CAPTURE:-}" = "1" ] && exit 0

changed="$(git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD)"
printf '%s\n' "$changed" | grep -Eq '^(src/|styleproof\.config\.json$)' || exit 0

npm run styleproof:capture                       # → stylemaps/current
if git cat-file -e HEAD:stylemaps/current 2>/dev/null; then
  STYLEPROOF_BASE_REF=HEAD npm run -s styleproof:diff || true   # advisory: show drift
fi
git add stylemaps
git diff --cached --quiet -- stylemaps && exit 0
git commit -m "chore(styleproof): update computed-style map"
STYLEPROOF_SKIP_CAPTURE=1 git push "$1" HEAD      # inner push, guard short-circuits it
```

Activate: `git config core.hooksPath .githooks` (or drop it in `.husky/`).

## Gotchas learned in production

- **The hook captures the WORKING TREE, not HEAD.** Never background-push while
  editing — you'll capture a half-saved state. For a docs-only push, skip it:
  `STYLEPROOF_SKIP_CAPTURE=1 git push`.
- **`core.hooksPath` is repo-global across worktrees** — a worktree whose main
  checkout sits on a stale branch runs *that* branch's hook. Override per-push
  with `git -c core.hooksPath=<this-worktree>/.githooks push` when they diverge.
- **Environmental map churn:** computed-style *serialization* can differ by
  Chromium build (`0% 0%` ↔ `0px 0px`), so a local capture can diff against a
  CI-built baseline with no real visual change. Don't commit that churn — it
  breaks CI's browserless diff. `STYLEPROOF_SKIP_CAPTURE=1` and let CI's own
  captured-in-one-environment diff be authoritative.

## Next

`styleproof-ci-gate` is what consumes the pre-pushed map; `styleproof-baseline`
is the underlying `styleproof-map`.
