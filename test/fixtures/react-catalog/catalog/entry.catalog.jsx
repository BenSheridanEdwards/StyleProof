// Reference React catalog fixture entry (#392): renders whatever surface the
// deterministic catalog routes ask for (componentManifestCatalogSurfaces
// contract: /styleproof/components/<surfaceKey>) plus a diagnostics view per
// broken manifest. Built to a single IIFE by the e2e spec and by the
// production-bundle oracle (test/component-bundle-oracle.test.mjs).
import { createRoot } from 'react-dom/client';
import { collectManifestDiagnostics } from '../../../../dist/manifest-harness.js';
import { componentManifestSurfaceKey } from '../../../../dist/component-manifest.js';
import manifest from './manifest.json';
import brokenMissingExport from './broken/missing-export.json';
import brokenMissingProvider from './broken/missing-provider.json';
import brokenInvalidProps from './broken/invalid-props.mjs';
import brokenDuplicateKeys from './broken/duplicate-keys.json';
import { MODULES, REGISTRY } from './modules.mjs';

// The catalog bundle marker the exclusion oracle looks for: present only when
// the catalog is actually imported into a production bundle.
const CATALOG_BUNDLE_MARKER = '__STYLEPROOF_COMPONENT_CATALOG_MARKER__';
globalThis[CATALOG_BUNDLE_MARKER] = CATALOG_BUNDLE_MARKER;

const DIAGNOSTIC_BROKEN = {
  'missing-export': brokenMissingExport,
  'missing-provider': brokenMissingProvider,
  'invalid-props': brokenInvalidProps,
  'duplicate-keys': brokenDuplicateKeys,
};

const SURFACE_BY_KEY = new Map();
for (const component of manifest.components) {
  const componentId = component.id ?? component.module;
  for (const variant of component.variants) {
    const key = componentManifestSurfaceKey({
      prefix: manifest.prefix,
      componentId,
      variantKey: variant.key,
    });
    SURFACE_BY_KEY.set(key, { component, variant });
  }
}

function ComponentView({ surfaceKey }) {
  const surface = SURFACE_BY_KEY.get(surfaceKey);
  if (!surface) {
    return <p data-testid="surface-missing">unknown surface: {surfaceKey}</p>;
  }
  const Component = MODULES[surface.component.module][surface.component.export ?? 'default'];
  return <Component {...(surface.variant.props ?? {})} />;
}

function DiagnosticsView({ name }) {
  const broken = DIAGNOSTIC_BROKEN[name];
  if (!broken) {
    return <p data-testid="surface-missing">unknown diagnostics: {name}</p>;
  }
  const diagnostics = collectManifestDiagnostics(broken, REGISTRY);
  return (
    <ul data-testid="diagnostics">
      {diagnostics.map((d) => (
        <li key={d.kind} data-testid="diagnostic">
          <strong>{d.kind}</strong>
          {d.where ? ` — ${d.where}` : ''}
          <p>{d.message}</p>
        </li>
      ))}
    </ul>
  );
}

function App() {
  const diagnostics = /^\/styleproof\/diagnostics\/([a-z-]+)$/.exec(window.location.pathname);
  if (diagnostics) {
    return <DiagnosticsView name={diagnostics[1]} />;
  }
  const surfaceKey = window.location.pathname.startsWith('/styleproof/components/')
    ? window.location.pathname.slice('/styleproof/components/'.length)
    : null;
  if (!surfaceKey) {
    return <p data-testid="surface-missing">no catalog surface: {window.location.pathname}</p>;
  }
  return <ComponentView surfaceKey={surfaceKey} />;
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
