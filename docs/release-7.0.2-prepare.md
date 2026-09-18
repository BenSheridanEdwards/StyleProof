# Prepare styleproof@7.0.2

Prepare ≠ publish. This note tracks the tip delta since published `v7.0.1` /
`c8d5e808` (#701). Operators run `release.yml` after the prepare PR is
MERGE-READY — this document does not claim npm / `@v7` moved.

## Tip

- Main tip at prepare: `78baf286` (#712 / #711)
- Baseline: `v7.0.1` / `@v7` → `c8d5e808`

## Tip delta folded into CHANGELOG `[7.0.2]`

1. #703 — artifact digest bind into approve comment receipt
2. #704 / #705 — refuse expired report artifacts + remediation
3. #706 / #708 — action pin skew removed from scaffold / examples
4. #709 / #710 — artifact storage disclosure on run + comment
5. #707 / #713 — ADR: keep commit statuses over Checks API
6. #711 / #712 — bound CLI spawnSync timeout (suite fail-closed)

## Soft-pass HOLD

No `release.yml` dispatch from this prepare. No Closes on a publish issue.
