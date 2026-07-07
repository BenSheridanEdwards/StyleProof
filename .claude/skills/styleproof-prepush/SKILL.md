---
name: styleproof-prepush
description: Use when setting up a local pre-push hook that captures the StyleProof map before pushing (so CI restores it and runs report-only) — the capture→publish-to-store pattern, the docs-only skip, and why maps never get committed to the PR branch.
---

# StyleProof — capture the map at pre-push

One job: build the head map **locally, before the push**, so CI's hot path is
report-only (no build, no browser). The README's guidance — "build the map
outside CI when possible by running `styleproof-map` after committing" — as a
git hook. Optional but a big CI-latency win for same-repo teams.

## The pattern

A `pre-push` hook that:

1. **Bails early** for changes that can't affect render — if the push touches no
   `src/`, styleproof config, or the hook itself, `exit 0`.
2. **Captures and publishes** the map (`npx styleproof-map`). Outside CI it
   auto-uploads the bundle to the dedicated `styleproof-maps` branch, keyed by
   commit SHA — CI restores it from there by the PR head SHA.
3. **Diffs** the fresh map against the inferred base (`styleproof-diff`), so you
   see drift before it reaches CI.

The map is **never committed to the PR branch**. Maps on the PR branch show up
as changed files in review and — because every PR writes the same paths — force
a rebase of every open PR each time one merges. The store branch is keyed per
SHA, so PRs never collide.

```sh
#!/bin/sh
set -e
# Docs-only escape hatch: STYLEPROOF_SKIP_CAPTURE=1 git push
[ "${STYLEPROOF_SKIP_CAPTURE:-}" = "1" ] && exit 0

changed="$(git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD)"
printf '%s\n' "$changed" | grep -Eq '^(src/|styleproof\.config\.json$)' || exit 0

npx styleproof-map            # capture → .styleproof/maps/current, publish to styleproof-maps
npx styleproof-diff || true   # advisory: show drift before CI does
```

Activate: `git config core.hooksPath .githooks` (or drop it in `.husky/`).

## Gotchas learned in production

- **The hook captures the WORKING TREE, not HEAD.** A dirty tree (or HEAD moving
  mid-capture) marks the manifest dirty and the publish is refused — CI then
  recaptures both sides itself. Safe, but slow: commit everything before
  pushing so the capture is clean and publishable.
- **`core.hooksPath` is repo-global across worktrees** — a worktree whose main
  checkout sits on a stale branch runs *that* branch's hook. Override per-push
  with `git -c core.hooksPath=<this-worktree>/.githooks push` when they diverge.
- **Environment must match CI.** Maps carry a compatibility key (platform +
  browser build); a locally-published head map captured under a different
  Chromium than CI's base is refused at compare time and CI recaptures both
  sides — correct, but you lose the latency win. Pin the local browser to CI's
  (same Playwright version and browser build) to keep the hot path hot.
- **Never `git add` the map dir.** `.styleproof/` and `stylemaps/` are
  gitignored on purpose; committing maps to the branch reintroduces the
  cross-PR rebase churn this pattern exists to avoid.

## Next

`styleproof-ci-gate` is what consumes the pre-pushed map; `styleproof-baseline`
is the underlying `styleproof-map`.
