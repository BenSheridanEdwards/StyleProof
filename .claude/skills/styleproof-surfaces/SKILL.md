---
name: styleproof-surfaces
description: Use when declaring which UI states StyleProof should certify — surfaces, open/variant states, live/data states, and popups in defineStyleMapCapture, plus the expected/exclude coverage guard and Next.js route / SPA-nav / component auto-discovery.
---

# StyleProof — declare the surfaces you own

One job: tell StyleProof which states matter. **It can only certify states it
reaches** — a page nobody listed is invisible to the gate (no base map, no head
map, so it silently passes). This is the one thing you own; everything else is
automatic.

## A surface is one UI state

Route, tab, modal-open, dropdown-open, toast-visible, loading, empty, error…
Each `{ key, go, widths?, ignore? }`; `go(page)` drives to a settled state.
**Omit `widths`** and StyleProof sweeps your real `@media` breakpoints.

```ts
import { defineStyleMapCapture, type Surface } from 'styleproof';

const SURFACES: Surface[] = [
  { key: 'landing', go: (p) => p.goto('/') },
  {
    key: 'home',
    go: (p) => p.goto('/'),
    variants: [{ key: 'dialog-open', go: async (p) => {
      await p.getByRole('button', { name: /settings/i }).click();
      await p.getByRole('dialog').waitFor();
    }}],
  },
];
defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR });
```

- **`variants`** — non-live deterministic open states (nav-open, modal-open). The
  base surface still captures; each variant is `<surface>-<variant>`.
- **`liveStates`** — pinned product states (`loading`/`loaded`/`empty`/`error`)
  via a `setup` that mocks the data (`page.route(...)`). Certifies each state on
  both branches instead of one fuzzy moving page.
- **`popups: true`** — auto-click visible safe triggers, capture each opened
  dialog/menu/listbox/popover/toast as `<surface>-popup-XX`.

## The coverage guard — `expected` + `exclude`

Declare your route/view/component universe so a **new uncaptured page fails
loudly** instead of passing green. It emits a static guard test (no browser,
runs in your normal suite):

```ts
defineStyleMapCapture({
  surfaces: SURFACES,
  expected: ROUTES.map((r) => r.id),        // everything StyleProof should cover
  exclude: { checkout: 'auth-gated — fixture pending' },  // key → reason, reviewed opt-outs
  dir: process.env.STYLEMAP_DIR,
});
```

A key in neither `surfaces` nor `exclude` fails the guard; an `exclude` key not
in `expected` (a renamed/removed route) fails too — the opt-out ledger can't rot.
The registry also travels with the captured bundle, so `styleproof-diff` can
state a green's completeness basis at gate time (`styleproof-coverage` skill).

`defineCrawlCapture` takes the same `expected`/`exclude` pair: the crawl
reconciles the **rendered nav** against it, both directions — a new linked route
with no `expected` entry fails, and an `expected` route the nav stopped linking
fails. This runs *inside the capture test* (the link set isn't known until the
page renders), unlike the static spec guard.

## The inventory guard — `inventory: true`

Orthogonal to coverage: harvest each surface's **navigable affordances** (links,
tabs, menu items) into the map, so a nav item or route that goes *unreachable*
on the head gates loudly instead of vanishing between captures. On by default in
`styleproof-init` scaffolds; acknowledge intentional removals in
`styleproof.inventory.json` (`{"<key>": "<why>"}`).

## Let auto-discovery keep the inventory honest

- **Next.js:** `discoverNextRoutes()` wires `surfaces` + `expected` from `app/`+`pages/`.
- **Single-route SPA** (every view is `/?tab=…`): `defineCrawlCapture({ from: '/', match: /\?tab=/ })` — the surface set *is* the rendered nav's `<a href>`s (SVG links count too).
- **Component catalog:** `discoverComponentFiles({ roots: ['src/components'] })` +
  `componentCatalogSurfaces(...)` — fails CI when a component file has no surface.
- **Harvest one-step variants:** `styleproof-variants --base-url … --route /` writes a manifest of controls that actually change computed styles.

## Rule of thumb

A rendered state is a function of **props, data, and input**. Control all three
(mock the data, script the input, mount the component) and every state is
capturable. `styleproof-coverage` names, by class, the ones you haven't yet.

## Next

`styleproof-baseline` to publish the maps; `styleproof-coverage` to prove nothing
is missed.
