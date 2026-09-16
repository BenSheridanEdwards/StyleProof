// Synthetic base/head capture pairs for the Action dogfood workflow: one folder pair
// per trust state the Action must classify. Usage: node scripts/action-dogfood-fixtures.mjs <root> <baseSha> <headSha>
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildConfidenceLedger, writeConfidenceLedger } from '../dist/confidence-ledger.js';
import { solidPng, writeCapture as writeMapFiles } from './fixture-util.mjs';

const root = process.argv[2] || 'action-dogfood';
const baseSha = process.argv[3];
const headSha = process.argv[4];
const TRUSTED_SHA = /^[0-9a-f]{40}$/;
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PRODUCT_STATE = { id: 'action-dogfood-ready', revision: 'fixture-v1' };
const COVERAGE = 'styleproof-coverage.json';
const MANIFEST_FILE = 'styleproof-manifest.json';
const GREY = [240, 240, 240];

if (!TRUSTED_SHA.test(baseSha ?? '') || !TRUSTED_SHA.test(headSha ?? '')) {
  throw new Error('action dogfood fixtures require trusted base and head SHAs');
}

function map(color = 'rgb(0, 0, 0)', productState = PRODUCT_STATE) {
  return {
    defaults: {},
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 320, 180], style: {} },
      'body > main:nth-child(1)': { tag: 'main', cls: 'panel', rect: [24, 24, 180, 80], style: { color } },
    },
    states: {},
    metadata: productState ? { productState } : {},
  };
}
const mapWithoutProductState = () => map(undefined, undefined);

function mapWithAdditionalElement() {
  const styleMap = map();
  styleMap.elements['body > main:nth-child(1) > button:nth-child(1)'] = {
    tag: 'button',
    cls: 'action',
    rect: [32, 64, 96, 28],
    style: { color: 'rgb(0, 0, 0)' },
  };
  return styleMap;
}

// A map carrying a navigable inventory (route links): base offers /a + /b, head drops /b.
const mapNav = (routes) => ({
  ...map(),
  inventory: routes.map((r) => ({ key: `route:${r}`, kind: 'link', label: r, href: r })),
});

const mapWithResidue = () => ({
  ...map(),
  dataResidue: [{ key: 'home·/api/status', surface: 'home', endpoint: '/api/status', reason: 'HTTP 500' }],
});

const png = (rgb) => PNG.sync.write(solidPng(320, 180, rgb));

// Every fixture dir carries a manifest (a map-bearing dir without one is refused);
// identical on all sides so the same-environment guard passes.
const MANIFEST = {
  version: 1,
  packageVersion: PACKAGE_VERSION,
  dirty: false,
  spec: 'scripts/action-dogfood-fixtures.mjs',
  specHash: '1'.repeat(64),
  platform: process.platform,
  arch: process.arch,
  nodeMajor: process.versions.node.split('.')[0],
  screenshots: true,
  har: false,
  compatibilityKey: 'deadbeefdeadbeef',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function fixtureSha(dir) {
  const name = path.basename(dir);
  if (name.endsWith('-base')) return baseSha;
  if (name.endsWith('-head')) return headSha;
  throw new Error('action dogfood fixture directory must identify its source side');
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** Read `file` (or `fallback` when absent), merge `patch`, write it back. */
function patchJson(file, patch, fallback) {
  const prior = fs.existsSync(file) ? readJson(file) : fallback;
  fs.writeFileSync(file, JSON.stringify({ ...prior, ...patch }, null, 2));
}

function writeCapture(dir, surface, styleMap, image) {
  writeMapFiles(dir, surface, styleMap, image);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...MANIFEST, sha: fixtureSha(dir) }, null, 2));
  const file = path.join(dir, COVERAGE);
  const prior = fs.existsSync(file) ? readJson(file) : { expected: [] };
  const expected = [...new Set([...(prior.expected ?? []), surface.replace(/@[^@]+$/, '')])].sort();
  patchJson(
    file,
    { expected },
    { version: 1, expected: [], exclude: {}, determinism: 'self-checked', dataResidue: 'warn' },
  );
}

const patchCoverage = (dir, patch) => patchJson(path.join(dir, COVERAGE), patch);
const pair = (name, baseMap, headMap, basePng = GREY, headPng = GREY) => {
  writeCapture(path.join(root, `${name}-base`), 'home@320', baseMap, png(basePng));
  writeCapture(path.join(root, `${name}-head`), 'home@320', headMap, png(headPng));
};

fs.rmSync(root, { recursive: true, force: true });

pair('clean', map(), map());
pair('content', map(), mapWithAdditionalElement());
pair('changed', map('rgb(0, 0, 0)'), map('rgb(255, 0, 0)'), GREY, [255, 230, 230]);

pair('new', map(), map());
writeCapture(path.join(root, 'new-head'), 'pricing@320', map('rgb(0, 0, 255)'), png([230, 230, 255]));

// Partial baseline: base captured home but tolerated about@auto failure; head adds about@320.
pair('partial', map(), map());
patchJson(path.join(root, 'partial-base', MANIFEST_FILE), {
  surfaceCaptureFailures: [{ key: 'about@auto', reason: 'viewport detection failed on base', kind: 'capture' }],
});
writeCapture(path.join(root, 'partial-head'), 'about@320', map('rgb(0, 128, 0)'), png([230, 255, 230]));

// A base capture fault is not first-adoption evidence: keep the base genuinely bare.
fs.mkdirSync(path.join(root, 'degraded-base'), { recursive: true });
writeCapture(path.join(root, 'degraded-head'), 'home@320', map(), png(GREY));

pair('residue', map(), mapWithResidue());
for (const side of ['base', 'head']) patchCoverage(path.join(root, `residue-${side}`), { dataResidue: 'gate' });

// Inventory removal: an unacknowledged removal must fail even with fail-on-diff off.
pair('removed', mapNav(['/a', '/b']), mapNav(['/a']));

// Certification failure: identical maps, but unproven determinism must escalate to
// CERTIFICATION_FAILED — the state the approval box cannot clear.
pair('certfail', map(), map());
for (const side of ['base', 'head']) patchCoverage(path.join(root, `certfail-${side}`), { determinism: 'unproven' });

// Legacy product-state pairs: empty ledger → fail closed; declared `home` → advisory.
pair('legacy-undeclared', mapWithoutProductState(), mapWithoutProductState());
pair('legacy-declared', mapWithoutProductState(), mapWithoutProductState());
fs.writeFileSync(path.join(root, 'legacy-pairs-empty.json'), '{}\n');
fs.writeFileSync(
  path.join(root, 'legacy-pairs-declared.json'),
  `${JSON.stringify({ home: 'known dogfood shell pending identity stamp' }, null, 2)}\n`,
);

// Confidence ledgers last, so scenario-specific coverage mutations are reflected.
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(root, entry.name);
  const coveragePath = path.join(dir, COVERAGE);
  if (!fs.existsSync(coveragePath)) continue;
  const capturedKeys = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json.gz'))
    .map((name) => name.slice(0, -'.json.gz'.length).replace(/@[^@]+$/, ''));
  writeConfidenceLedger(dir, buildConfidenceLedger({ capturedKeys, coverage: readJson(coveragePath) }));
}
