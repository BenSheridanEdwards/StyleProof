---
name: styleproof-baseline
description: Use when capturing and publishing the base-branch computed-style maps StyleProof diffs against — styleproof-map, the styleproof-maps map store branch, record/replay, and the same-environment compatibility rule.
---

# StyleProof — capture & publish the baseline

One job: turn the current commit's rendered styles into stored maps the gate can
diff against. `styleproof-map` is the spec-driven capture for **your own app**
(coverage guard + map store + record/replay) — distinct from the one-shot
`styleproof-capture` (`styleproof-capture` skill), which just points at a URL.

## The three-command loop

```bash
npx styleproof-init     # once (styleproof-install skill)
npx styleproof-map      # capture this commit → .styleproof/maps/current + upload
npx styleproof-diff     # diff head vs base (styleproof-diff skill)
```

`styleproof-map` captures through Playwright into `.styleproof/maps/current`,
writes a manifest, keeps screenshots for the report, and **uploads the bundle to
the dedicated `styleproof-maps` branch** when the working tree was clean and a
git remote exists. That map store is how CI restores base/head without
re-capturing. HAR recordings are stripped before upload (private API responses
must not land in the store) — keep them only for explicit record/replay with
`--keep-har`.

Useful flags: `--no-upload` (local only), `--restore --sha <commit>` (pull a
stored bundle), `--spec`, `--dir`, `--base-dir`, `--no-screenshots`,
`--crawl-base-url` + repeated `--crawl-route` (run `styleproof-variants` first).

## Publish the base map from the base branch

The gate needs the **base branch's** maps in the store. Easiest: run
`styleproof-map` on `main` (or let the first PR/merge populate it). The best hot
path is to run `styleproof-map` locally **after committing** so the head bundle
exists before CI starts — then CI is report-only (no build, no browser).

## Determinism is built in

- **Record/replay** — the base records each surface's `**/api/**` responses to a
  HAR; the head replays them, so head renders *its code* against *base's data*.
  No phantom diff from a `5m ago` timestamp or a backend blip. Set
  `STYLEPROOF_REPLAY_FROM=<base dir>` on the head capture; tune the boundary with
  `STYLEPROOF_REPLAY_URL` if your API isn't under `/api`.
- **Frozen clock, self-check, network-aware settle** — all on by default.

## Gotcha — same-environment rule

Computed styles depend on the **browser build and installed fonts**, so maps are
only comparable when captured in the same runtime. StyleProof records a
compatibility key — including the **real browser build** (`browser().version()`),
not just the Playwright npm version, which can hold constant across a Chromium
re-download — and **refuses to compare maps from different browser/platform
settings** (exit 2, both builds named). CI then recaptures both sides rather
than produce a bogus report. Fonts aren't fingerprinted (too noisy across
machines): capture both sides on the same fonts yourself.

The bundle also carries the coverage/determinism **ledger**
(`styleproof-coverage.json`, a sidecar beside the manifest) that
`styleproof-diff` reads to qualify a green — see the `styleproof-diff` skill.
Since v4 the manifest itself is **required**: a map-bearing dir without one is
refused at compare time (exit 2), and every capture flow stamps it — the
`styleproof-map`/`styleproof-capture` CLIs and the runner itself, so even a raw
`STYLEMAP_DIR=x npx playwright test` run produces a comparable bundle.

## Next

`styleproof-ci-gate` wires the store into the PR gate; `styleproof-diff` is the
compare step.
