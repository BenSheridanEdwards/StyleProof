# Hosted mapping proof — execution receipt (#720)

**Soft-pass HOLD.** This receipt records hosted consumer Visual evidence for
ACs 1–4. It does **not** soft-green invent, and closing the design tracer
(#683) is not a substitute for this evidence.

**StyleProof tip at receipt open:** `c9806a65778be765581bdedeb4bcdd2f648356e4`
(main after #748 → #745 → #746 → #747). Consumer Action pin remains floating
`BenSheridanEdwards/StyleProof@v7` + npm `styleproof@^7.1.0` (maps runner-temp
`--no-upload`; `report-storage: branch`; `mode: advisory`; `fail-on-diff: false`).

## Why (buyer-legible)

Phase 1 proved mapping inside StyleProof. Phase 2 is only proved when a
**hosted consumer Visual** run shows that real CSS / structure changes map into
the StyleProof report, that a no-op invents nothing, and that incomplete
evidence **fails closed** — never soft-green.

## Acceptance criteria table

Privacy-clean: consumer PR numbers, tip SHAs, Action run IDs, and
`styleproof-reports` blob SHAs only — no private consumer repo URLs or names.

| AC | Requirement | Status | Consumer evidence (pins) |
| --- | --- | --- | --- |
| 1 | Known **CSS** change surfaces in hosted report | **Evidenced** | Consumer PR **#28** tip `cc4744ea5937bce62fb24e0efe81481acdaae05d` — deliberate title colour `#8df6ff` → `#ff476a`; report on `styleproof-reports` at blob `062e7744717808ff3e283b8ff0a796f07eb79497` path `pr-28/report.md`; Action run **36401478362** attempt 1 (advisory success). 2 computed-style diffs / 1 changed surface. |
| 2 | Known **structure** change surfaces correctly | **Evidenced** | Consumer PR **#31** tip `734340b9a5328adc3337178dc335b6f0d631ff3a` — deliberate `p.structure-callout` add + `include-content: true`; report blob `8c9f2f0056679d4463a605e760048cce4691786c` path `pr-31/report.md` lists **`p.structure-callout` · element added**; Action run **36443907514** attempt 1 (advisory success). Note: same report also shows collateral rail-nav structure noise (dogfood App predates newer consumer pages); the deliberate callout is the AC finding. |
| 3 | **No-op / equivalent** invents **no** false change | **Evidenced** | Consumer PR **#29** tip `ddede65e1d07d72b8186a1934c8d910e849f3a17` — `#8df6ff` hex-equivalent of base `var(--cyan-bright)`; report blob `7d22d7295b04e1779ffff500b5786d237839529f` path `pr-29/report.md` — no reviewable computed-style changes; Action run **36443915384** attempt 1 (StyleProof job success). |
| 4 | **Fail closed** if mapping wrong or evidence incomplete | **Evidenced** | Consumer PR **#30** tip `b8ddb607caf1853a135db8a4ba0c81c01053073b` — probe forces `coverage.determinism=unproven` then asserts Action `outcome=failure` + `trust-state=CERTIFICATION_FAILED`; Action run **36443963595** attempt 1 (job success; assert step green); fail-closed PR comment marks incomplete evidence (cannot be approved away). **Not** the #28 product-state undeclared-legacy warning. |
| 5 | Soft-pass HOLD until receipt | **HOLD** | Soft-pass remains HOLD. No soft-green invent. Do not merge consumer dogfood PRs for proof. CoS owns StyleProof tip-push / merge of this receipt. |

## Consumer pin (unchanged)

- Action: `BenSheridanEdwards/StyleProof@v7`
- Package: `styleproof@^7.1.0`
- Capture: runner-temp maps, `--no-upload`
- Report: `report-storage: branch`
- Mode: `advisory`, `fail-on-diff: false`
- Runner: `ubuntu-latest`

## Out of scope

- Alternate dotted consumer Path A (stood down)
- Soft-green invent / merge of consumer dogfood PRs as “proved”
- Claiming Phase 2 proved without the hosted rows above

## Related

- Design ACs: [`README.md`](./README.md)
- Design checklist: [`CHECKLIST.md`](./CHECKLIST.md)
- Harness stubs: [`HARNESS.md`](./HARNESS.md)
- Parent issue: #720
