# ADR 0005: Commit statuses over the Checks API for the review gate

- **Status:** accepted (2026-09-18)
- **Date:** 2026-09-18
- **Depends on:** #477 approval binding, #587 artifact publication, #702 artifact digest binding

## Context

The StyleProof gate is a commit status written by the Action via
`repos.createCommitStatus` (`context: <status-context>`, default `StyleProof`)
and flipped by the approval workflow when a write-access reviewer ticks the
comment box. The approval workflow reads it back with
`listCommitStatusesForRef` and requires the newest `StyleProof` status to be
canonical: created by `github-actions[bot]`, `state: failure`, an eligible
pending-review description, and a `target_url` matching the published report.
Issue #707 asked whether this surface should migrate to the Checks API
(`checks.create` / `checkRuns.listForRef`).

What the Checks API would buy:

- diff-anchored annotations via `output.annotations`;
- a "re-run" affordance and richer conclusions (`neutral`, `skipped`,
  `timed_out`, `action_required`);
- check-run attribution to the GitHub Actions _app_ rather than a bot user,
  and `external_id`/check-suite provenance that could carry the run receipt.

Why the migration is not a mechanical swap:

- **Check-run writes are GitHub-App-only.** GitHub documents that OAuth apps
  and authenticated users cannot create or update check runs; `GITHUB_TOKEN`
  works because it authenticates as the GitHub Actions app. The approve
  workflow's `secrets.token` contract today accepts a PAT with
  `statuses: write` — under Checks, every PAT-based caller breaks and every
  caller's permission contract changes (`statuses: write` → `checks: write`).
- **Dual-write is a trap, not a bridge.** GitHub requires _both_ a check and
  a commit status with the same name to pass when that name is required, so a
  transition window that writes both surfaces would gate merges on two
  verdicts that can disagree — or double the fail-closed surface to keep
  synchronized forever.
- **Creator-trust must be re-derived.** `creator.login ===
'github-actions[bot]'` has no direct equivalent; the canonical check would
  verify `check_run.app.slug === 'github-actions'` plus the pending/eligible
  conclusion and `details_url`. Equivalent strength — any in-repo workflow
  with the right permission can still forge either surface — but it is a
  rewrite of three sites (Action gate readback, Action status write, approve
  readback/write) with new failure modes.
- **The "re-run" button does nothing without a handler.** A manually created
  check run re-runs only when a workflow listens on
  `check_run`/`check_suite` `rerequested` events — new workflow surface, not
  a free UX upgrade.
- **Branch protection already offers the app-binding win.** Required status
  checks can pin an expected source app, and a required `StyleProof` entry is
  satisfied by a check run _or_ a commit status of that name — adopters can
  bind the gate to the Actions app today without any migration.

## Decision

Keep commit statuses. Do not migrate the gate to the Checks API.

The marquee Checks benefit — diff annotations — does not fit the evidence
shape: StyleProof findings are computed styles of rendered surfaces captured
in a real browser, not source lines, so there is no honest `path:line` anchor
to annotate. The report artifact and job summary are the review surface, and
the approval comment already names remediation. `action_required` is a nicer
conclusion than `failure` for "needs sign-off", and check-suite provenance is
a modest upgrade over the receipt already embedded in `target_url` and the
comment — neither pays for breaking every PAT-based approve workflow,
rewriting creator-trust in three places, and carrying a second gate surface.

Available today without migration:

- adopters can pin the expected source app on the required `StyleProof`
  check in branch protection;
- if re-run UX is ever wanted, a `check_run rerequested` or
  `workflow_dispatch` handler is a smaller step than migrating the gate.

## Revisit when

- GitHub deprecates or degrades commit statuses;
- adopters ask for diff-anchored annotations _and_ a reliable source-line
  mapping exists for computed-style findings;
- a second storage/notification surface makes a `gate-surface: checks`
  opt-in input worth its own maintenance, tested end-to-end against the same
  fail-closed contract the status path carries today.
