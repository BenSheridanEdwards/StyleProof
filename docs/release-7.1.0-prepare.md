# styleproof@7.1.0 prepare notes

Prepare-only. Does **not** prove npm / GitHub Packages / `@v7` publish.

## Why minor, not patch

Published `styleproof@7.0.2` / Action tag `@v7` resolve to `98ece011`. The tip
delta adds opt-in product surface — selective remap (`STYLEPROOF_SELECTIVE_REMAP`),
map-restore observability (`base_hit`/`cold_reason`), the detection-rate corpus —
alongside security and fail-closed fixes. New backward-compatible surface → 7.1.0.

## Tip delta vs `98ece011` (folded into CHANGELOG `[7.1.0]` in this PR)

- Fork PRs never auto-green; Action input/SHA-pin/persist-credentials hardening (#732)
- Eight fail-closed engine paths: vacuous `--pixels`, live-fallback determinism
  mislabel, nested-crawl auth-wall swallow, tolerated-failure masking, unreadable
  fatal marker, temp-dir cleanup, escaped-quote canonicalization, prototype-key
  `Object.hasOwn` (#726)
- Seven silent-failure fixes across report/CLI/capture/init (#738)
- Map-restore observability: `base_hit`/`cold_reason` (#734, #736)
- Opt-in selective remap, fail-closed to full (#733, #737)
- Detection-rate corpus, now a required CI job (#735, #742)
- Per-surface live-text scoping, base-only volatility as reviewable, per-surface
  determinism (#725, #731, #741)
- Phase-aware navigation budget under a surface ceiling (#730)
- Packages mirror hardening; advisory/gitleaks wording (#739)
- `npm pack` `prepare` mid-suite flake fix; dist-mutation tripwire (#740)
- Map-store restore authenticates its branch probe — private-remote fix (#743)
- Test-infra: bounded spawnSync (#712), V8 job-tier preload (#719)

## Lockfile

`package-lock.json` is on this branch at 7.1.0 (root + `packages[""]`).

## Follow-up after this PR lands

1. Merge — `release.yml` publishes on the version bump (npm, `v7.1.0`, `@v7`
   alias, GitHub Release).
2. Prove: npm `7.1.0`, tag `v7.1.0`, `@v7` alias, GitHub Packages, consumer install.
3. Consumer dogfood (#720) can then pin a released build that carries the
   private-remote map-store restore fix.

Soft-pass HOLD.
