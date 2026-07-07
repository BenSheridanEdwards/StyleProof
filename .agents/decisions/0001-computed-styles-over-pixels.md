# 1. Compare computed styles, not pixels

- Status: accepted (recorded retrospectively — this decision predates this ADR;
  it is documented here to make the existing choice explicit).

## Context

A PR gate for visual CSS change can compare rendered output in two ways: pixel
screenshots, or the browser's computed styles. Pixel diffs are noisy — font
rendering, antialiasing, sub-pixel layout, and platform rasterisation differ
between environments and produce false positives that erode trust in the gate.
They also tell a reviewer *that* pixels moved, not *what* CSS changed. StyleProof
needs a signal a reviewer can act on and a CI gate that is stable across runners.

## Decision

Compare the browser's **computed styles** — resolved CSS longhands,
pseudo-elements, layout boxes, motion longhands, and forced
`:hover`/`:focus`/`:active` deltas — captured via a real browser
(`src/capture.ts`, using Playwright/CDP). Screenshots still appear in the report
so humans can see the change, but they are evidence for the reader, not the
comparison the gate runs on. The README states this boundary plainly:
"StyleProof is not a screenshot diff."

## Consequences

- Findings are precise and actionable: the report names the element and the exact
  property that changed.
- The gate is deterministic across environments — no antialiasing/rasterisation
  flake — which makes it safe as a required CI check.
- StyleProof can only certify states it can *reach* and capture; a state that is
  never opened is never compared. Hence the `expected`/coverage guard, which fails
  a registered-but-uncaptured surface instead of passing silently.
- Playwright is a peer dependency: the browser engine is required, and adopters
  control its version.
