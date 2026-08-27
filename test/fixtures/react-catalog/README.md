# React catalog reference fixture

Reference implementation of the StyleProof component-manifest consumer
contract (issue #392). Lives under `test/fixtures/` so it **never ships** in
the packed package; React/react-dom/esbuild are devDependencies only.

What it proves:

- **Deterministic catalog routes.** `catalog/manifest.json` is a valid
  manifest; the app renders every surface at exactly
  `componentManifestCatalogSurfaces`'s route — `/styleproof/components/<key>`
  — with stable keys (`component-button-default`, `component-button-disabled`,
  `component-modal-open`, `component-empty-default`,
  `component-loading-default`, `component-error-default`, …). The e2e spec
  (`test/react-catalog.e2e.spec.ts`) asserts each surface against the shared
  `componentManifestCatalogPath` builder.
- **Static consumer registry.** `catalog/modules.mjs` is the fixture dev
  entry's own static import set: StyleProof never loads modules, so this
  registry is the truth the diagnostics are checked against.
- **Diagnostics.** `catalog/broken/` holds one broken manifest per diagnostic
  kind (missing export, missing provider, invalid props, duplicate keys). The
  `/styleproof/diagnostics/<name>` routes render exactly what
  `collectManifestDiagnostics` reports.
- **Serializable dummy data.** `catalog/data.js` carries the committed,
  JSON-round-trip-safe fixtures the components render.
- **Production-bundle exclusion.** `entry.catalog.jsx` (imports React + the
  catalog + the marker) and `entry.plain.jsx` (imports nothing) are the
  positive/negative controls for the bundle exclusion oracle
  (`test/component-bundle-oracle.test.mjs`).

Run the e2e with `npm run test:e2e` (builds `dist/`, then Playwright collects
this spec automatically via `test/**/*.e2e.spec.ts`).
