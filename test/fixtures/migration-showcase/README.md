# Migration Showcase Fixtures

TDD fixtures for two-head migration mode (#563). These fixtures demonstrate the
classification categories that migration mode must showcase for reviewers.

## Mission 4 Lockdown Decisions

**Q9 Gallery labels** (#566): The migration report gallery uses these sections:
- **Changed styles** → `SurfaceClassification: 'changed'`
- **New surfaces** → `SurfaceClassification: 'genuinely-new'`
- **New/removed elements** → `ContentChange` with `kind: 'structure'`

**Q10 Inventory/nav removals**: Removed surfaces (`SurfaceClassification: 'removed'`)
stay SEPARATE from migration gallery — do not fold into migration buckets.

**Q7 Merge-ready gate**: These fixtures gate merge-ready; external dogfood is
post-release verify only.

## Surface Categories (SurfaceClassification)

| Fixture | Classification | Gallery Section |
|---------|---------------|-----------------|
| `unchanged@1280` | `unchanged` | (not shown — no changes) |
| `style-changed@1280` | `changed` | **Changed styles** |
| `genuinely-new@1280` | `genuinely-new` | **New surfaces** |
| `removed@1280` | `removed` | (separate — Q10) |

## Element-level Categories (ContentChange with `kind: 'structure'`)

Within a surface, migration mode classifies element-level structural changes
under the **New/removed elements** gallery section:

| Fixture | Change Types | Description |
|---------|-------------|-------------|
| `elements-added@1280` | `added` | Surface with new elements added on head |
| `elements-removed@1280` | `removed` | Surface with elements removed on head |
| `elements-retagged@1280` | `retagged` | Surface with element tag changes |

## Test Contract

These fixtures prove:

1. **Migration diff correctly classifies** each surface and structural change category
2. **Migration report gallery** shows distinct sections matching Q9 labels
3. **Exit codes and gate states** are correct for migration mode vs certify mode
4. **Certify/style contracts remain fail-closed** — no soft-green for structure
5. **Removed surfaces stay separate** (Q10) — not folded into migration buckets

The tests start RED (migration mode not yet implemented) and turn GREEN once the
feature lands (#564–#567).
