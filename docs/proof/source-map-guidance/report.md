# Source-map guidance diagnostic

Synthetic fixture; this does not certify a CSS comparison.

## Next.js head maps absent

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS).

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 0 unmeasured, 0 unknown, 1 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering. Source maps absent on 1 script(s) — see J2 gaps.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**J2 run-level gaps (unmeasured)**

- head: head script evidence: source map absent (1 script(s)) — enable Next.js \`productionBrowserSourceMaps: true\` for capture builds only; gate the setting on \`STYLEPROOF\_CAPTURE\_SOURCE\_MAPS=1\` and export that variable when starting the capture server

# Source-map guidance diagnostic

Synthetic fixture; this does not certify a CSS comparison.

## Other bundler head maps absent

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS).

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 0 unmeasured, 0 unknown, 1 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering. Source maps absent on 1 script(s) — see J2 gaps.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**J2 run-level gaps (unmeasured)**

- head: head script evidence: source map absent (1 script(s)) — enable Vite \`build.sourcemap: 'hidden'\` or webpack \`devtool: 'hidden-source-map'\` for capture builds only; gate the setting on \`STYLEPROOF\_CAPTURE\_SOURCE\_MAPS=1\` and export that variable when starting the capture server

# Source-map guidance diagnostic

Synthetic fixture; this does not certify a CSS comparison.

## Base maps absent; head maps available

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS).

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 0 unmeasured, 0 unknown, 1 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering. Source maps absent on 1 script(s) — see J2 gaps.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**J2 run-level gaps (unmeasured)**

- base: base script evidence: source map absent (1 script(s)) — base was captured without source maps; head maps are available. The next normal baseline capture with these source-map settings refreshes this evidence

# Source-map guidance diagnostic

Synthetic fixture; this does not certify a CSS comparison.

## Missing-map count after detail truncation

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS).

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 0 unmeasured, 0 unknown, 2 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering. Source maps absent on 5 script(s) — see J2 gaps.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**J2 run-level gaps (unmeasured)**

- J2 gaps truncated: 2 more omitted from report.json; source map absent (5 script(s)); first: base script evidence: source map absent (2 script(s)); head script evidence: source map absent (3 script(s)) — review the remaining J2 evidence gaps; report.json shares a 64 KB J2 detail budget after style findings
