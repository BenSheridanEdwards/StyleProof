---
name: styleproof-ci-gate
description: Use when wiring StyleProof as a PR gate in CI — the BenSheridanEdwards/StyleProof@v3 Action, review-gate vs certify (fail-on-diff) mode, the approve-checkbox workflow, blocking without branch protection, and the fork/Dependabot capture/report split.
---

# StyleProof — wire the CI PR gate

One job: make a PR carry a `StyleProof` status that reflects whether rendered
styles changed. `styleproof-init` scaffolds the cache-first version of this; this
skill is the model for tuning it or wiring it by hand.

## The Action

```yaml
# .github/workflows/styleproof.yml
- uses: actions/checkout@v4
- run: npx styleproof-map --restore --sha "${{ github.event.pull_request.base.sha }}" --dir base --base-dir __stylemaps__
- run: npx styleproof-map --restore --sha "${{ github.event.pull_request.head.sha }}" --dir head --base-dir __stylemaps__
- uses: BenSheridanEdwards/StyleProof@v3
  with:
    baseline-dir: __stylemaps__/base
    fresh-dir: __stylemaps__/head
    require-approval: true   # review-gate mode; omit + fail-on-diff:true to certify
```

Restore the two bundles from the `styleproof-maps` store, then hand them to the
Action. If a bundle is missing/incompatible, recapture both sides in the same
pinned environment first (correctness beats a stale cache).

## Two modes — pick per repo

- **Review-gate** (`require-approval: true`): posts a before/after report + an
  **Approve all changes** checkbox; the status is green on no change, red until
  approved. Use when intentional visual changes are normal.
- **Certify** (`fail-on-diff: true`, the default): **any** diff fails the job.
  Use when the whole promise is "output unchanged" (the *Certify a refactor*
  mode in the `styleproof` skill).

Key inputs: `require-approval`, `fail-on-diff`, `status-context` (must match the
approve workflow + branch protection), `baseline-dir`, `fresh-dir`,
`report-branch` (default `styleproof-reports`; the scaffolded workflow prunes a
PR's report folder when it closes). Outputs: `changed`, `report-url`.

In **both** modes the Action also hard-gates an **unacknowledged inventory
removal** (a nav item/route that went unreachable) when the maps carry
inventory — acknowledge intentional removals in `styleproof.inventory.json`
(`{"<key>": "<why>"}`), or opt out with `"gateInventoryRemovals": false` in
`styleproof.config.json`.

## The approve workflow

Copy `example/styleproof-approve.yml` to `.github/workflows/` **on your default
branch** — GitHub only runs `issue_comment` workflows from the default branch, so
the checkbox is inert until it's merged there.

## Blocking without branch protection

A status only *blocks a merge* where a branch-protection rule requires it (needs
GitHub Pro / public repo). On a free private repo, set `{"blocking": true}` in
`styleproof.config.json` to also **fail** the job on unapproved changes → a red
check regardless. It's async: tick **Approve all changes**, then **re-run** the
job so it sees the sign-off.

## Fork & Dependabot — split capture from report

Fork/Dependabot PRs run with a **read-only** token, so a single write-token job
sits `pending` forever. Split it:

- `example/styleproof-capture.yml` — `on: pull_request`, read-only, no secrets;
  builds + captures + uploads maps as an artifact (safe on untrusted code).
- `example/styleproof-report.yml` — `on: workflow_run` from the **default
  branch**, write token; downloads the artifact and does the diff/comment/status
  but **never runs PR code**. PR identity comes from the trusted `workflow_run`
  event, never the artifact (confused-deputy guard).

This is why `workflow_run` beats `pull_request_target`: the latter would hand a
write token + secrets to untrusted code — the exact supply-chain risk StyleProof
helps you catch.

## Skip safely

Skip the **whole** workflow only for changes that can't affect render (docs) via
CI `paths-ignore`. **Never** skip individual surfaces by changed-file guess —
shared CSS/tokens/resets repaint anything, and a missed surface certifies green
unmeasured.

## Next

`styleproof-prepush` makes CI report-only by capturing locally; `styleproof-diff`
/ `styleproof-report` are what the gate runs.
