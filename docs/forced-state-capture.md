# Forced-state capture scope

StyleProof forces `:hover`, `:focus`/`:focus-visible`, and `:active` through Chromium CDP. Each delta remains attributed to the interactive control that was forced, but the changed style may belong to that control, one of its descendants, a sibling, or an ancestor/ancestor descendant selected through `:has(...)`.

## Bounds and incomplete evidence

Forced-state capture discovers the same semantic interactive targets as the existing `INTERACTIVE` selector. Broader nonsemantic target discovery is outside this change. `maxInteractive` still limits how many targets may be forced (800 by default), but it is no longer the primary work bound.

Each resting or forced scan reads a target-first scope capped at 2,000 elements. The target and its descendants are visited first to preserve existing descendant coverage, followed by the rest of the document in DOM order to detect cross-element effects. All targets and states share a deterministic total budget of **32,000 element snapshots per surface**. Once that total is exhausted, capture stops immediately. If a target's scope exceeds 2,000 elements, StyleProof completes that target's three target-first forced reads and then stops rather than repeating known-incomplete document scans for every remaining control.

Any per-scan or aggregate truncation persists `statesSkipped: true`, so the diff treats the forced-state layer as incomplete rather than certified. A control that detaches before or during forcing does the same. Setting `captureStates: false` also persists `statesSkipped: true`; disabling evidence cannot produce a fully certified result. Forced pseudo-state capture requires Chromium CDP, so captures made in Firefox, WebKit, or a browser context without Chromium support retain the base computed-style map but persist `statesSkipped: true` for the unsupported state layer.

The fixed total budget admits the moderate regression fixture (24 controls across 290 elements, 27,840 target/state element snapshots) while bounding the default worst case independently of `maxInteractive`. Baselines stay in the browser context and only deltas cross the CDP boundary. `test/cross-element-state.e2e.spec.ts` exercises sibling and `:has(...)` changes, detached controls, disabled and unsupported state evidence, no-op stability, the 2,000-element fail-closed boundary, all 24 moderate-page cross-element effects, and an 800-control document above 2,000 elements that terminates with incomplete evidence.
