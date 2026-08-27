import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const catalog = path.join(here, 'fixtures', 'react-catalog', 'catalog');
const marker = '__STYLEPROOF_COMPONENT_CATALOG_MARKER__';

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(catalog, entry)],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    outfile,
    jsx: 'automatic',
    minify: true,
    alias: {
      'node:fs': path.join(catalog, 'stubs', 'fs.js'),
      'node:path': path.join(catalog, 'stubs', 'path.js'),
    },
    logLevel: 'silent',
  });
  return fs.readFileSync(outfile, 'utf8');
}

test('production entry excludes React and the component catalog unless the consumer imports it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-component-bundle-'));
  try {
    const plain = await bundle('entry.plain.jsx', path.join(tmp, 'plain.js'));
    const catalogBundle = await bundle('entry.catalog.jsx', path.join(tmp, 'catalog.js'));

    assert.doesNotMatch(plain, new RegExp(marker), 'plain production entry leaked the catalog marker');
    assert.doesNotMatch(plain, /react(?:-dom)?/i, 'plain production entry leaked React');
    assert.match(catalogBundle, new RegExp(marker), 'positive control did not include the catalog marker');
    assert.ok(catalogBundle.length > plain.length, 'positive control did not bundle the catalog harness');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('React and esbuild remain development-only and production source never imports React', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom', 'esbuild']) {
    assert.ok(manifest.devDependencies?.[name], `${name} must be a devDependency`);
    assert.equal(manifest.dependencies?.[name], undefined, `${name} leaked into runtime dependencies`);
    assert.equal(manifest.peerDependencies?.[name], undefined, `${name} leaked into peerDependencies`);
  }

  for (const directory of ['src', 'bin']) {
    const pending = [path.join(root, directory)];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name)) {
          const source = fs.readFileSync(absolute, 'utf8');
          assert.doesNotMatch(source, /from\s+['"]react(?:-dom(?:\/client)?)?['"]/, `${absolute} imports React`);
        }
      }
    }
  }
});
