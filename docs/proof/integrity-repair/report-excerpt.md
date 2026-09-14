# Integrity repair proof (#650)

Privacy-clean synthetic bundles. Each fixture plants one closed integrity reason.
The report, audit, and Action comment name what broke, what to fix, and how to verify.
Approval cannot clear these states.

## `connector-partial`

```markdown
⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`connector-partial` — Map connector returned a partial bundle.**
  - **What broke:** The map-store or evidence connector restored only some of the expected surfaces. Certification cannot compare a partial restore as if it were a complete pair. Affected surface(s): `home`.
  - **What to fix:** Re-run the connector restore for the missing surfaces, or recapture those surfaces and republish the bundle. Do not tick visual approval — the missing maps are not a style delta.
  - **How to verify:** Re-run styleproof-diff (or the Action). The connector receipt must read `complete`, every expected surface must have a map on both sides, and the integrity repair block must disappear.
```

## `duplicate-id`

```markdown
⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`duplicate-id` — Duplicate identity in a style map.**
  - **What broke:** A style map contains a duplicate JSON key or a duplicate inventory identity. JSON.parse would keep only the last value, so correspondence and inventory would silently drop a real element. Affected surface(s): `home@320`.
  - **What to fix:** Give each element or navigable affordance a unique key (stable `id`, `data-testid`, or href). Recapture the surface so the map no longer carries a duplicate identity.
  - **How to verify:** Re-run styleproof-diff (or the Action). The report must no longer name `duplicate-id`, and styleproof-audit.json must show the integrity check clean.
```

## `integrity-mismatch`

```markdown
⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`integrity-mismatch` — Claimed evidence digest does not match the bytes.**
  - **What broke:** A source SHA or content digest declared by the connector or integrity receipt does not match the bytes on disk. The comparison would be bound to the wrong capture.
  - **What to fix:** Restore or recapture from the exact claimed SHA, then republish the bundle. Do not reuse a map that failed digest verification.
  - **How to verify:** Re-run styleproof-diff (or the Action) against the republished bundle. Claimed and actual digests must match, and the integrity repair block must disappear.
```

## Audit excerpt

```markdown
| integrity:connector-partial | ❌ failed | Map connector returned a partial bundle. Fix: … Verify: … |
| integrity:duplicate-id | ❌ failed | Duplicate identity in a style map. Fix: … Verify: … |
| integrity:integrity-mismatch | ❌ failed | Claimed evidence digest does not match the bytes. Fix: … Verify: … |

⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this.
```
