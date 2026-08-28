import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

const root = process.argv[2] || 'action-dogfood';
const baseSha = process.argv[3];
const headSha = process.argv[4];
const TRUSTED_SHA = /^[0-9a-f]{40}$/;

if (!TRUSTED_SHA.test(baseSha ?? '') || !TRUSTED_SHA.test(headSha ?? '')) {
  throw new Error('action dogfood fixtures require trusted base and head SHAs');
}

function map(color = 'rgb(0, 0, 0)') {
  return {
    defaults: {},
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 320, 180], style: {} },
      'body > main:nth-child(1)': {
        tag: 'main',
        cls: 'panel',
        rect: [24, 24, 180, 80],
        style: { color },
      },
    },
    states: {},
  };
}

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

// A map that also carries a navigable inventory (route links), for the inventory-gate
// dogfood: base offers /a + /b, head drops /b → an unacknowledged removal that must fail
// the action even with fail-on-diff off (a removal isn't a restyle to wave through).
function mapNav(routes, color = 'rgb(0, 0, 0)') {
  return {
    ...map(color),
    inventory: routes.map((r) => ({ key: `route:${r}`, kind: 'link', label: r, href: r })),
  };
}

function mapWithResidue() {
  return {
    ...map(),
    dataResidue: [
      {
        key: 'home·/api/status',
        surface: 'home',
        endpoint: '/api/status',
        reason: 'HTTP 500',
      },
    ],
  };
}

function png([r, g, b]) {
  const image = new PNG({ width: 320, height: 180 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

// Since v4 a map-bearing dir without a styleproof-manifest.json is refused (exit 2),
// so every fixture dir carries one. Identical on all sides — the fixtures are
// synthetic, and the same-environment guard only needs the two sides to match.
const MANIFEST = {
  version: 1,
  packageVersion: '0.0.0-dogfood',
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

function writeSyntheticCoverage(dir, surface, overrides = {}) {
  const file = path.join(dir, 'styleproof-coverage.json');
  const prior = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { version: 1, expected: [], exclude: {}, determinism: 'self-checked', dataResidue: 'off' };
  const surfaceKey = surface.replace(/@[^@]+$/, '');
  const expected = [...new Set([...(prior.expected ?? []), surfaceKey])].sort();
  fs.writeFileSync(file, JSON.stringify({ ...prior, expected, ...overrides }, null, 2));
}

function writeCapture(dir, surface, styleMap, image) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(styleMap)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), image);
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({ ...MANIFEST, sha: fixtureSha(dir) }, null, 2),
  );
  writeSyntheticCoverage(dir, surface);
}

function armResidueGate(dir) {
  const file = path.join(dir, 'styleproof-coverage.json');
  const coverage = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...coverage, dataResidue: 'gate' }, null, 2));
}

// A side whose capture was neither self-checked nor replayed: the styles could
// have drifted and no one checked. assessDeterminism() turns that into
// status: 'unproven', which the Action must escalate to CERTIFICATION_FAILED —
// the state the approval box cannot clear (and the exact state 4.6.2's
// content-geometry bug hid in, undetected because it was never dogfooded).
function armUnprovenDeterminism(dir) {
  const file = path.join(dir, 'styleproof-coverage.json');
  const coverage = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...coverage, determinism: 'unproven' }, null, 2));
}

fs.rmSync(root, { recursive: true, force: true });

writeCapture(path.join(root, 'clean-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'clean-head'), 'home@320', map(), png([240, 240, 240]));

writeCapture(path.join(root, 'content-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'content-head'), 'home@320', mapWithAdditionalElement(), png([240, 240, 240]));

writeCapture(path.join(root, 'changed-base'), 'home@320', map('rgb(0, 0, 0)'), png([240, 240, 240]));
writeCapture(path.join(root, 'changed-head'), 'home@320', map('rgb(255, 0, 0)'), png([255, 230, 230]));

writeCapture(path.join(root, 'new-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'new-head'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'new-head'), 'pricing@320', map('rgb(0, 0, 255)'), png([230, 230, 255]));

// Partial baseline: base captured home but tolerated about@auto failure; head adds about@320.
// Diff exit 0 with explained gaps → PARTIAL_BASELINE (not visual approval).
function writePartialBaseManifest(dir) {
  const manifestPath = path.join(dir, 'styleproof-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.surfaceCaptureFailures = [
    { key: 'about@auto', reason: 'viewport detection failed on base', kind: 'capture' },
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
writeCapture(path.join(root, 'partial-base'), 'home@320', map(), png([240, 240, 240]));
writePartialBaseManifest(path.join(root, 'partial-base'));
writeCapture(path.join(root, 'partial-head'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'partial-head'), 'about@320', map('rgb(0, 128, 0)'), png([230, 255, 230]));

// A base capture fault is not first-adoption evidence: keep the base genuinely
// bare and prove the Action labels the head-only receipt as degraded.
fs.mkdirSync(path.join(root, 'degraded-base'), { recursive: true });
writeCapture(path.join(root, 'degraded-head'), 'home@320', map(), png([240, 240, 240]));

writeCapture(path.join(root, 'residue-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'residue-head'), 'home@320', mapWithResidue(), png([240, 240, 240]));
armResidueGate(path.join(root, 'residue-base'));
armResidueGate(path.join(root, 'residue-head'));

// Inventory removal: base offers routes /a + /b; head drops /b → unacknowledged removal.
writeCapture(path.join(root, 'removed-base'), 'home@320', mapNav(['/a', '/b']), png([240, 240, 240]));
writeCapture(path.join(root, 'removed-head'), 'home@320', mapNav(['/a']), png([240, 240, 240]));

// Certification failure: identical maps, but a side's determinism is unproven —
// the Action must NOT report NO_REVIEWABLE_STYLE_CHANGES; it certifies nothing and the
// approval box cannot clear it. Maps match so the ONLY thing under test is that
// unproven provenance escalates to CERTIFICATION_FAILED.
writeCapture(path.join(root, 'certfail-base'), 'home@320', map(), png([240, 240, 240]));
writeCapture(path.join(root, 'certfail-head'), 'home@320', map(), png([240, 240, 240]));
armUnprovenDeterminism(path.join(root, 'certfail-base'));
armUnprovenDeterminism(path.join(root, 'certfail-head'));
