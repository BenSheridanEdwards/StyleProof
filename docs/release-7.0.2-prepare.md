# styleproof@7.0.2 prepare notes

Prepare-only. Does **not** prove npm / GitHub Packages / `@v7` publish.

## Why

Published `styleproof@7.0.1` and Action tag `@v7` still resolve to `c8d5e808`, behind main tip `78baf286`. Consumers cannot safely follow `@v7` until a release moves the tag onto tip.

## Tip delta vs `c8d5e808` (folded into CHANGELOG `[7.0.2]` in this PR)

- Artifact digest bound into the approve-comment receipt (#702, #703)
- Expired report artifacts refuse approval with a re-run remediation (#704, #705)
- Action pin skew removed from the scaffold and shipped examples (#706, #708)
- Artifact report storage disclosed on the run and the comment (#709, #710)
- ADR 0005: commit statuses stay over the Checks API (#707, #713)
- Bounded CLI `spawnSync` timeout; the suite fails closed — test-infra only (#711, #712)

This PR also writes the missing `[7.0.1]` section: the 7.0.1 prepare
deferred the changelog fold and it never happened, so every already-shipped
`[Unreleased]` bullet moves under `[7.0.1]` where it belongs.

## Lockfile

`package-lock.json` is on this branch at 7.0.2 (root + `packages[""]`).

## Follow-up after this PR lands

1. Run `release.yml` on main (Actions write required).
2. Prove: npm `7.0.2`, tag `v7.0.2`, `@v7` alias, GitHub Packages, consumer install.
3. Only then treat `@v7` as tip for consumer pins (see `docs/consumer-pin-bump.md`).

Soft-pass HOLD.
