# Round 7 proof — shadow/SVG liveness and protocol fallback

Runtime source: `4805139bfabd786ebb1e91c4f96dfde4abf5c3ec`. Main: `4b298c004727c9ef955a72bd487ab7a36523f09f`.
The final compiled artifact is bound by `build-binding.json`; subsequent changes
are proof only. Full logs, original/copied probes, native frames, maps and reports
are archived at `styleproof-1005-round7-proof`.

Liveness now recursively reads every reachable open shadow root in both modes.
The freeze is not extended into shadow content: surviving shadow effects are
inputs just like surviving Web Animations. Closed hosts found by the existing
cached CDP scan, and unreadable open roots, hold every body unknown. SVG animation
element presence also holds unknown, including inactive/paused SMIL; timing is not
guessed. Static open-shadow and plain SVG controls remain known. The once-per-
capture host scan retains its documented late-created-closed-host limitation.
No animation pause/play/currentTime mutation or dependency was added. Storage
remains opt-in version 1. Channels-off/default capture output is unchanged.

The resting liveness/model snapshot and freeze lift run synchronously through
Playwright before CDP setup. A rejected session or protocol setup failure leaves
channels unknown while ordinary motion capture sees the unfrozen declarations.
It retains animation-name and transition-duration findings, identical to channels
off. No-CDP browsers do not gain speculative channel proof.

Red → green: the initial round7 Chromium regression run had 11 failed and 2
static controls passed. After the fix those 13 passed. Four additional mode-pair
QA regressions were added; all 17 round7 cases pass in the 149-case focused channel
run. The independent QA baseline reported 12/12 failures at f4fcffe67; the exact
probe now passes all 12 with unknown evidence, no keyframes finding, and a passing
self-check. The channel unit suite has 85 tests: six identical round6 tests were
collapsed into one; no distinct case was removed. Global-hold test names now state
the actual reason. REFERENCE corrects transition cancellation/end-value behavior
and documents conservative WAAPI, shadow, and SMIL holds.

All 58 replay commands exit 0. Semantic acceptance is recorded separately in
`semantic-audit.json`: reviewer shadow7/smil7 unstabilized attacks are unknown,
static S4/M0 are known, CDP rejection preserves both ordinary findings, QA r5/r6
fixtures remain stable and unknown, gap6/gap6-running have no progress leaks,
wrapper6 detects 4/4, and conservative6 O7 is known and detected. In default mode
some original reviewer live-region fixtures are excluded by the existing settle
logic; they are not claimed as known/compared. QA's finite light-DOM consumer
avoids that exclusion and proves the shadow hold in both modes. Normal ordinary
sampled findings in older WAAPI/layer-important fixtures are retained.

Prior r1–r6 probes cover scope/source collisions, URLs/privacy, timing grouping,
canonicalization, determinism, cost and the preserve list. Disjoint same-offset
reorder and delete-only controls remain clean; the exact shared-property timing
change still flags. Display:none and duplicated-name ambiguity stay unknown.
Unstabilized historical expectations of known live bodies are superseded by the
round6 global hold. Cost probes are diagnostic wall samples; the complete-capture
CPU linearity test is in the passing e2e suite. The 600-target state cost fixture
hits the existing 32k scan budget on and off, so timings do not claim full state
coverage. Race and reduced-motion reset probes report no self-check failures.

Detection before (f4fcffe67 receipt) → after: 48/48 detect, 7/7 clean, 1/1 blind.
Keyframes and img source still detect; aria label stays blind. Reach remains 18
changes / 17 visual, declared 3/17, complete 16/17, misses named 14/14 and no J2/J3
run-level gap. Its keyframes unit stays conservative blind-channel. The detection
receipt timestamp was restored only after all other data matched byte-for-byte.
Default capture parity matches main normally and with captureReach. package.json,
pnpm-lock.yaml, docs/demo and gate configuration are unchanged versus main.

The generated synthetic report shows both retained ordinary motion findings and
explicitly not-compared keyframes, including a closed-shadow input. Its screenshot
was inspected at reviewer size with Evidence expanded. It visibly says
Product-state identity unproven; this is diagnostic evidence, not a certified
same-state product comparison. Video is not applicable: repeated paused-time
pairs, native frames and self-checks prove this capture/model behavior directly.

Full gates are recorded in their command logs and manifest. These are local
results, not claims of hosted CI approval. No PR is opened for this task.
