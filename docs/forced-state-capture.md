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
| `placeholder-shown` | Textareas and placeholder-supporting input types (text, search, url, tel, email, password, number, or omitted/invalid type interpreted as text) with a non-empty placeholder and value, not already matching `:placeholder-shown` |

Hidden inputs are excluded from every forced layer. Options and fieldsets are not added to target discovery. Styles selected by a
forced control can still affect them. Under `forcedStateScope: 'stylesheet'`, all
six pseudo-classes participate in scope analysis: sibling selectors widen to the
parent subtree and relational `:has(...)` rules fall back to the document.

## Layer compatibility

Each new map records `stateLayers`, including layers with no applicable controls
or no deltas. A missing field means exactly `hover`, `focus`, and `active`.
The diff compares each layer only when both maps captured it. A one-sided layer
produces a surface-level availability diagnostic, no element findings, and counts
the surface once in `statesUncertified`. Matching form layers omitted on both maps
because of their allowance or an unavailable shared baseline do not reduce legacy
certification. These omissions are explicit in `stateLayerOmissions` as
`form-scan-work` or `shared-baseline-unavailable`; they do not claim the form layer
was compared. A legacy counterpart without `stateLayers` is known to predate form
capture and does not need an omission marker. Read failures, resting drift, missing legacy layers, and unmarked
omissions remain uncertified. Two legacy maps retain their previous comparison. Unlisted custom state names
keep their previous comparison behaviour; only unmatched captured-layer names
are excluded.
Recapture both sides to compare the new layers against a legacy baseline.

This is an additive optional map field: existing map JSON and manifest formats
remain readable. The manifest version and same-environment compatibility key are
unchanged; browser/runtime compatibility checks still apply independently.

## Bounds and incomplete evidence

Forced-state capture discovers the same semantic interactive targets as the existing `INTERACTIVE` selector. Broader nonsemantic target discovery is outside this change. `maxInteractive` still limits how many targets may be forced (800 by default), but it is no longer the primary work bound.

Each resting or forced scan reads a target-first scope capped at 2,000 elements. The target and its descendants are visited first to preserve existing descendant coverage, followed by the rest of the document in DOM order to detect cross-element effects. Each sweep has its own deterministic allowance of **32,000 element snapshots per surface**: one for hover/focus/active, and one for form states. Once a sweep exhausts its allowance, it stops immediately. If a target's scope exceeds 2,000 elements, StyleProof completes that target's three legacy target-first forced reads and then stops rather than repeating known-incomplete document scans for every remaining control.

The legacy hover/focus/active sweep keeps its 32,000-snapshot allowance.
Form states have a separate 32,000-snapshot allowance, configured by
`maxFormStateScanWork` (the same positive-safe-integer validation and runner,
surface, and variant inheritance as the legacy limit). Neither consumes the
other's allowance. Each control qualifies for at most two form layers: checked
and disabled, or disabled and placeholder-shown. With one baseline charge per
control, form work is at most three scans versus the legacy sweep's four over
the same targets and scope. Thus equal allowances preserve completeness whenever
the legacy sweep fits under those conditions.

Controls resolve once and the form sweep reuses shared resting counts/baselines.
Its final reset is settled by the next read, with one final barrier. Stylesheets
are analysed once to derive both scopes, with at most one fallback warning.
An unfinished form sweep discards all form deltas and Typed OM proof and omits
those layers from `stateLayers`. The resting baseline is checked again afterward;
drift also discards all form evidence with a warning. No new form work changes
`statesSkipped` for a complete legacy sweep. Pages without applicable form
controls perform no additional computed-style reads.
If no shared form baseline can be saved, no form forcing runs. Resource warnings
name `maxFormStateScanWork` as the setting to increase for broader form scopes.

`stateTargets` records the owners eligible at rest for each form layer. The diff
suppresses a form finding for an owner that qualified on only one side; its
resting styles still compare. Path correspondence remaps these owner lists too.
Screenshots always write all captured layer names, including a resting image
when no control qualifies, so applicability changes cannot create a one-sided
pixel layer. This adds three screenshot files to the legacy three; an inapplicable
form layer copies the resting PNG rather than taking another full-page screenshot.
Selective reuse and capture-output cleanup recognise every name in `STATE_LAYER_NAMES`.

Any per-scan or aggregate truncation during the legacy sweep persists `statesSkipped: true`, so the diff treats the forced-state layer as incomplete rather than certified. A control that detaches before or during forcing does the same. Setting `captureStates: false` also persists `statesSkipped: true`; disabling evidence cannot produce a fully certified result. Forced pseudo-state capture requires Chromium CDP, so captures made in Firefox, WebKit, or a browser context without Chromium support retain the base computed-style map but persist `statesSkipped: true` for the unsupported state layer.

Alongside each forced read, the capture records the CSS Typed OM computed values of the four horizontal margins (`margin-left`, `margin-right`, `margin-inline-start`, `margin-inline-end`) in the optional `stateComputedValueStyle` field, keyed like `states` (owner → state → target, never `::before`/`::after`). A target is recorded when it appears in the state's delta or when any of those computed values differs from rest; an absent target kept its resting computed margins. The capture compares against the state layer's own resting snapshot, but the diff reads an absent target's rest from the element layer's earlier `computedValueStyle`; this assumes both reads see the same settled page, and a margin still changing between them would normally be caught as volatile. Form proof is collected separately and merged only after a complete, stable sweep. Missing form Typed OM never erases legacy proof or becomes an empty proof, and legacy proof cannot stand in for an unproven form state. A `statesSkipped` map, or one captured without `computedStyleMap`, has no field and is treated as legacy. The diff uses proven entries only to drop `auto` margins that echo a state's width change (#917).

The fixed legacy budget admits the moderate regression fixture (24 controls across 290 elements, 27,840 target/state element snapshots) while bounding the default worst case independently of `maxInteractive`. Baselines stay in the browser context and only deltas cross the CDP boundary. `test/cross-element-state.e2e.spec.ts` exercises sibling and `:has(...)` changes, detached controls, disabled and unsupported state evidence, no-op stability, the 2,000-element fail-closed boundary, all 24 moderate-page cross-element effects, and an 800-control document above 2,000 elements that terminates with incomplete evidence.
