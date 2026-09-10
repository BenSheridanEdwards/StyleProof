# Forced-state resource limits proof

These are unedited local Playwright logs from real Chromium. The fixtures are synthetic generic controls; no application data is used. This is self-attested local evidence, not hosted CI or a deployment certificate.

`before.log` runs the identical five direct-capture regression cases on unmodified compiled source at `f0d35f50b75971f7e91f1dda0e0a29bf6a835433`: **four fail, one passes**. The failures show ignored explicit document/work limits, incomplete coverage after the default aggregate budget, and incorrectly marked incomplete coverage when the last state consumes exactly the default budget.

`after.log` runs those five cases and nine runner cases on code commit `1a11b4496b2684f402c9e07811497d67275f521b`: **14 pass**. The larger fixture has 298 elements and 53 controls; with a 70,000 aggregate allowance every control produces hover, focus, and active witness deltas. A 200-element, 40-control fixture consumes exactly the default 32,000 allowance and remains complete. Runner tests cover global, surface, variant, live-state, self-check, and popup propagation.

Warnings in the successful log are intentional incomplete captures with tiny limits. They must remain incomplete; the tests verify that resource exhaustion is not certified as full coverage. Larger bounds permit more work and can increase capture time. This change does not claim a speed improvement or completeness for arbitrary pages.

Screenshots and video: Not applicable. The changed outputs are computed-style coverage metadata and API option propagation; an unchanged screenshot cannot prove omitted targets or the exact scan boundary. The real-browser assertions and raw logs are the replacement proof.

The generated report example is [the existing demo report](../../demo/report.md). Its pngjs inputs are synthetic, and its visible product-state warning remains unproven. It demonstrates report rendering only and is not evidence for this capture fix. The report freshness check passed without changing its bytes.

`provenance.json` records source commits, commands, test hashes, and full-log hashes. No package version or release workflow changes are included.
