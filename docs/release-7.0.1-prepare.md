# styleproof@7.0.1 prepare notes

Prepare-only. Does **not** prove npm / GitHub Packages / `@v7` publish.

## Why

Published `styleproof@7.0.0` and Action tag `@v7` still resolve to `e8291d19`, behind main tip `3fd7d089`. Consumers cannot safely follow `@v7` until a release moves the tag onto tip.

## Tip delta vs `e8291d19` (fold into CHANGELOG `[7.0.1]` before or during publish)

- Phase 1 mapping harnesses (#669 CSS, #672 no-op, #670 structure, #671 fail-closed docs, #673 advisory CI wire)
- Codebase simplification (#675) — output wording / exit codes / file formats unchanged; dead subsystems removed

## Lockfile

`package-lock.json` is on this branch at 7.0.1 (root + `packages[""]`). Restored after an MCP inline size limit blocked a direct push.

## Follow-up after this PR lands

1. Ensure `CHANGELOG.md` has a `## [7.0.1]` section (or accept auto-generated GitHub Release notes).
2. Run `release.yml` on main (Actions write required).
3. Prove: npm `7.0.1`, tag `v7.0.1`, `@v7` alias, GitHub Packages, consumer install.
4. Only then treat `@v7` as tip for consumer pins (see `docs/consumer-pin-bump.md`).

Soft-pass HOLD.
