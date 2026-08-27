// #392 S2 — the committed React reference fixture proves the manifest's
// deterministic catalog routes end to end: every surface from
// componentManifestCatalogSurfaces is served by the fixture app, renders its
// expected state, and the diagnostic pages render every diagnostic kind the
// static registry harness reports. React/react-dom/esbuild are devDependencies
// only — never runtime or peer — and the fixture lives under test/fixtures/
// so it can never ship in the packed package.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  componentManifestCatalogPath,
  componentManifestToDiscovered,
  validateComponentManifest,
  type ComponentManifest,
} from '../dist/component-manifest.js';
import { collectManifestDiagnostics } from '../dist/manifest-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'react-catalog');
const CATALOG_DIR = path.join(FIXTURE, 'catalog');
const ROOT = path.join(here, '..');

const MARKER = '__STYLEPROOF_COMPONENT_CATALOG_MARKER__';

let baseUrl: string;
let server: http.Server;
let outDir: string;
let manifest: ComponentManifest;

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), 'utf8'));
}

/** Broken manifest fixtures: JSON for schema-shaped problems, .mjs for the non-serializable props case. */
async function readBroken(name: string): Promise<unknown> {
  if (name === 'invalid-props') {
    return (await import(pathToFileURL(path.join(CATALOG_DIR, 'broken', 'invalid-props.mjs')).href)).default;
  }
  return readJson(`broken/${name}.json`);
}

/** Browser-safe stubs for the two node builtins the harness's validator imports. */
const STUB_ALIAS: Record<string, string> = {
  'node:fs': path.join(CATALOG_DIR, 'stubs', 'fs.js'),
  'node:path': path.join(CATALOG_DIR, 'stubs', 'path.js'),
};

test.beforeAll(async () => {
  // The manifest validates, and every variant's props survive JSON round-trips
  // (serializable committed dummy data — no functions, no undefined, no NaN).
  manifest = validateComponentManifest(readJson('manifest.json'), { cwd: ROOT });
  for (const component of manifest.components) {
    for (const variant of component.variants) {
      if (variant.props !== undefined) {
        expect(JSON.parse(JSON.stringify(variant.props))).toEqual(variant.props);
      }
    }
  }

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-react-catalog-'));
  await build({
    entryPoints: [path.join(CATALOG_DIR, 'entry.catalog.jsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    outfile: path.join(outDir, 'catalog.iife.js'),
    jsx: 'automatic',
    minify: true,
    alias: STUB_ALIAS,
    logLevel: 'silent',
  });
  const html = fs
    .readFileSync(path.join(CATALOG_DIR, 'index.html'), 'utf8')
    .replace('</body>', '    <script src="/catalog.iife.js"></script>\n  </body>');
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(outDir, relative);
    if (!file.startsWith(outDir + path.sep) && file !== outDir) {
      response.writeHead(403).end();
      return;
    }
    // SPA fallback: the catalog routes exist only in the client router.
    const served = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(outDir, 'index.html');
    let body: Buffer;
    try {
      body = fs.readFileSync(served);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
    };
    response.writeHead(200, { 'content-type': types[path.extname(served)] ?? 'application/octet-stream' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('catalog routes are exactly the componentManifestCatalogSurfaces routes', () => {
  const discovered = componentManifestToDiscovered(manifest);
  expect(discovered.length).toBeGreaterThan(0);
  for (const { key } of discovered) {
    expect(componentManifestCatalogPath(key, { catalogBasePath: manifest.catalogBasePath })).toBe(
      `/styleproof/components/${key}`,
    );
  }
});

const SURFACE_CASES: Array<{ key: string; assert: (page: import('@playwright/test').Page) => Promise<void> }> = [
  {
    key: 'component-button-default',
    assert: async (page) => {
      const button = page.getByRole('button', { name: 'Save' });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(page.locator('[data-testid="button-loading"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="button-error"]')).toHaveCount(0);
    },
  },
  {
    key: 'component-button-disabled',
    assert: async (page) => {
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    },
  },
  {
    key: 'component-button-loading',
    assert: async (page) => {
      await expect(page.locator('[data-testid="button-loading"]')).toHaveText('Loading…');
      await expect(page.getByRole('button', { name: /Loading/i })).toBeDisabled();
    },
  },
  {
    key: 'component-button-error',
    assert: async (page) => {
      await expect(page.locator('[data-testid="button-error"]')).toHaveText('Could not save your changes');
      await expect(page.getByRole('button', { name: /Could not save/i })).toBeDisabled();
    },
  },
  {
    key: 'component-modal-open',
    assert: async (page) => {
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog.getByRole('heading', { name: 'Delete account?' })).toBeVisible();
      await expect(dialog.getByText('This cannot be undone.')).toBeVisible();
    },
  },
  {
    key: 'component-empty-default',
    assert: async (page) => {
      await expect(page.locator('[data-testid="empty-state"]')).toHaveText('No items yet');
      await expect(page.locator('[data-testid="empty-state"]')).toHaveClass('is-empty');
    },
  },
  {
    key: 'component-loading-default',
    assert: async (page) => {
      await expect(page.locator('[data-testid="loading-state"]')).toHaveText('Loading…');
      await expect(page.locator('[data-testid="loading-state"]')).toHaveRole('status');
    },
  },
  {
    key: 'component-error-default',
    assert: async (page) => {
      await expect(page.locator('[data-testid="error-state"]')).toHaveText('Something went wrong');
      await expect(page.locator('[data-testid="error-state"]')).toHaveRole('alert');
    },
  },
];

for (const { key, assert: assertSurface } of SURFACE_CASES) {
  test(`fixture renders the ${key} surface deterministically`, async ({ page }) => {
    await page.goto(`${baseUrl}${componentManifestCatalogPath(key, { catalogBasePath: manifest.catalogBasePath })}`);
    await assertSurface(page);
    // Positive control at runtime: the catalog bundle was shipped to this page.
    expect(await page.evaluate((marker) => (globalThis as Record<string, unknown>)[marker], MARKER)).toBe(MARKER);
  });
}

test('fixture shows an unknown surface as missing, never a silent blank', async ({ page }) => {
  await page.goto(`${baseUrl}/styleproof/components/component-button-nope`);
  await expect(page.locator('[data-testid="surface-missing"]')).toHaveText(/unknown surface/i);
});

const DIAGNOSTIC_CASES: Array<{ name: string; kind: string; messagePattern: RegExp }> = [
  { name: 'missing-export', kind: 'missing-export', messagePattern: /NeverExported/ },
  { name: 'missing-provider', kind: 'missing-provider', messagePattern: /ModalProvider/ },
  { name: 'invalid-props', kind: 'invalid-props', messagePattern: /JSON-serializable/ },
  { name: 'duplicate-keys', kind: 'duplicate-keys', messagePattern: /duplicate surface key/ },
];

for (const { name, kind, messagePattern } of DIAGNOSTIC_CASES) {
  test(`fixture renders the ${kind} diagnostic`, async ({ page }) => {
    await page.goto(`${baseUrl}/styleproof/diagnostics/${name}`);
    const entry = page.locator(`[data-testid="diagnostic"]`, { hasText: kind });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(messagePattern);
  });
}

test('the static registry harness reports the same diagnostics the fixture renders', async () => {
  // Mirrors catalog/modules.mjs: the fixture dev entry statically imports each
  // component; the provider file EXISTS but is intentionally not wired in.
  const registry = {
    'test/fixtures/react-catalog/catalog/components/Button.jsx': { exports: ['Button', 'default'] },
    'test/fixtures/react-catalog/catalog/components/Modal.jsx': { exports: ['Modal', 'default'] },
    'test/fixtures/react-catalog/catalog/components/Empty.jsx': { exports: ['Empty', 'default'] },
    'test/fixtures/react-catalog/catalog/components/Loading.jsx': { exports: ['Loading', 'default'] },
    'test/fixtures/react-catalog/catalog/components/Error.jsx': { exports: ['Error', 'default'] },
  };
  for (const { name, kind } of DIAGNOSTIC_CASES) {
    const diagnostics = collectManifestDiagnostics(await readBroken(name), registry, { cwd: ROOT });
    expect(diagnostics.map((d) => d.kind)).toEqual([kind]);
  }
});
