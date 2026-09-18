# styleproof@7.0.1 prepare notes

Prepare-only. Does **not** prove npm / GitHub Packages / `@v7` publish.

## Why

Published `styleproof@7.0.0` and Action tag `@v7` still resolve to `e8291d19`, behind main tip `3fd7d089`. Consumers cannot safely follow `@v7` until a release moves the tag onto tip.

## Tip delta vs `e8291d19` (fold into CHANGELOG `[7.0.1]` before or during publish)

- Phase 1 mapping harnesses (#669 CSS, #672 no-op, #670 structure, #671 fail-closed docs, #673 advisory CI wire)
- Codebase simplification (#675) — output wording / exit codes / file formats unchanged; dead subsystems removed

## Follow-up after this PR lands

1. Ensure `CHANGELOG.md` has a `## [7.0.1]` section (or accept auto-generated GitHub Release notes).
2. Run `release.yml` on main (Actions write required).
3. Prove: npm `7.0.1`, tag `v7.0.1`, `@v7` alias, GitHub Packages, consumer install.
4. Only then treat `@v7` as tip for consumer pins (see `docs/consumer-pin-bump.md`).

Soft-pass HOLD.

## Lockfile gap (restore before merge / publish)

`package-lock.json` could not be synced via GitHub MCP `create_or_update_file` / `push_files` (~117KB inline payload; same class of limit that blocked the full CHANGELOG rewrite). Two probe commits temporarily corrupted the remote lockfile; the corrupted file was deleted.

**Restore before merge** (machine with `gh` auth or git push). Prepared file: `/workspace/sp-704/package-lock.json` (root + `packages[""]` at 7.0.1; sha256 `01d1bc2e51c2b12afe771a89e450471ca8c47c9d0356baf731bf7ec865ac7b52`).

```bash
# create (no sha — file currently absent on branch tip)
gh api --method PUT repos/BenSheridanEdwards/StyleProof/contents/package-lock.json \
  -f message='chore(release): sync package-lock for 7.0.1' \
  -f branch='chore/prepare-7.0.1' \
  -f content="$(base64 -w0 /workspace/sp-704/package-lock.json)"
```

Or copy the prepared lockfile onto a checkout of `chore/prepare-7.0.1` and `git commit` / `git push`. Until restored, treat lockfile as a soft-pass HOLD gap (`package.json` is already 7.0.1).
