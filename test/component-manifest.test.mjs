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
  // app-modal-open carries per-variant viewport; button variants inherit catalog widths.
  assert.equal(surfaces[0].key, 'component-app-modal-open');
  assert.deepEqual(surfaces[0].widths, [390, 1024]);
  assert.equal(surfaces[0].height, 800);
  const buttonDefault = surfaces.find((s) => s.key === 'component-button-default');
  assert.ok(buttonDefault);
  assert.deepEqual(buttonDefault.widths, [1280]);
  assert.equal(buttonDefault.height, undefined);
});

test('catalog paths reject traversal, external origins, delimiters, NULs, and unsafe surface keys', () => {
  const unsafeBases = [
    '/../admin',
    '//evil.example/x',
    '/%2e%2e/admin',
    '/safe/./x',
    '/safe?x=1',
    '/safe#fragment',
    '/safe\0bad',
    'http://evil.example/x',
    ['file:', '', '', 'tmp', 'x'].join('/'),
  ];
  for (const catalogBasePath of unsafeBases) {
    assert.throws(
      () => validateComponentManifest({ version: 1, catalogBasePath, components: [] }),
      ComponentManifestError,
      catalogBasePath,
    );
    assert.throws(
      () => componentManifestCatalogPath('component-safe-default', { catalogBasePath }),
      ComponentManifestError,
      catalogBasePath,
    );
  }

  for (const surfaceKey of ['../admin', 'safe/key', 'safe?x', 'safe#x', 'safe\\key', 'safe\0key']) {
    assert.throws(() => componentManifestCatalogPath(surfaceKey), ComponentManifestError, surfaceKey);
  }

  assert.equal(
    componentManifestCatalogPath('component-safe-default', { catalogBasePath: '/' }),
    '/component-safe-default',
  );
  assert.equal(
    componentManifestCatalogPath('component-safe-default', {
      catalogBasePath: `/catalog${'/'.repeat(10_000)}`,
    }),
    '/catalog/component-safe-default',
  );
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

test('isSerializableManifestValue: cyclic objects return false (no stack overflow)', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(isSerializableManifestValue(cyclic), false);

  const arr = [1, 2];
  arr.push(arr);
  assert.equal(isSerializableManifestValue(arr), false);

  const nested = { ok: true, child: { n: 1 } };
  nested.child.parent = nested;
  assert.equal(isSerializableManifestValue(nested), false);
});

test('isSerializableManifestValue: shared acyclic references return true (like JSON.stringify)', () => {
  const shared = { n: 1, label: 'fixture' };
  const diamond = { left: shared, right: shared };
  assert.equal(isSerializableManifestValue(diamond), true);
  assert.equal(JSON.stringify(diamond), '{"left":{"n":1,"label":"fixture"},"right":{"n":1,"label":"fixture"}}');

  const sharedArr = [1, 2];
  const both = { a: sharedArr, b: sharedArr, nested: { again: shared } };
  assert.equal(isSerializableManifestValue(both), true);

  // Array that reuses the same plain object twice (still acyclic).
  const item = { id: 'x' };
  assert.equal(isSerializableManifestValue([item, item, { items: [item] }]), true);
});

test('componentManifestCatalogSurfaces: maps per-variant widths and height onto surfaces', () => {
  const manifest = validateComponentManifest({
    version: 1,
    components: [
      {
        module: 'src/components/Card.tsx',
        id: 'card',
        variants: [
          { key: 'mobile', props: { dense: true }, widths: [390], height: 700 },
          { key: 'desktop', props: { dense: false }, widths: [1440] },
          { key: 'default', props: {} },
        ],
      },
    ],
  });
  const surfaces = componentManifestCatalogSurfaces(manifest, {
    widths: [1280],
    height: 900,
  });
  const byKey = Object.fromEntries(surfaces.map((s) => [s.key, s]));

  assert.deepEqual(byKey['component-card-mobile'].widths, [390]);
  assert.equal(byKey['component-card-mobile'].height, 700);

  assert.deepEqual(byKey['component-card-desktop'].widths, [1440]);
  // variant omitted height → catalog-level height retained
  assert.equal(byKey['component-card-desktop'].height, 900);

  assert.deepEqual(byKey['component-card-default'].widths, [1280]);
  assert.equal(byKey['component-card-default'].height, 900);
});

test('validateComponentManifest: cwd rejects symlink escape outside project root', () => {
  const root = mkTmp();
  const outside = mkTmp();
  try {
    const outsideFile = path.join(outside, 'Secret.tsx');
    fs.writeFileSync(outsideFile, 'export default function Secret() {}');

    const linkDir = path.join(root, 'src/components');
    fs.mkdirSync(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, 'Escaped.tsx');
    fs.symlinkSync(outsideFile, linkPath);

    // Inside-root real file still OK.
    const okFile = path.join(linkDir, 'Button.tsx');
    fs.writeFileSync(okFile, 'export function Button() {}');
    const ok = validateComponentManifest(
      {
        version: 1,
        components: [{ module: 'src/components/Button.tsx', export: 'Button', variants: [{ key: 'a' }] }],
      },
      { cwd: root },
    );
    assert.equal(ok.components[0].module, 'src/components/Button.tsx');

    assert.throws(
      () =>
        validateComponentManifest(
          {
            version: 1,
            components: [{ module: 'src/components/Escaped.tsx', variants: [{ key: 'a' }] }],
          },
          { cwd: root },
        ),
      /escapes project root|not found/i,
    );
  } finally {
    rmTmp(root);
    rmTmp(outside);
  }
});
