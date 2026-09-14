## Honest baseline-failure attribution (fixture)

`base-capture-failed=false`. Baseline surface `pricing@1280` failed at SHA `1e0a210cd0d46de0ff9378e818d6f793fadc921c`.

```
⚠️ **1 baseline capture failure(s)**: these named surface(s) failed on the base SHA and were omitted from the baseline bundle: `pricing@1280` at `1e0a210cd0d46de0ff9378e818d6f793fadc921c`. The base bundle was produced (`base-capture-failed=false`); this is not a base recapture failure. Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.

### Baseline capture failure receipt

- `pricing@1280` · `capture_failed` · `1e0a210cd0d46de0ff9378e818d6f793fadc921c`

_Named surface+SHA above. This is not a base recapture failure (`base-capture-failed=false`)._
```

The machine receipt is `baseline-failures.json`. Verdict stays fail-closed (`PARTIAL_BASELINE`); approval cannot clear it. Per-surface notes point at the named SHA in that receipt.
