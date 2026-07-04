# Inventory guard — the UI can't silently shrink

**Status:** prototype landed (`src/inventory.ts` + tests); gate/report/CLI wiring
spec'd below as a focused follow-up.

## The gap it closes

StyleProof's certification diff is a same-surface, same-key regression check —
*"did surface X change between base and head?"* It is structurally blind to two
high-stakes changes:

1. **A redesign delivered as a new surface beside the old one.** The diff is
   old-vs-old (clean) until the cutover; the new experience sits uncaptured.
2. **A nav item / route / feature that disappears.** The *reachable set* of the UI
   shrinks — an information-architecture change, not a restyle. The pixel diff
   catches it only incidentally (DOM churn on a surviving captured surface, if
   that surface is even captured), and not at all while staged in parallel.

Concretely, from the Fleet HUD (real): a redesign added at `/agents-v5` drops the
**MODEL CONFIG** and **FAULT MAP** nav items. The gate reported *"✓ clean, no
visual approval required"* — a feature-removing change with a green check. That is
the exact failure mode this guard closes.

## The model

Harvest the **navigable inventory** of each captured surface — the user-reachable
affordances (internal route links, `role=tab`, `role=menuitem`, button-only SPA
nav) — keyed stably: `route:<pathname><search>` for links, `<role>:<slug(name)>`
for tabs/menu items/nav buttons (so a tab labelled "MODEL CONFIG" keys as
`nav-button:model-config`, lining up with an app's own view id). Union across a
run into one reachable set, and diff base→head:

- **added** (head-not-base) — a newly-offered affordance. Informational.
- **removed** (base-not-head) — a feature the UI stopped offering. **Gates.**

A removal is a *decision*, not an accident: it fails the gate unless acknowledged
in an `allowRemoved` ledger (`key → reason`), mirroring the `exclude` coverage
ledger. A stale acknowledgement (for a key no longer removed) is flagged too, so
the ledger can't quietly rot.

## Config API (opt-in; advisory → gating)

```ts
defineStyleMapCapture({
  surfaces: SURFACES,
  dir: process.env.STYLEMAP_DIR,
  inventory: true, // harvest the navigable inventory per surface
  allowRemoved: {
    // reasoned, reviewed removals — a decision on the record
    'nav-button:model-config': 'moved into the per-agent dossier — intentional',
  },
});
```

- `inventory: false` (default) — unchanged behaviour; nothing harvested, no new gate.
- `inventory: true` — each map stores `map.inventory`; the diff/report gain an
  **Inventory** section; unexplained removals gate.

## How it fits (integration plan)

- **Capture** (`capture.ts`): when `inventory` is on, run `detectNavigableInventory`
  in-page — exactly like `detectOverlayCandidates` — and store
  `map.inventory: NavigableItem[]` (a new optional field on `StyleMap`, ignored by
  the certification diff, like `overlays`).
- **Diff** (run level): `unionInventory(baseMaps)` vs `unionInventory(headMaps)` →
  `diffInventory` → `auditRemovals(delta, allowRemoved)`.
- **Gate**: unexplained removals take the same path as a visual change — fail in
  certify mode; require approval in review-gate mode (a removed feature is exactly
  the thing a human should sign off).
- **Report**: an **📐 Inventory** section — *removed* (flagged, with its
  acknowledgement or a "needs a reason" prompt) and *added* (listed).
- **CLI/env**: `styleproof-diff`/`-report` surface the section; `allowRemoved` reads
  from the spec (and, for CI without editing the spec, an optional
  `styleproof.inventory.json`).

## What it catches — and its honest boundary

**Catches:**

- A nav item / route / menu item that disappears from the captured surfaces
  (Model Config) — as a first-class, gating signal, not an incidental pixel diff.
- A parallel new route **if it is captured** — its link/tab enters the head
  inventory, so the redesign is on the record before any cutover.
- A replacement **cutover done in-place** — the old→new inventory diff fires.

**Boundary (stated honestly):** it can only see surfaces that are captured. A
parallel route that is *never* captured is still invisible — so `expected` (the
route coverage guard) remains the first line, and the inventory guard is the
second. Together they compose:

> `expected` says *"you didn't capture a route you should have."*
> the inventory guard says *"the routes you DID capture stopped offering something."*

That composition is what makes the gate a **source of truth** for the reachable
UI, not just for the pixels of the surfaces you remembered to look at.

## Prototype status

Built and tested in this change:

- `src/inventory.ts` — `detectNavigableInventory` (in-page harvest) +
  `unionInventory` / `diffInventory` / `auditRemovals` (pure, unit-testable).
- `test/inventory.test.mjs` — 6 unit tests, including the Fleet Model-Config
  removal end to end (removed surfaces, the failing guard, the acknowledgement
  ledger, stale-allowance detection, parallel-route staging, union dedup).
- `test/inventory.e2e.spec.ts` — 2 Playwright tests proving the in-page harvest on
  rendered pages (nav-button removal; `role=tab` + internal route links, cross-origin dropped).

Not yet wired (the follow-up): the `inventory` capture option, `StyleMap.inventory`,
the diff/report/gate surfacing, and the CLI/action flags — all specified above.
