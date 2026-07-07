---
name: styleproof-coverage
description: Use when proving StyleProof missed no surface or state — the exhaustive --crawl with --require-full-coverage, the expected coverage guard, and reaching click-gated, input-gated, and data states via --setup, data-states, variants, and liveStates.
---

# StyleProof — prove nothing was missed

One job: close the gap between "all my captures passed" and "everything is
captured." The captures can't catch a capture that was never taken — this skill
is the two ways StyleProof makes missing coverage loud.

## 1. Crawl an interactive surface — `--crawl`

A design/app is mostly *behind clicks*. `--crawl` drives every non-destructive
control, keeps whatever opens a structurally-new surface, and recurses:

```bash
styleproof-capture https://example.com --crawl --out design
styleproof-diff design .styleproof/maps/current
```

- **Exhaustive by default** — stops when nothing is left to drive, not at a
  budget. `--max-depth`/`--max-actions`/`--max-states` are throttles only.
- Works **in place** (a no-op click is free; only a state-changer pays a reset,
  verified by fingerprint so children aren't misattributed). Self-settling for
  async apps. `--workers <n>` parallel (default 4); `--workers 1` for
  byte-stable dup-key attribution.
- **Never clicks destructive-looking controls** (delete/deploy/pay/revoke) —
  those states need a spec.

## 2. Prove full coverage — `--require-full-coverage` / `expected`

Two independent guards; use both:

- **Crawl coverage:** after a crawl, StyleProof compares every class the page's
  own CSSOM defines against the classes actually rendered, and prints the
  residue. `--require-full-coverage` turns any residue into **exit 4**; an
  unreadable cross-origin sheet also fails rather than pass unverified.
  `--until-covered` stops the crawl early once every class has rendered — the
  fast coverage check, vs the exhaustive default sweep. What's left is either
  dead CSS (delete it) or an unreached state (drive it).
- **Spec coverage:** `expected` in `defineStyleMapCapture` (the
  `styleproof-surfaces` skill) fails a static guard when a declared route/view/
  component has no surface. The registry also travels with the map bundle as a
  ledger (`styleproof-coverage.json`), so the gate states a green's
  completeness basis — the `styleproof-diff` skill owns that verdict contract.

## 3. Reach gated states

| State | Reached by |
|---|---|
| Click-opened (modals, drawers, tabs) | crawl, automatically |
| Loading / error data states | crawl — automatic data-states (`--no-data-states` to skip) |
| Login / unlock / typed input | `--setup <file>` |
| `:hover`/`:focus`/`:active` | forced-state layer of every capture |
| Empty/partial/streaming data | spec `liveStates`/`variants` with fixtures |
| Destructive-gated, drag-drop, keyboard | a spec driving them explicitly |
| Unmounted components | a component catalog page |

`--setup` runs after **every** fresh navigation so each reset re-establishes the
gate; `${ENV_VAR}` in values is interpolated at load time (credentials never hit
the file or the maps). A failed non-`optional` step aborts loudly.

## Gotchas from a real 100%-coverage push

- **Crawl the STANDALONE design for coverage, never the built route.** A built
  app route bundles the whole app's CSS, so the CSSOM shows thousands of classes
  that never render there and coverage can never reach 100%. The clean number
  comes from the design's own page.
- **Post-decision states** (a resolved item, a revoked credential) can't be
  reached by a passive crawl of a static snapshot even with `--setup` — a static
  export has no handlers. Certify those by an E2E that drives the transition, and
  count the class as behaviour-covered.

## Next

Feeds `styleproof-diff` (the gate); `styleproof-surfaces` owns the `expected`
registry this proves against.
