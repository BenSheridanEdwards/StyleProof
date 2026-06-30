import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { componentCatalogSurfaces, discoverComponentFiles } from '../dist/components.js';
import { mkTmp, rmTmp } from './helpers.mjs';

function touch(root, rel) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
}

test('discoverComponentFiles: inventories framework component files with stable keys', () => {
  const root = mkTmp();
  try {
    touch(root, 'src/components/AppModal.tsx');
    touch(root, 'src/components/dashboard/UserMenu.jsx');
    touch(root, 'src/components/popovers/HelpPopover.vue');
    touch(root, 'src/components/toasts/ToastHost.svelte');
    touch(root, 'src/components/cards/PromoCard.astro');

    const components = discoverComponentFiles({ cwd: root, roots: ['src/components'] });
    assert.deepEqual(
      components.map((c) => c.key),
      [
        'component-app-modal',
        'component-cards-promo-card',
        'component-dashboard-user-menu',
        'component-popovers-help-popover',
        'component-toasts-toast-host',
      ],
    );
  } finally {
    rmTmp(root);
  }
});

test('discoverComponentFiles: ignores tests, stories, barrels, build output, and custom patterns', () => {
  const root = mkTmp();
  try {
    touch(root, 'components/Button.tsx');
    touch(root, 'components/Button.test.tsx');
    touch(root, 'components/Button.stories.tsx');
    touch(root, 'components/index.tsx');
    touch(root, 'components/__tests__/Dialog.tsx');
    touch(root, 'components/internal/FixtureOnly.tsx');
    touch(root, 'components/dist/Generated.tsx');

    const components = discoverComponentFiles({
      cwd: root,
      roots: ['components'],
      ignore: [/^components\/internal\//],
    });
    assert.deepEqual(components, [{ key: 'component-button', path: 'components/Button.tsx' }]);
  } finally {
    rmTmp(root);
  }
});

test('discoverComponentFiles: throws on duplicate keys instead of silently picking one', () => {
  const root = mkTmp();
  try {
    touch(root, 'a/Button.tsx');
    touch(root, 'b/Button.tsx');
    assert.throws(
      () => discoverComponentFiles({ cwd: root, roots: ['a', 'b'] }),
      /StyleProof component key collision: component-button/,
    );
  } finally {
    rmTmp(root);
  }
});

test('discoverComponentFiles: throws when a component root is missing', () => {
  const root = mkTmp();
  try {
    assert.throws(
      () => discoverComponentFiles({ cwd: root, roots: ['src/components'] }),
      /StyleProof component root not found: src\/components/,
    );
  } finally {
    rmTmp(root);
  }
});

test('componentCatalogSurfaces: maps inventory to app-owned catalog URLs', async () => {
  const components = [
    { key: 'component-app-modal', path: 'src/components/AppModal.tsx' },
    { key: 'component-toast-host', path: 'src/components/ToastHost.tsx' },
  ];
  const visits = [];
  const surfaces = componentCatalogSurfaces(components, {
    url: (component) => `/catalog/${component.key}`,
    widths: [390, 1024],
    ignore: ['[data-clock]'],
  });

  assert.deepEqual(
    surfaces.map((surface) => surface.key),
    ['component-app-modal', 'component-toast-host'],
  );
  assert.deepEqual(surfaces[0].widths, [390, 1024]);
  assert.deepEqual(surfaces[0].ignore, ['[data-clock]']);
  await surfaces[1].go({ goto: async (url) => visits.push(url) });
  assert.deepEqual(visits, ['/catalog/component-toast-host']);
});
