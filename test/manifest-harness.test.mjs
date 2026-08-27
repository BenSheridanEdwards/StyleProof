// #392 S1 — static registry diagnostics for the typed component manifest.
// The harness resolves declared exports/provider modules against a STATIC
// consumer registry (the consumer's dev entry's own imports) — never dynamic
// import(), eval, or AST. Validation failures (invalid props, duplicate keys)
// surface as diagnostics too, so one entry point can render an audit panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectManifestDiagnostics } from '../dist/manifest-harness.js';

const registry = {
  'src/components/Button.tsx': { exports: ['Button', 'default'] },
  'src/components/AppModal.tsx': { exports: ['default'] },
  'src/styleproof/providers/ModalProvider.tsx': { exports: ['default'] },
};

const validManifest = {
  version: 1,
  components: [
    {
      module: 'src/components/Button.tsx',
      export: 'Button',
      variants: [{ key: 'default', props: { label: 'Save' } }],
    },
    {
      module: 'src/components/AppModal.tsx',
      variants: [
        {
          key: 'open',
          props: { title: 'Confirm' },
          provider: 'src/styleproof/providers/ModalProvider.tsx',
        },
      ],
    },
  ],
};

test('collectManifestDiagnostics: a manifest fully present in the registry has no diagnostics', () => {
  assert.deepEqual(collectManifestDiagnostics(validManifest, registry), []);
});

test('collectManifestDiagnostics: flags a declared export the registry lacks', () => {
  const diagnostics = collectManifestDiagnostics(validManifest, {
    ...registry,
    'src/components/Button.tsx': { exports: ['default'] },
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'missing-export');
  assert.equal(diagnostics[0].where, 'components[0]');
  assert.match(diagnostics[0].message, /Button/);
  assert.match(diagnostics[0].message, /src\/components\/Button\.tsx/);
});

test('collectManifestDiagnostics: flags a module that is not registered at all', () => {
  const diagnostics = collectManifestDiagnostics(validManifest, {
    'src/components/AppModal.tsx': { exports: ['default'] },
  });
  assert.ok(diagnostics.some((d) => d.kind === 'missing-export' && d.where === 'components[0]'));
  assert.match(diagnostics.find((d) => d.where === 'components[0]').message, /not.*registered|static registry/i);
});

test('collectManifestDiagnostics: flags a provider module the registry lacks', () => {
  const diagnostics = collectManifestDiagnostics(validManifest, {
    'src/components/Button.tsx': { exports: ['Button'] },
    'src/components/AppModal.tsx': { exports: ['default'] },
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'missing-provider');
  assert.equal(diagnostics[0].where, 'components[1].variants[0]');
  assert.match(diagnostics[0].message, /ModalProvider|provider/i);
});

test('collectManifestDiagnostics: non-serializable props surface as invalid-props', () => {
  const diagnostics = collectManifestDiagnostics(
    {
      version: 1,
      components: [
        {
          module: 'src/components/Button.tsx',
          export: 'Button',
          variants: [{ key: 'default', props: { label: 'Save', onClick: () => {} } }],
        },
      ],
    },
    registry,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'invalid-props');
  assert.equal(diagnostics[0].where, 'components[0].variants[0].props');
  assert.match(diagnostics[0].message, /JSON-serializable/);
});

test('collectManifestDiagnostics: duplicate variant keys surface as duplicate-keys', () => {
  const diagnostics = collectManifestDiagnostics(
    {
      version: 1,
      components: [
        {
          module: 'src/components/AppModal.tsx',
          variants: [
            { key: 'open', props: { title: 'A' } },
            { key: 'open', props: { title: 'B' } },
          ],
        },
      ],
    },
    registry,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'duplicate-keys');
  assert.equal(diagnostics[0].where, 'component-app-modal-open');
  assert.match(diagnostics[0].message, /duplicate surface key/);
});

test('collectManifestDiagnostics: any other invalid manifest still yields a diagnostic (fail closed)', () => {
  const diagnostics = collectManifestDiagnostics({ version: 2, components: [] }, registry);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'invalid-manifest');
  assert.match(diagnostics[0].message, /version/);
});

test('collectManifestDiagnostics: missing export and missing provider are all reported in manifest order', () => {
  const diagnostics = collectManifestDiagnostics(
    {
      version: 1,
      components: [
        {
          module: 'src/components/Button.tsx',
          export: 'Missing',
          variants: [{ key: 'default' }],
        },
        {
          module: 'src/components/AppModal.tsx',
          variants: [{ key: 'open', provider: 'src/styleproof/providers/ModalProvider.tsx' }],
        },
      ],
    },
    {
      'src/components/Button.tsx': { exports: ['Button', 'default'] },
      'src/components/AppModal.tsx': { exports: ['default'] },
    },
  );
  assert.deepEqual(
    diagnostics.map((d) => [d.kind, d.where]),
    [
      ['missing-export', 'components[0]'],
      ['missing-provider', 'components[1].variants[0]'],
    ],
  );
});
