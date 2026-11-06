# Detection-rate corpus — method and results

Buyer-legible answer to: _when a CSS change actually lands, does StyleProof say
so — and when nothing changed, does it stay quiet?_

## Method

- `bench/detection-fixture.html` — a deterministic static page (no web fonts, no
  network, a no-op animation). Every target carries an `sp-*` marker class.
- `bench/detection-corpus.json` — the only source of truth: 56 seeded mutations
  applied to that fixture via URL params (`?css=`, `?attr=`, `?text=`).
- `bench/detection-rate.mjs` — the real product path, nothing synthetic:
  Chromium renders each mutated page, `captureStyleMap` captures it, and
  `diffStyleMaps` (plus `diffContentMaps` for the opt-in advisory text layer)
  diffs it against the baseline. Captures enable `captureVisualChannels: true`.
- Before any case runs, the baseline is captured twice and must self-diff to
  zero — a nondeterministic fixture aborts the run rather than producing noise.

Each case declares an expectation:

| Expect   | Meaning                                                                            |
| -------- | ---------------------------------------------------------------------------------- |
| `detect` | A finding must land on the marked element and name the expected computed property. |
| `clean`  | Computed-identical change (e.g. `white` → `#ffffff`) — zero findings required.     |
| `blind`  | Documented detection boundary — must stay zero until the contract grows.           |

`--check` exits nonzero if any case drifts in either direction.

## Results (receipt: `bench/detection-corpus.results.json`)

| Outcome   | Score | Meaning                                            |
| --------- | ----- | -------------------------------------------------- |
| `detect`  | 48/48 | Every seeded observable change surfaced on target. |
| `clean`   | 7/7   | Computed-identical changes produced zero findings. |
| `blind`   | 1/1   | Documented boundaries held.                        |
| **Total** | 56/56 | Zero false positives, zero misses.                 |

## What this proves — and what it doesn't

**Proven:** on a deterministic fixture, the certification diff catches
realistic color, typography, spacing, layout, forced-state (`:hover`, `:focus`),
pseudo-element, referenced keyframes body, image source, and `href`-identity changes — named down to the computed
property — and stays silent on computed-identical CSS rewrites.

**Documented boundaries (`blind`, by design):**

- `aria-label` — accessibility metadata is outside style evidence.

**Before/after (#1005):** the 56 cases previously measured 46 detect, 7 clean,
3 blind. With the new opt-in channel enabled, `blind-keyframes` and `blind-img-src`
now detect on their original marked elements with `animation keyframes (pulse)`
and `img currentSrc` labels. `blind-aria-label` remains blind. The receipt has
48/48 detect, 7/7 clean and 1/1 blind, with no failures. Default captures retain
the previous boundary; the option expands ordinary findings and can change a
consumer's verdict only after both sides opt in.

**Notes:**

- A copy (`textContent`) change is caught by the _advisory_ layer when captured
  with `captureText: true` — shown in the report, never gates.
- `href` changes surface as a removed+added `dom` pair: `href` is part of the
  anchor's element fingerprint, so the element re-keys.
- Shorthands report as computed longhands — `white-space` arrives as
  `text-wrap-mode`, `border` as the `border-*` family.

**Not proven:** this is a diagnostic measurement on a controlled fixture, not a
certification run. It says nothing about a specific consumer's app — that is
what the hosted mapping proof (#720) is for. Rates here are evidence of the
detector's behaviour on known inputs, not a guarantee on arbitrary pages.

## Reproduce

```sh
npm run bench:detection         # measure + write the receipt
npm run bench:detection:check   # fail on any violated expectation
```

Adding a case: extend `detection-corpus.json`, keep expectations honest, rerun.
