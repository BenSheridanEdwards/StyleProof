# Action PARTIAL / DEGRADED_BASELINE copy (#657)

Fixture receipts from `docs/proof/honest-baseline-attribution/baseline-failures.json`.
`base-capture-failed=false`. Baseline surface `pricing@1280` at
`1e0a210cd0d46de0ff9378e818d6f793fadc921c`.

## PARTIAL_BASELINE — comment, status, fail echo include key+SHA

```
_`pricing@1280` at `1e0a210cd0d46de0ff9378e818d6f793fadc921c` failed on the listed base SHA — this is not a base recapture failure. Repair those surfaces on that SHA; reviewer approval cannot clear missing baseline surfaces._
```

```
pricing@1280 at 1e0a210cd0d46de0ff9378e818d6f793fadc921c — not a base recapture failure
```

```
StyleProof: `pricing@1280` at `1e0a210cd0d46de0ff9378e818d6f793fadc921c` failed on the listed base SHA — this is not a base recapture failure. Repair those surfaces on that SHA (approval cannot clear this).
```

## DEGRADED_BASELINE / head-only when `base-capture-failed=false`

Does **not** say the base capture failed:

```
_This is a head-only receipt rather than a comparison — not a base recapture failure (`base-capture-failed=false`). Repair the missing baseline evidence and rerun; reviewer approval cannot clear this failure._
```

## DEGRADED_BASELINE when `base-capture-failed=true`

Recapture language stays, because that flag is actually set:

```
_The base capture failed, so this is a head-only receipt rather than a comparison — repair the base capture and rerun. Reviewer approval cannot clear this failure._
```

Verdict classification is unchanged: `DEGRADED_BASELINE` is still only assigned
when `base-capture-failed=true`. Copy is flag-driven so a head-only path with
the flag false cannot claim a recapture failure. Approval still cannot clear
either state.
