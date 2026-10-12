# Document-scroll visibility evidence

Privacy-clean Chromium fixture from `test/viewport-scroll.e2e.spec.ts`: viewport
400×300, document scrollY 1800, marker document box `[30,1900,120,40]`, actual
on-screen box `[30,100,120,40]`. `visible-marker.png` shows the reached viewport.
The element's document rectangle is unchanged by the fix.

`before-report.png` / `before-report.md` are actual report output on main
`0678a8990f42c8bbd80de1bef9328bd734403242`. `after-report.png` /
`after-report.md` are actual output from the fix's working build. Both screenshots
expand the report's Evidence section so its inventory warning stays visible.
Inventory is unarmed in this fixture; the warning is preserved, not certification
of navigation coverage. `before-diff.json`, `after-diff.json` and
`after-report.json` preserve the actual machine receipts.

The paired captures declare a generic matching product-state identity and use
controlled synthetic manifests/coverage receipts. The fixed-build proof verifies
matching SHA-256 hashes from two actual captures before recording its self-check
receipt. Forced-state capture is enabled, and the noninteractive page has no
omitted targets. These artifacts demonstrate the CLI's decisions for controlled
inputs; they do not independently certify real application provenance or a PR.

| Actual output                               | Main  | Fixed |
| ------------------------------------------- | ----- | ----- |
| Visible marker addition: diff / report exit | 0 / 0 | 1 / 1 |
| Visible marker removal: diff / report exit  | 0 / 0 | 1 / 1 |
| `reviewableCounts.dom`                      | 0     | 1     |
| Diff `certifiesFully`                       | true  | false |

The smallest source-verified view of the change:

```text
capturePage: document rect + scroll origin from one browser evaluation
  -> readSettledPage: optional viewport.scrollX / scrollY (zero omitted)
  -> isVisibleCapturedElement: intersect rect with [origin, origin + viewport size]
  -> shared comparison: reviewableCounts.dom / hasReviewableEvidence
  -> diff and report CLI: review required, exit 1
```

Separately, the browser regression changes a marker at document x=2000 after
scrollX=1800. It opens the generated crop PNG and verifies both actual marker
colours. Pure tests cover both axes, negative origins, every offscreen edge,
partial intersection, legacy absence, storage and determinism hashes. The
unscrolled real-browser case keeps `{width,height}` only. Missing scroll origins
on old maps cannot be reconstructed: affected baselines must be recaptured.
The CLI regression also enables `--include-content` and checks that visible
additions/removals are described as requiring review, without the advisory-only
exit-code claim.

`horizontal-before-report.png` and `horizontal-after-report.png` show the actual
main/fixed horizontal report output at a 1000px reviewer width, with Evidence
expanded. The generic marker is at document x=2000 after scrollX=1800, and changes
from blue to orange. Main incorrectly says the changed element is not visible;
the fixed report includes the real crop in `horizontal-after-composite.png`.
The corresponding report JSON files preserve empty vs populated regions.

This separate style-crop fixture does not declare product-state identity or
supply manifests/coverage receipts. Its visible **product-state identity
unproven** warning remains in both reports: it proves crop placement and exposure,
not a certified same-state comparison. No inventory completeness is claimed.
