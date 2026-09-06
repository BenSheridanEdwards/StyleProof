# The inventory gate stops reporting a check it never ran (#478)

Every block below is the real certification block that `generateStyleMapReport`
renders — the same text a reviewer reads in the pull request comment. The bundles
differ only in whether the captured maps carried an `inventory` array.

## Before — on `main`

A capture spec without `inventory: true` produced a full green row:

```
A. No captured inventory (a spec without `inventory: true`)
  - **Coverage** — ✓ complete (all 1 registered surface(s) captured)
  - **Determinism** — ✓ proven (base self-checked, head self-checked)
  - **Inventory** — ✓ navigable set unchanged
```

Nothing was captured, so nothing could have been compared. The audit was an empty
diff of two empty sets, which is byte-identical to "nothing was removed". The
Action agreed: it printed `::notice::` and exited 0.

## After

```
A. No captured inventory (a spec without `inventory: true`)
  - **Coverage** — ✓ complete (all 1 registered surface(s) captured)
  - **Determinism** — ✓ proven (base self-checked, head self-checked)
  - **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

B. Inventory captured, nothing removed
  - **Coverage** — ✓ complete (all 1 registered surface(s) captured)
  - **Determinism** — ✓ proven (base self-checked, head self-checked)
  - **Inventory** — ✓ navigable set unchanged

C. Inventory captured, "billing" removed and unacknowledged
  - **Coverage** — ✓ complete (all 1 registered surface(s) captured)
  - **Determinism** — ✓ proven (base self-checked, head self-checked)
  - **Inventory** — ⚠ 1 navigable affordance(s) removed, unacknowledged: nav-button:billing
```

B and C are unchanged. Only the claim StyleProof had not earned is withdrawn.

The Action's gate step follows the same rule:

```
Before:  ::notice::StyleProof: inventory gate is on but the captured maps carry no
                    inventory — nothing to gate. …
After:   ::warning::StyleProof: inventory gate COULD NOT RUN — it is armed, but no
                    captured map carried an inventory, so no navigable removal could
                    have been detected on this run. …
```

## Why the job still exits 0 here

The README scopes this gate to `inventory: true`. Failing closed would turn every
capture spec that predates that option red on upgrade, which is a different change
from the one this issue reports. The reported defect is the **false claim**, and the
claim is now withdrawn in both places a consumer reads it. A team that wants the gate
enforced sets `inventory: true`; a team that does not want it armed sets
`"gateInventoryRemovals": false`. Neither is now told a check ran when it did not.

A real removal still fails the job hard, exactly as before — case C above, and the
`::error::` branch of the same step.

## One definition, two readers

`styleproof-diff` already answered this correctly: it returns `null` from its
inventory audit when no map carried one. The report asked a different question and got
a different answer. `hasCapturedInventory` is now the single exported definition of
"the gate had data to run on", and both call it — so the report and the CLI cannot
drift into two subtly different accounts of the same run.
