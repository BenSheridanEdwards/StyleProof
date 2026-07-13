# Progress

## Completed: post-4.1.0 review, dogfood, and truthfulness fixes

## Completed

- Adversarially re-reviewed merged PRs #225, #226, #227, #229 and dogfooded the
  CLI capture → diff → report flow on a scratch multi-page site.
- Replaced the shell-heuristic annotation move guard with a displacement proof:
  container census change, or a same-container slide into a vacated slot.
- Re-scoped CI SHA labeling to the checked-out tree; only a checkout of the
  synthetic merge commit is relabeled to the event head.
- Wired same-origin link following into `styleproof-capture --crawl` with
  per-route key prefixes and cross-page coverage aggregation.
- Corrected the diff's unknown-determinism message for ledger-less captures.

## Findings

- The #229 shell guard silently reverted #225 for uniform-shell lists, and
  reconciled size-changing restyle swaps as moves, losing all annotation proof.
- `annotationScope` wildcarding every ancestor index let changes in different
  containers cancel each other's annotations.
- `currentGitSha`'s env-first ordering stamped base-tree captures with the PR
  head SHA — a map-store poisoning path yielding base-vs-base false greens.
- The CLI crawl skipped anchors ("handled by link crawl") but no link crawl
  existed in that path: multi-page sites lost every non-entry page while
  coverage printed green.

## Verification Status

- Unit suite, Playwright e2e suite, and the three reviewer repro scripts pass;
  new regression tests pin all four fixes.
