import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ComponentManifestError,
  componentManifestCatalogPath,
  componentManifestCatalogSurfaces,
  componentManifestSurfaceKey,
  componentManifestToDiscovered,
  isSerializableManifestValue,
  validateComponentManifest,
} from '../dist/component-manifest.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const validManifest = {
  version: 1,
  components: [
    {
      module: 'src/components/Button.tsx',
      export: 'Button',
      variants: [
        { key: 'default', props: { label: 'Save', disabled: false } },
        { key: 'loading', props: { label: 'Save', loading: true } },
      ],
    },
    {
      id: 'app-modal',
      module: 'src/components/AppModal.tsx',
      variants: [
        {
          key: 'open',
          props: { title: 'Confirm' },
          provider: 'src/styleproof/providers/ModalProvider.tsx',
          widths: [390, 1024],
          height: 800,
        },
      ],
    },
  ],
  exclusions: [{ path: 'src/components/InternalOnly.tsx', reason: 'internal debug chrome' }],
};

test('validateComponentManifest: accepts a typed framework-neutral manifest', () => {
  const manifest = validateComponentManifest(validManifest);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.components.length, 2);
  assert.equal(manifest.components[0].export, 'Button');
  assert.equal(manifest.components[1].export, 'default');
  assert.deepEqual(manifest.exclusions, [{ path: 'src/components/InternalOnly.tsx', reason: 'internal debug chrome' }]);
});

test('validateComponentManifest: rejects non-objects and wrong version', () => {
  assert.throws(() => validateComponentManifest(null), ComponentManifestError);
  assert.throws(() => validateComponentManifest([]), /must be a JSON object/);
  assert.throws(() => validateComponentManifest({ version: 2, components: [] }), /version.*1/);
  assert.throws(() => validateComponentManifest({ components: [] }), /version/);
});

test('validateComponentManifest: requires module path, export name shape, and variants', () => {
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: '', variants: [{ key: 'a' }] }],
      }),
    /module/,
  );
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: 'https://evil.example/mod.js', variants: [{ key: 'a' }] }],
      }),
    /remote|http|module path/i,
  );
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: 'src/Button.tsx', export: '123bad', variants: [{ key: 'a' }] }],
      }),
    /export/,
  );
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: 'src/Button.tsx', variants: [] }],
      }),
    /variants/,
  );
});

test('validateComponentManifest: requires unique component+variant surface keys', () => {
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [
          {
            module: 'src/components/Button.tsx',
            variants: [{ key: 'primary' }, { key: 'primary' }],
          },
        ],
      }),
    /duplicate.*variant|surface key/i,
  );
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [
          { id: 'card', module: 'src/a/Card.tsx', variants: [{ key: 'default' }] },
          { id: 'card', module: 'src/b/Card.tsx', variants: [{ key: 'default' }] },
        ],
      }),
    /duplicate.*surface key/i,
  );
});

test('validateComponentManifest: props and provider must be serializable module refs', () => {
  assert.equal(isSerializableManifestValue({ a: [1, 'x', true, null] }), true);
  assert.equal(
    isSerializableManifestValue(() => {}),
    false,
  );
  assert.equal(isSerializableManifestValue(undefined), false);
  assert.equal(isSerializableManifestValue(1n), false);

  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [
          {
            module: 'src/Button.tsx',
            variants: [{ key: 'a', props: { n: Number.NaN } }],
          },
        ],
      }),
    /serializable|props/i,
  );

  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [
          {
            module: 'src/Button.tsx',
            variants: [{ key: 'a', provider: 'https://cdn.example/provider.js' }],
          },
        ],
      }),
    /provider|remote|module path/i,
  );
});

test('validateComponentManifest: exclusions require a non-empty reason', () => {
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: 'src/Button.tsx', variants: [{ key: 'a' }] }],
        exclusions: [{ path: 'src/Skip.tsx', reason: '' }],
      }),
    /reason/,
  );
  assert.throws(
    () =>
      validateComponentManifest({
        version: 1,
        components: [{ module: 'src/Button.tsx', variants: [{ key: 'a' }] }],
        exclusions: [{ path: '', reason: 'not ready' }],
      }),
    /path/,
  );
});

test('validateComponentManifest: optional cwd checks module and provider files exist', () => {
  const root = mkTmp();
  try {
    const button = path.join(root, 'src/components/Button.tsx');
    fs.mkdirSync(path.dirname(button), { recursive: true });
    fs.writeFileSync(button, 'export function Button() {}');

    assert.throws(
      () =>
        validateComponentManifest(
          {
            version: 1,
            components: [{ module: 'src/components/Missing.tsx', variants: [{ key: 'a' }] }],
          },
          { cwd: root },
        ),
      /module path not found|not found/i,
    );

    const ok = validateComponentManifest(
      {
        version: 1,
        components: [{ module: 'src/components/Button.tsx', export: 'Button', variants: [{ key: 'a' }] }],
      },
      { cwd: root },
    );
    assert.equal(ok.components[0].module, 'src/components/Button.tsx');
  } finally {
    rmTmp(root);
  }
});

test('componentManifestSurfaceKey + catalog path: deterministic and catalog-compatible', () => {
  assert.equal(
    componentManifestSurfaceKey({
      prefix: 'component',
      componentId: 'app-modal',
      variantKey: 'open',
    }),
    'component-app-modal-open',
  );
  assert.equal(
    componentManifestSurfaceKey({
      prefix: 'component',
      componentId: 'dashboard/UserMenu',
      variantKey: 'default',
    }),
    'component-dashboard-user-menu-default',
  );
  assert.equal(
    componentManifestCatalogPath('component-app-modal-open'),
    '/styleproof/components/component-app-modal-open',
  );
  assert.equal(
    componentManifestCatalogPath('component-button-default', { catalogBasePath: '/catalog' }),
    '/catalog/component-button-default',
  );
});

test('componentManifestToDiscovered + catalog surfaces: feed componentCatalogSurfaces', async () => {
  const manifest = validateComponentManifest(validManifest);
  const discovered = componentManifestToDiscovered(manifest);
  assert.deepEqual(
    discovered.map((c) => c.key),
    ['component-app-modal-open', 'component-button-default', 'component-button-loading'],
  );

  const visits = [];
  const surfaces = componentManifestCatalogSurfaces(manifest, {
    widths: [1280],
  });
  assert.deepEqual(
    surfaces.map((s) => s.key),
    discovered.map((c) => c.key),
  );
  await surfaces[0].go({ goto: async (url) => visits.push(url) });
  assert.equal(visits[0], `/styleproof/components/${surfaces[0].key}`);
  assert.deepEqual(surfaces[0].widths, [1280]);
});

test('componentManifestCatalogSurfaces: honors custom catalog base and url mapper', async () => {
  const manifest = validateComponentManifest({
    version: 1,
    catalogBasePath: '/dev/catalog',
    components: [{ module: 'src/Toast.tsx', id: 'toast', variants: [{ key: 'host' }] }],
  });
  const visits = [];
  const surfaces = componentManifestCatalogSurfaces(manifest, {
    url: (component) => `/custom/${component.key}`,
  });
  await surfaces[0].go({ goto: async (url) => visits.push(url) });
  assert.deepEqual(visits, ['/custom/component-toast-host']);

  const defaultSurfaces = componentManifestCatalogSurfaces(manifest);
  await defaultSurfaces[0].go({ goto: async (url) => visits.push(url) });
  assert.equal(visits[1], '/dev/catalog/component-toast-host');
});
