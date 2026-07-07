# Inventory guard — the UI can't silently shrink

**Status (3.8.0):** wired end to end, and on by default from `styleproof-init`.
`captureStyleMap(page, { inventory: true })` harvests into `StyleMap.inventory`, the
spec-level `defineStyleMapCapture({ inventory: true })` / `defineCrawlCapture({ inventory:
true })` option forwards it (so a spec turns the guard on with one line — 3.8.0), and
`styleproof-diff` unions both sides, diffs the navigable set, and **exits 1 on an
unacknowledged removal**. Acknowledge intentional removals in `styleproof.inventory.json`
(`{"<key>": "<why>"}`; override the path with `STYLEPROOF_INVENTORY`). Remaining follow-up:
an **📐 Inventory** section in the HTML report.

## The gap it closes

StyleProof's certification diff is a same-surface, same-key regression check —
_"did surface X change between base and head?"_ It is structurally blind to two
high-stakes changes:

1. **A redesign delivered as a new surface beside the old one.** The diff is
   old-vs-old (clean) until the cutover; the new experience sits uncaptured.
2. **A nav item / route / feature that disappears.** The _reachable set_ of the UI
   shrinks — an information-architecture change, not a restyle. The pixel diff
   catches it only incidentally (DOM churn on a surviving captured surface, if
   that surface is even captured), and not at all while staged in parallel.

Concretely, from a real dashboard app: a redesign added at `/agents-v5` drops the
**MODEL CONFIG** and **FAULT MAP** nav items. The gate reported _"✓ clean, no
visual approval required"_ — a feature-removing change with a green check. That is
the exact failure mode this guard closes.

## The model

Harvest the **navigable inventory** of each captured surface — the user-reachable
affordances (internal route links, `role=tab`, `role=menuitem`, button-only SPA
nav) — **keyed by the most stable identity each one exposes**, so an incidental
wobble in the label (a live count badge, a re-word) never fakes a removed+added:

- **links** → `route:<pathname><search>` — the href, never the text.
- **tabs / menu items / nav buttons** → `<role>:#<stable-id>` when the element
  carries a developer-authored identity (`data-testid`, else a non-generated `id`
  or `aria-controls`); otherwise `<role>:<slug(name)>` from the label (so a tab
  labelled "MODEL CONFIG" still keys as `nav-button:model-config`).

Framework-generated ids (React `useId` `:r0:`, Headless UI `headlessui-…`, Radix,
hashes) are rejected — keying on them would _add_ churn — so those fall back to the
label slug. The fallback's failure mode is safe by construction: a label wobble
becomes a **surfaced** removed+added (a red a reviewer sees and acknowledges),
never a hidden real removal. Give a nav item a `data-testid` (or a stable `id`)
to key it immune to its own text. Union across a run into one reachable set, and
diff base→head:

- **added** (head-not-base) — a newly-offered affordance. Informational.
- **removed** (base-not-head) — a feature the UI stopped offering. **Gates.**

A removal is a _decision_, not an accident: it fails the gate unless acknowledged
in an `allowRemoved` ledger (`key → reason`), mirroring the `exclude` coverage
ledger. A stale acknowledgement (for a key no longer removed) is flagged too, so
the ledger can't quietly rot.

## Using it (opt-in) — wired today

Two steps:

1. **Harvest** the inventory into the maps — one line in your spec (a fresh
   `styleproof-init` turns this on for you):

   ```ts
   defineStyleMapCapture({ surfaces, inventory: true, dir: process.env.STYLEMAP_DIR });
   // a crawl spec:   defineCrawlCapture({ from: '/', inventory: true, dir: ... });
   // or the raw call: await captureStyleMap(page, { inventory: true });
   ```

2. **Gate** in CI — `styleproof-diff` reads both sides' `inventory` and exits 1 on an
   unacknowledged removal. Record intentional removals in `styleproof.inventory.json`
   at the repo root (or point `$STYLEPROOF_INVENTORY` at another path):

   ```json
   {
     "nav-button:model-config": "moved into the per-agent dossier — intentional"
   }
   ```

- `inventory` off (default) — nothing harvested; `styleproof-diff` is byte-for-byte
  unchanged.
- `inventory: true` — each map stores `map.inventory`; `styleproof-diff` prints the 📐
  Inventory section and blocks on unexplained removals.

## How it fits

- **Capture** (`capture.ts`): with `inventory: true`, `collectNavAffordances` runs
  in-page — like `detectOverlayCandidates` — and stores `map.inventory:
NavigableItem[]` (an optional `StyleMap` field, ignored by the certification diff,
  like `overlays`).
- **Diff** (run level, `styleproof-diff`): `unionInventory(baseMaps)` vs
  `unionInventory(headMaps)` → `diffInventory` → `auditRemovals(delta, allowRemoved)`.
- **Gate**: an unacknowledged removal exits **1** — the same blocking path as a visual
  change (a removed feature is exactly the thing a human should sign off).
- **CLI/env**: `styleproof-diff` prints the 📐 Inventory section and reads
  `allowRemoved` from `styleproof.inventory.json` (or `$STYLEPROOF_INVENTORY`) — no
  spec edit needed in CI.
- **Report** (follow-up): an 📐 Inventory section in the HTML report — _removed_
  (flagged, with its acknowledgement or a "needs a reason" prompt) and _added_ (listed).

## What it catches — and its honest boundary

**Catches:**

- A nav item / route / menu item that disappears from the captured surfaces
  (Model Config) — as a first-class, gating signal, not an incidental pixel diff.
- A parallel new route **if it is captured** — its link/tab enters the head
  inventory, so the redesign is on the record before any cutover.
- A replacement **cutover done in-place** — the old→new inventory diff fires.

**Boundary (stated honestly):** it can only see surfaces that are captured. A
parallel route that is _never_ captured is still invisible — so `expected` (the
route coverage guard) remains the first line, and the inventory guard is the
second. Together they compose:

> `expected` says _"you didn't capture a route you should have."_
> the inventory guard says _"the routes you DID capture stopped offering something."_

That composition is what makes the gate a **source of truth** for the reachable
UI, not just for the pixels of the surfaces you remembered to look at.

## What's wired vs. follow-up

Wired and tested in this change:

- `src/inventory.ts` — `collectNavAffordances` (in-page harvest) + `classifyInventory`
  / `unionInventory` / `diffInventory` / `auditRemovals` / `auditRunInventory` (pure,
  unit-testable).
- `src/capture.ts` — `captureStyleMap({ inventory: true })` harvests into
  `StyleMap.inventory` (opt-in; off by default, ignored by the certification diff).
- `src/runner.ts` (3.8.0) — `defineStyleMapCapture` / `defineCrawlCapture` forward the
  `inventory` option to the capture, so a spec turns the guard on with one line;
  `styleproof-init` sets it on by default.
- `bin/styleproof-diff.mjs` — reads both sides' `inventory`, runs `auditRunInventory`
  against the `styleproof.inventory.json` ledger, prints the 📐 Inventory section, and
  **folds unacknowledged removals into exit code 1**.
- `test/inventory.test.mjs` — 6 unit tests (a Model-Config removal, the failing
  guard, the acknowledgement ledger, stale-allowance detection, parallel-route
  staging, union dedup).
- `test/inventory-cli.test.mjs` — 3 tests proving the CLI actually gates: exit 1 on an
  unacknowledged removal, exit 0 once acknowledged, exit 0 when unchanged.
- `test/inventory.e2e.spec.ts` — Playwright harvest on rendered pages (nav-button
  removal; `role=tab` + internal route links, cross-origin dropped; capture path).

Follow-up (the one remaining piece): an 📐 Inventory section in the HTML report, so
removals are visible in the rendered report and not only in the `styleproof-diff` output.
