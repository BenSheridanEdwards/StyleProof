# Typed component manifests and catalog coverage

StyleProof can treat isolated component states as deterministic capture surfaces without knowing React, Vue, Svelte, or any other framework. The package owns the manifest, diagnostics, routes, and inventory. Your development entry owns static imports, providers, rendering, and fixture data.

There is no runtime module loading, prop inference, `eval`, AST parsing, or remote fixture source.

## Scaffold a starter manifest

```sh
npx styleproof-init \
  --manifest styleproof.components.json \
  --component-roots src/components,src/widgets
```

The scaffolder discovers component files and writes one explicit `default` variant per file. It never invents props or providers. Existing manifests stay untouched unless you pass `--force`.

```json
{
  "version": 1,
  "prefix": "component",
  "catalogBasePath": "/styleproof/components",
  "components": [
    {
      "module": "src/components/Button.tsx",
      "export": "default",
      "variants": [{ "key": "default" }]
    }
  ]
}
```

Add committed, JSON-serializable fixture props yourself. Functions, `undefined`, `bigint`, `NaN`, class instances, and cyclic values fail validation. Every exclusion requires a non-empty reason.

## Declare deterministic variants

```json
{
  "version": 1,
  "components": [
    {
      "id": "button",
      "module": "src/components/Button.tsx",
      "export": "Button",
      "variants": [
        { "key": "default", "props": { "label": "Save" } },
        { "key": "disabled", "props": { "label": "Save", "disabled": true } },
        { "key": "loading", "props": { "label": "Save", "loading": true } },
        { "key": "error", "props": { "label": "Save", "error": "Could not save" } }
      ]
    },
    {
      "id": "modal",
      "module": "src/components/Modal.tsx",
      "export": "Modal",
      "variants": [
        {
          "key": "open",
          "props": { "open": true, "title": "Confirm" },
          "provider": "src/styleproof/ModalProvider.tsx",
          "widths": [390, 1280],
          "height": 800
        }
      ]
    }
  ],
  "exclusions": [{ "path": "src/components/InternalDebug.tsx", "reason": "development-only debug chrome" }]
}
```

`componentManifestCatalogSurfaces(manifest)` generates stable routes such as:

```text
/styleproof/components/component-button-default
/styleproof/components/component-button-disabled
/styleproof/components/component-modal-open
```

Use those surfaces in the same capture workflow as application routes. Variant viewport overrides are preserved.

## Static registry diagnostics

StyleProof never imports strings from the manifest. Your catalog development entry imports modules statically and exposes only their export names:

```ts
import * as ButtonModule from './components/Button';
import * as ModalModule from './components/Modal';
import * as ModalProviderModule from './styleproof/ModalProvider';
import { collectManifestDiagnostics } from 'styleproof';

const registry = {
  'src/components/Button.tsx': { exports: Object.keys(ButtonModule) },
  'src/components/Modal.tsx': { exports: Object.keys(ModalModule) },
  'src/styleproof/ModalProvider.tsx': { exports: Object.keys(ModalProviderModule) },
};

const diagnostics = collectManifestDiagnostics(manifest, registry, { cwd: process.cwd() });
```

Diagnostics are deterministic and actionable:

- `missing-export`: the component module or declared export is absent from the static registry.
- `missing-provider`: a declared provider module or its required default export is absent from the static registry.
- `invalid-props`: fixture props are not JSON-serializable.
- `duplicate-keys`: two declarations produce the same surface key.
- `invalid-manifest`: any other malformed manifest. Invalid input never produces a false clean result.

## Audit file coverage

```sh
npx styleproof-components \
  --manifest styleproof.components.json \
  --component-root src/components \
  --component-root src/widgets
```

The command prints exact JSON sections:

- `declared`: manifest component files, exports, and exact variant keys.
- `excludedWithReason`: explicit exclusions and their reasons.
- `uncovered`: discovered files in neither group.

The default exit code is `1` while any uncovered file remains. `--uncovered-ok` changes the exit code to `0` but does not hide those files. Usage, malformed manifests, overlaps, and duplicate discovered paths fail closed with exit `2`.

## React is a development fixture, not a product dependency

The repository's reference fixture under `test/fixtures/react-catalog/` demonstrates button default/disabled/loading/error, modal-open, empty, loading, and error surfaces. It uses committed serializable dummy data and an app-owned static registry.

React, React DOM, their types, and esbuild are development dependencies only. StyleProof has no React runtime or peer dependency. A bundle oracle proves a production entry that does not import the catalog contains neither React nor the catalog marker; a positive-control bundle proves the oracle can detect the harness. Packed-package tests prove the entire test fixture is excluded from the npm tarball.

That boundary is the point. Framework adapters belong in the consumer's development fixture. Production only gets one if the consumer explicitly imports one.
