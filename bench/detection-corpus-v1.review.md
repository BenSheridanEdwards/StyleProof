# Issue #447 pre-result expectation review

Status: **APPROVED before detector execution**.

Reviewer: parent task owner (pre-result review supplied 2026-09-05).

- `computed-rest-background-v1`: the fixture changes the same box background from rgb(200,200,200) to rgb(80,120,200); expected visible change and a `background-color` style finding.
- `computed-pseudo-color-v1`: the fixture changes only the visible `::before` marker color from green to red; expected visible change and a pseudo `color` style finding.
- `cross-element-hover-panel-v1`: the fixture changes the hovered button's sibling panel from blue to green; expected visible forced-hover change and a cross-element `background-color` state finding.
- `computed-equivalent-color-noop-v1`: `#c8c8c8` and `rgb(200,200,200)` resolve to the same visible color; expected no rendered change and no finding.

These labels and rationales are grounded in fixture mutations, not observed detector output. The four-case corpus is a bounded pilot, not the full #447 corpus or class-wide recall evidence.
