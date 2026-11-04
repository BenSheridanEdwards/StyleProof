# Forced-state capture scope

StyleProof forces `:hover`, `:focus`/`:focus-visible`, `:active`, `:checked`, `:disabled`, and `:placeholder-shown` through Chromium CDP. Each delta remains attributed to the interactive control that was forced, but the changed style may belong to that control, one of its descendants, a sibling, or an ancestor/ancestor descendant selected through `:has(...)`.

## Applicable form layers

Discovery still runs once through `markInteractiveElements` and `INTERACTIVE`.
Applicability is recorded before any state is forced, and the same metadata filters
computed-style reads and state screenshots. No attributes or values are changed.

| Layer | Targets forced only when false at rest |
| --- | --- |
| `checked` | Unchecked checkbox and radio inputs |
| `disabled` | Buttons, inputs, selects, and textareas that do not match `:disabled` (including inherited fieldset disability) |
| `placeholder-shown` | Inputs and textareas with a non-empty placeholder and a value, not already matching `:placeholder-shown` |

Options and fieldsets are not added to target discovery. Styles selected by a
forced control can still affect them. Under `forcedStateScope: 'stylesheet'`, all
six pseudo-classes participate in scope analysis: sibling selectors widen to the
parent subtree and relational `:has(...)` rules fall back to the document.

## Layer compatibility

Each new map records `stateLayers`, including layers with no applicable controls
or no deltas. A missing field means exactly `hover`, `focus`, and `active`.
The diff compares each layer only when both maps captured it. A one-sided layer
produces a surface-level availability diagnostic, no element findings, and counts
the surface once in `statesUncertified`. Two current maps missing a supported
layer are also uncertified. Two legacy maps retain their previous comparison.
Recapture both sides to compare the new layers against a legacy baseline.

This is an additive optional map field: existing map JSON and manifest formats
remain readable. The manifest version and same-environment compatibility key are
unchanged; browser/runtime compatibility checks still apply independently.

## Bounds and incomplete evidence

Forced-state capture discovers the same semantic interactive targets as the existing `INTERACTIVE` selector. Broader nonsemantic target discovery is outside this change. `maxInteractive` still limits how many targets may be forced (800 by default), but it is no longer the primary work bound.

Each resting or forced scan reads a target-first scope capped at 2,000 elements. The target and its descendants are visited first to preserve existing descendant coverage, followed by the rest of the document in DOM order to detect cross-element effects. All targets and states share a deterministic total budget of **32,000 element snapshots per surface**. Once that total is exhausted, capture stops immediately. If a target's scope exceeds 2,000 elements, StyleProof completes that target's three legacy target-first forced reads and then stops rather than repeating known-incomplete document scans for every remaining control.

The legacy hover/focus/active sweep runs first with its existing read order and
budget and its original stylesheet scope analysis. Form selectors widen only
the later form sweep, preserving legacy coverage on pages with relational form rules.
Form layers then consume the remaining shared budget, one layer at a
time. A form layer that cannot finish is omitted from `stateLayers` and its
partial deltas are discarded, making it uncertified without newly setting
`statesSkipped`. Raise the existing limits when full form coverage needs more
work. Pages without applicable form controls perform no additional reads.

Any per-scan or aggregate truncation during the legacy sweep persists `statesSkipped: true`, so the diff treats the forced-state layer as incomplete rather than certified. A control that detaches before or during forcing does the same. Setting `captureStates: false` also persists `statesSkipped: true`; disabling evidence cannot produce a fully certified result. Forced pseudo-state capture requires Chromium CDP, so captures made in Firefox, WebKit, or a browser context without Chromium support retain the base computed-style map but persist `statesSkipped: true` for the unsupported state layer.

Alongside each forced read, the capture records the CSS Typed OM computed values of the four horizontal margins (`margin-left`, `margin-right`, `margin-inline-start`, `margin-inline-end`) in the optional `stateComputedValueStyle` field, keyed like `states` (owner → state → target, never `::before`/`::after`). A target is recorded when it appears in the state's delta or when any of those computed values differs from rest; an absent target kept its resting computed margins. The capture compares against the state layer's own resting snapshot, but the diff reads an absent target's rest from the element layer's earlier `computedValueStyle`; this assumes both reads see the same settled page, and a margin still changing between them would normally be caught as volatile. The field is persisted only when the forced-state layer completed and Typed OM was available for every read, so a `statesSkipped` map, or one captured without `computedStyleMap`, has no field and is treated as legacy. The diff uses it only to drop `auto` margins that echo a state's width change (#917).

The fixed total budget admits the moderate regression fixture (24 controls across 290 elements, 27,840 target/state element snapshots) while bounding the default worst case independently of `maxInteractive`. Baselines stay in the browser context and only deltas cross the CDP boundary. `test/cross-element-state.e2e.spec.ts` exercises sibling and `:has(...)` changes, detached controls, disabled and unsupported state evidence, no-op stability, the 2,000-element fail-closed boundary, all 24 moderate-page cross-element effects, and an 800-control document above 2,000 elements that terminates with incomplete evidence.
