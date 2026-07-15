---
name: styleproof-prepush
description: Use when setting up a local pre-push hook that captures the StyleProof map before pushing (so CI restores it and runs report-only) — the capture→publish-to-store pattern, the docs-only skip, and why maps never get committed to the PR branch.
---

# StyleProof — capture the map at pre-push

One job: build the head map **locally, before the push**, so CI's hot path is
report-only (no build, no browser). This is the **default**: `styleproof-init`
installs the hook out of the box (`.husky/pre-push` if husky is present, else
`.githooks/pre-push` + `git config core.hooksPath .githooks`). This skill is
for understanding and customizing it.

## The pattern

The scaffolded `pre-push` hook:

1. **Skips** pushes that can't affect render — either `STYLEPROOF_SKIP_CAPTURE=1
git push`, or automatically when the pushed range is **docs-only**
   (`*.md`/`*.mdx`/`*.markdown`/`*.txt`/`docs/**`/`LICENSE`). A skip is always
   safe: CI just recaptures on the resulting cache miss.
2. **Reads the pushed refspec from stdin** and captures the ref whose tip is the
   checked-out tree, so the map binds to the SHA it actually rendered — pushing
   some _other_ branch (local oid ≠ HEAD) is left for CI, never captured from the
   wrong tree.
3. **Captures and publishes** the map (`npx styleproof-map`). Outside CI it
   auto-uploads the bundle to the dedicated `styleproof-maps` branch, keyed by
   commit SHA — CI restores it from there by the PR head SHA.
4. **Diffs** the fresh map against the inferred base (`styleproof-diff`), so you
   see drift before it reaches CI.

The map is **never committed to the PR branch**. Maps on the PR branch show up
as changed files in review and — because every PR writes the same paths — force
a rebase of every open PR each time one merges. The store branch is keyed per
SHA, so PRs never collide.

The hook file itself is a **two-line shim** — all the rules above live in the
packaged `styleproof-prepush` command, so they update with each styleproof
release instead of drifting in a copied hook file:

```sh
#!/bin/sh
# Skip a push that can't affect render: STYLEPROOF_SKIP_CAPTURE=1 git push
[ "${STYLEPROOF_SKIP_CAPTURE:-}" = "1" ] && exit 0
exec ./node_modules/.bin/styleproof-prepush --spec e2e/styleproof.spec.ts
```

The direct local binary is intentional: a missing StyleProof install fails
loudly instead of asking a package runner to download an unrelated command.

`styleproof-prepush` accepts `--spec`, `--dir`, `--base-dir`, repeatable
`--dirty-allow <path>` (forwarded to the capture for tracked files a dev tool
rewrites), and `--no-diff` to skip the advisory diff. A hook written by an older
release is refreshed in place with `styleproof-init --hook`.

If init wrote `.githooks/pre-push` (no husky), activate once per clone:
`git config core.hooksPath .githooks`.

## Gotchas learned in production

- **The hook captures the WORKING TREE, not HEAD.** A dirty tree (or HEAD moving
  mid-capture) marks the manifest dirty and the publish is refused — CI then
  recaptures both sides itself. Safe, but slow: commit everything before
  pushing so the capture is clean and publishable.
- **`core.hooksPath` is repo-global across worktrees** — a worktree whose main
  checkout sits on a stale branch runs _that_ branch's hook. Override per-push
  with `git -c core.hooksPath=<this-worktree>/.githooks push` when they diverge.
- **Environment must match CI.** Maps carry a compatibility key (platform +
  browser build); a locally-published head map captured under a different
  Chromium than CI's base is refused at compare time and CI recaptures both
  sides — correct, but you lose the latency win. Pin the local browser to CI's
  (same Playwright version and browser build) to keep the hot path hot.
- **Never `git add` the map dir.** `.styleproof/` and `stylemaps/` are
  gitignored on purpose; committing maps to the branch reintroduces the
  cross-PR rebase churn this pattern exists to avoid.

## Faster still: capture only affected surfaces

On a big app, the slow part is capturing every surface. The opt-in
`affectedSurfaces` / `explainAffectedSurfaces` helpers (README: _Optional:
selective remap_) take the changed files + a module graph and return the
surfaces that could have rendered differently — everything else reuses its
restored base map. Fail-closed: anything unbounded (a global stylesheet, a token
file) returns `'all'`. Print the skip list in the hook before trusting it, and
let `main` still capture everything as the trust-but-verify net.

## Next

`styleproof-ci-gate` is what consumes the pre-pushed map; `styleproof-baseline`
is the underlying `styleproof-map`.
