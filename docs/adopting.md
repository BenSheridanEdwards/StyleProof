# Adopting StyleProof — the rollout playbook

Two decisions decide whether the gate is trustworthy or just noisy: **where you
capture** and **how you pin the data**. Get them right per repo and StyleProof is
reliable from day one. Both come down to one invariant: **base and head must see
the same environment and the same inputs** — everything else StyleProof already
handles, and where it can't, it fails loudly rather than lie.

## 1. Pick the capture model — keep both sides in the same environment

Computed styles resolve differently across Chromium builds and installed fonts,
so base and head only compare when captured in the **same** runtime. StyleProof
enforces this — it stamps a compatibility key and recaptures on a mismatch — but
you avoid the whole class of friction by choosing the model that fits *who*
captures:

| Situation | Model | Why |
|---|---|---|
| Captures run on **uniform runners** (a CI fleet / identical agents) | **Committed-map / pre-push** — capture at pre-push, CI restores + browserless-diffs | Fast (CI is report-only), and every capture is the same environment |
| **Humans might capture from their own laptops** | **Capture both in CI** (the fork-split `capture` + `report` workflows) | Base and head are always the same CI Chromium — a dev's local Chromium never pollutes a shared baseline |

**Never let a varied local environment pre-push into a shared baseline.** That is
exactly how you manufacture phantom *serialization* diffs (`0% 0%` ↔ `0px 0px`, a
gradient re-canonicalized) that read as changes on a PR that touched no CSS — and
phantom diffs at scale are how a gate loses people's trust.

## 2. Pin the data — resilient, but only as far as you control the source

A style diff only means something if both sides saw the **same inputs**.
StyleProof absorbs most of the drift automatically:

- **client fetches** → record/replay (base records `**/api/**`, head replays it);
- **time-derived styling** → frozen clock (`Date.now()`/`new Date()` pinned);
- **tickers / live regions** → auto-detected as still-moving and excluded;
- **the proof it worked** → **self-check**: each surface is captured *twice* and
  the run *fails* if they differ, so a leak surfaces as a named
  "non-deterministic capture" error, never as a phantom diff on a PR.

What it **cannot** mock is **server-side live state** — data your server reads and
renders (feature flags, a live snapshot, per-request state). Replay covers what
the page *fetches*, not what the server *renders*. You pin that at the source:

- serve the app against **pinned fixtures** for the capture (a seeded DB, a
  fixture data file, a mock data layer);
- route-mock the client fetches the app makes;
- freeze any per-request source of variation.

**Self-check is the acceptance test.** If the environment isn't deterministic,
self-check *fails* — it is telling you the data isn't pinned yet. A green
self-check on a repeated capture of the same commit is proof the environment is
stable enough to trust the gate. You don't guess; the tool tells you.

## Reference: the Fleet HUD (hardest case, captures clean)

Fleet renders almost entirely live data — agent statuses, probe snapshots,
timestamps — and still captures deterministically. The shape to copy:

- **server fixtures** — the capture serves the app with `FLEET_PROBES`,
  `FLEET_STATE_DIR` (a throwaway copy so the server's own writes never dirty the
  tracked fixtures), `FLEET_SESSION_CONTEXT`, `FLEET_AGENTS_ROOT`, all pointed at
  `tests/fixtures/`;
- **client route-mocking** — the spec fulfils each view's data routes with
  per-view fixtures;
- **a fixed clock** for time-derived styling;
- **self-check on**, which is *why* the captures are known-deterministic.

For any live-data app: **pin the server, mock the client, freeze the clock, and
let self-check certify it's stable.**

## Pre-adoption checklist

- [ ] `styleproof-init` run; surfaces declared, `expected` coverage guard wired.
- [ ] Capture model chosen (table above) and the matching workflow(s) in place.
- [ ] Data pinned: server fixtures + client route-mocks + frozen clock.
- [ ] **Self-check green** on a repeated capture of the same commit — environment proven stable.
- [ ] Base baseline captured and published to `styleproof-maps`.
- [ ] Gate wired (review-gate or certify); approve workflow committed on the default branch.
- [ ] One intentional CSS change tried end-to-end — the report names it, approval clears it.
