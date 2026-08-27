import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentInventoryError, componentManifestInventory } from '../dist/component-inventory.js';
import { validateComponentManifest } from '../dist/component-manifest.js';

const manifest = validateComponentManifest({
  version: 1,
  components: [
    {
      module: 'src/components/Button.tsx',
      export: 'Button',
      variants: [{ key: 'loading' }, { key: 'default' }],
    },
  ],
  exclusions: [{ path: 'src/components/Internal.tsx', reason: 'consumer-owned debug chrome' }],
});

const discovered = [
  { key: 'component-card', path: 'src/components/Card.tsx' },
  { key: 'component-internal', path: 'src/components/Internal.tsx' },
  { key: 'component-button', path: 'src/components/Button.tsx' },
];

test('componentManifestInventory reports exact declared, excluded-with-reason, and uncovered paths', () => {
  assert.deepEqual(componentManifestInventory(manifest, discovered), {
    declared: [
      {
        path: 'src/components/Button.tsx',
        export: 'Button',
        variants: ['default', 'loading'],
      },
    ],
    excludedWithReason: [
      {
        path: 'src/components/Internal.tsx',
        reason: 'consumer-owned debug chrome',
      },
    ],
    uncovered: ['src/components/Card.tsx'],
  });
});

test('componentManifestInventory normalizes separators and sorts every section', () => {
  const result = componentManifestInventory(manifest, [
    { key: 'z', path: 'src\\components\\Zed.tsx' },
    ...discovered,
    { key: 'a', path: 'src/components/Alpha.tsx' },
  ]);
  assert.deepEqual(result.uncovered, ['src/components/Alpha.tsx', 'src/components/Card.tsx', 'src/components/Zed.tsx']);
});

test('componentManifestInventory fails closed on overlapping declarations and exclusions', () => {
  const overlap = validateComponentManifest({
    version: 1,
    components: [{ module: 'src/components/Button.tsx', variants: [{ key: 'default' }] }],
    exclusions: [{ path: 'src/components/Button.tsx', reason: 'not actually excluded' }],
  });
  assert.throws(() => componentManifestInventory(overlap, discovered), ComponentInventoryError);
});

test('componentManifestInventory fails closed on duplicate discovered paths', () => {
  assert.throws(
    () =>
      componentManifestInventory(manifest, [...discovered, { key: 'duplicate', path: 'src/components/Button.tsx' }]),
    /duplicate discovered component path/i,
  );
});
