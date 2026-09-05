# Forced-state capture scope

StyleProof forces `:hover`, `:focus`/`:focus-visible`, and `:active` through Chromium CDP. Each delta remains attributed to the interactive control that was forced, but the changed style may belong to that control, one of its descendants, a sibling, or an ancestor/ancestor descendant selected through `:has(...)`.

## Bounds and incomplete evidence

Forced-state capture discovers the same semantic interactive targets as the existing `INTERACTIVE` selector. Broader nonsemantic target discovery is outside this change. `maxInteractive` still limits how many targets are forced (800 by default).

For each target and state, computed styles are read from a target-first scope capped at 2,000 elements. The target and its descendants are visited first to preserve existing descendant coverage, followed by the rest of the document in DOM order to detect cross-element effects. If eligible content exceeds that bound, `statesSkipped: true` is persisted and the diff treats the forced-state layer as incomplete rather than certified. A control that detaches before or during forcing also sets `statesSkipped: true`.

The resulting upper bound is proportional to `min(interactive targets, maxInteractive) × (1 resting + 3 forced scans) × 2,000 elements`. Baselines stay in the browser context and only deltas cross the CDP boundary. `test/cross-element-state.e2e.spec.ts` exercises sibling and `:has(...)` changes, detached controls, no-op stability, the 2,000-element fail-closed boundary, and a moderate multi-control browser timing budget.
