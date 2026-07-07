# 2. Keep the core framework-agnostic; make discovery opt-in

- Status: accepted (recorded retrospectively — this decision predates this ADR;
  it is documented here to make the existing choice explicit).

## Context

Apps are built on many frameworks and styling systems (Tailwind, CSS Modules,
inline styles, design tokens, plain CSS). A visual-change gate could special-case
one framework's routing and component model. That would make it easy for that one
ecosystem and useless for everyone else, and it would couple the gate to a moving
target (a framework's internal conventions). StyleProof's value — comparing what
the browser actually rendered — is inherently framework-neutral: it reads
computed styles from the DOM, which every framework produces.

## Decision

Keep the core capture/diff/report pipeline framework-agnostic. It operates on
surfaces and computed styles, and works with "any styling system" (README). Route
and state discovery are **opt-in helpers layered on top**, not the core: Next.js
route discovery (`discoverNextRoutes`), link crawling (`crawlAndCapture`),
component-catalog discovery (`discoverComponentFiles`), and variant harvesting
(`harvestStyleVariants`). What matters — which surfaces and states to certify —
is owned by the adopter via the spec API; nothing discovers UI states for you.

## Consequences

- The tool works for any framework out of the box; framework support is additive,
  never a fork of the core.
- New public API stays opt-in and backward-compatible, so existing adopters'
  specs keep passing across releases.
- The adopter owns completeness: the `expected`/coverage guard exists precisely
  because the core cannot know an app's full state universe on its own.
- Playwright is the one hard runtime coupling (the browser engine), kept as a peer
  dependency so it is explicit and version-controlled by the adopter.
