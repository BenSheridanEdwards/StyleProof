# Migration Showcase Fixtures

TDD fixtures for two-head migration mode (#563). These fixtures demonstrate the
classification categories that migration mode must showcase for reviewers:

## Surface Categories (SurfaceClassification)

| Fixture | Classification | Description |
|---------|---------------|-------------|
| `unchanged@1280` | `unchanged` | Surface present on both sides with no style differences |
| `style-changed@1280` | `changed` | Surface present on both sides with computed-style differences |
| `genuinely-new@1280` | `genuinely-new` | Head-only surface; first adoption, reviewable |
| `removed@1280` | `removed` | Base-only surface; absent on head |

## Element-level Categories (ContentChange with `kind: 'structure'`)

Within a surface, migration mode must classify element-level structural changes:

| Fixture | Change Types | Description |
|---------|-------------|-------------|
| `elements-added@1280` | `added` | Surface with new elements added on head |
| `elements-removed@1280` | `removed` | Surface with elements removed on head |
| `elements-retagged@1280` | `retagged` | Surface with element tag changes |

## Test Contract

These fixtures prove:

1. **Migration diff correctly classifies** each surface and structural change category
2. **Migration report gallery** shows distinct sections for each category
3. **Exit codes and gate states** are correct for migration mode vs certify mode
4. **Certify/style contracts remain fail-closed** — no soft-green for structure

The tests start RED (migration mode not yet implemented) and turn GREEN once the
feature lands (#564–#567).
