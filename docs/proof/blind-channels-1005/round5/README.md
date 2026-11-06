# Round 5 proof — animated context dependencies

Runtime source: `094be4e95a4f14b7636bd895a437fdb4512f1005`. Probes used the frozen compiled artifact bound by
`build-binding-final.json`; every compiled file matched the final checkout build.
The later proof-only commit changes no runtime source.

Context-relative values and implicit endpoints stay unknown if another running or
paused CSS animation, Web Animation or transition is active on the originating
element, its pseudo-elements or an ancestor. The consumer's own effect is excluded.
With `stabilize:false`, inputs seen before freezing are retained through capture;
this prevents a cancelled/finished transition from changing unknown to known.
The single flat animation index remains linear. Default settling remains clean.

Storage, opt-in default, redaction policy, dependency files and J1 reach semantics
are unchanged. Context checks inspect CSSOM values, including expanded shorthand
values; engine models retain their existing canonicalisation. The comma/escaped
name test now uses explicit fixed endpoints so it isolates name parsing rather
than the new conservative implicit-endpoint boundary.

Red → green: on 86870f714, the 14 new Chromium cases had 12 failures and 2 passes.
After fixing the guard and adding both running font-size transition controls,
all 16 round-5 cases and all 124 channel Chromium tests pass; 90 channel unit tests
pass. `unit-red.log` pins the missing pure context classifier before implementation.
The initial commit hook caught unused fixture style-flush expressions; they were
corrected and normal hooks passed. The proof commit hook also flagged filename-to-hash
entries containing "key" as secrets; the hash manifest uses separate file and SHA256
fields instead, with every digest recomputed against the artifact. No hook was bypassed. A superseded verify/probe run was stopped when
the transition-freeze boundary required a follow-up fix. Only final runs are claimed.

All 35 original/QA replay entrypoints exit 0 (see manifest). QA pseudo and explicit
currentColor each pass all three self-check pairs with unknown pulse and no
findings. Seven adversarial fixtures have deterministic channel evidence; the
layered fixture's ordinary sampled margin differences remain visible. Monotonic
control retains all 17 original color findings with channels on and off.
Review CSS, transition, WAAPI and percentage leaks have zero keyframes findings;
extra copies of CSS/WAAPI probes explicitly assert self-check equality (13 pairs).
Default-stabilize transition bodies remain known and equal. Default full-map JSON
matches independently compiled origin/main, both normally and with captureReach.

Exact timing controls: non-neighbouring shared-property change = 1 finding;
delete-only = 0; disjoint reorder = 0. The latter two are render-equal at all 1001
sampled times. Prior closed/untraversed roots, custom-property models and timeline
ranges remain honest unknowns. Prior probe labels saying these should detect are
historical, not supported evidence claims. Lazy/blob image skips and signing
residuals retain their documented meanings, including Meta oh/oe identity.
Mouseenter injection is not executed by CDP forced hover; the separate a-hover
probe checks the captured hover rule. State-cost's larger fixture reaches the
existing 32k scan budget on and off, so its timings do not claim full state coverage.
Event counts in side-effects are scheduling-dependent, not exact equality claims.

Round-5 corpus before (86870f714 receipt) → after:
Detection 48/48 detect, 7/7 clean, 1/1 blind → unchanged. Original #1005 baseline was
46/46 detect, 7/7 clean, 3/3 blind; keyframes and img src moved to detect while aria
label stays blind. Reach stays 18 changes / 17 visual, declared 3/17, complete
16/17, with 14/14 misses named and no J2/J3 run-level gap. Keyframes remains
blind-channel in that conservative reach corpus. See the real logs for results.

The fresh synthetic report shows one known static variable-based margin model
change plus one explicitly unknown currentColor consumer. Its visible warning is
Product-state identity unproven; it is diagnostic evidence, not a certified
same-state product comparison. Screenshot inspected at reviewer size, Evidence
expanded. Video: not applicable to this capture-model change; paused endpoint
probes, repeated captures and sampled rendering provide timing proof.

All final gates pass: verify has 6,698 passing tests; the full Chromium suite
has 1,340 passed and one existing skip (cross-element-state:112 requires a
non-Chromium project). Reach, detection and demo checks exit 0. Package files,
demo output, gate configuration and the detection receipt remain unchanged;
only a regenerated detection timestamp was restored after comparing all counts
and case data.

Full command outputs and raw maps/reports/probes are archived at
`/Users/chief/Mini/Operations/Inbox/styleproof-1005-round5-proof`.
