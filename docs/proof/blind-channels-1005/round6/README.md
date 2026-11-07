# Round 6 proof — liveness before the freeze lifts

Runtime source: `86fd7435f641a2122675f6841b5bc851033fb8ca`. Final probes import the compiled artifact bound by
`build-binding.json`. Later changes are proof/documentation only. Full raw logs,
probe inputs, native frames, maps and reports are archived at
`styleproof-1005-round6-proof`.

The rule follows the final Review r6 revision, which replaced the earlier
context-free-value proposal. There is no token classifier or ancestor dependency
walk. With `stabilize:false`, any running effect or paused active interval in the
resting document holds every keyframe body unknown, including absolute values,
the consumer's own effect, pseudo-elements, siblings and engine-implied inputs.
Initial motion is retained even if freezing cancels or finishes it. Missing
liveness evidence also holds unknown. Finished, idle, before-interval and
paused-at-end effects do not count as in progress.

Default mode samples the frozen document before lifting the freeze. Recreated CSS
animations/transitions are never used as liveness evidence. Genuine surviving
effects, including Web Animations and inline-important CSS that the freeze cannot
cancel, hold bodies unknown. No animation pause/play/currentTime mutation was
added. The optional property-aware N3 optimization is deferred: surviving inputs
are treated conservatively. Default capture with channels off remains unchanged.

Red: QA self-em, self-currentColor and sibling-cqw fail on 7a16ae572; the unchanged
nothing-running control passes (3 failed, 1 passed). The same build's wrapper
probe detects 0/4 with the finished entrance wrapper, versus 4/4 without it.
Green: 8 final r6 Chromium scenarios pass, including both nothing-running modes,
all-body unknown under live unstabilized motion, four Tailwind changes under the
finished wrapper and a real inline-important survivor. There are 90 channel unit
tests. The final full gates are recorded in their logs. The sole browser skip is
the existing cross-element-state non-Chromium-project test.

The obsolete token-classification unit tests were replaced by liveness and mode
truth tables. Earlier canonicalization/source tests now use normal settling;
the revised unstabilized rule deliberately withholds their evidence while an
animation is live. Their assertions are retained. Live-input regression tests
remain unstabilized. No thresholds, suppressions or gate configuration changed.
An intermediate classifier was discarded when the final review changed the rule.
A superseded full-gate/replay run was stopped to include the genuine-CSS-survivor
boundary; only final-probes and the final gate manifest are claimed.

All 47 replay commands exit 0. Exit 0 alone is not acceptance: the logs were read
for statuses, self-checks and findings. QA r6's three cases each pass 3/3 with and
without native-model prewarming; all bodies are unknown, with zero keyframes
findings and no self-check failure. QA new-attacks and finishing-transition
checks are stable. The r5 pseudo/layered/currentColor/Web Animation cases pass. The layered-important
fixture still reports ordinary margin differences, as before; channel uncertainty
does not suppress those findings.
Review gap6 and gap6-running have no progress leaks. wrapper6 detects 4/4 with the
finished wrapper, matching the independently built 86870f714 comparison, and
conservative6 O7 is known and detected. Default realistic edits are detected;
unstabilized realistic edits are deliberately unknown under the revised rule.

Prior r1–r5 source, scope, redaction, duplicate, timing and cost probes were replayed.
Historical probe labels expecting known unstabilized models are superseded by the
final r6 rule; their new unknown results are intentional. Range/custom models and
untraversed roots remain honest unknowns. The exact shared-property timing change
still flags; delete-only and disjoint reorder remain clean. Default parity matches
main both normally and with captureReach. Real ordinary findings remain visible.
The 600-target state-cost case reaches the existing 32k scan budget on and off;
its time is not proof of full state coverage. Event counts are scheduling-dependent.
The ancestor walk is removed; flat indexing and full-capture linearity remain.

Corpora before (7a16ae572 receipt) → after: detection remains 48/48 detect, 7/7 clean,
1/1 blind. Keyframes and img source still detect; aria label remains blind. Reach
remains 18 changes / 17 visual, declared 3/17 and complete 16/17 with 14/14 misses
named and no J2/J3 run-level gap. Reach keyframes remains conservatively
blind-channel. The detection receipt's generated timestamp is restored only after
all other case data is checked identical. Dependencies and docs/demo are unchanged.

The fresh synthetic report shows one static/default model edit and a separate
unstabilized surface whose model is explicitly not compared. The screenshot was
inspected at reviewer size with Evidence expanded. It visibly says Product-state
identity unproven for both pairs; it is diagnostic proof, not a certified same-state
product comparison. Video is not applicable: paused endpoint pairs, repeated
captures and native-frame observations prove the timing behaviour directly.
