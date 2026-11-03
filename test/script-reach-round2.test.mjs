import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { assertDeterministicScriptReach } from '../dist/runner/self-check.js';

const text = 'ok(); if (f) bad(); tail();';
const coverage = {
  functions: [
    {
      ranges: [
        { startOffset: 0, endOffset: text.length, count: 1 },
        { startOffset: 12, endOffset: 19, count: 0 },
      ],
    },
  ],
};
const map = { version: 3, sources: ['src/app.js'], sourcesContent: [text], mappings: 'AAAA,K,cAAmB' };
const vlq = (n) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let v = Math.abs(n) * 2 + Number(n < 0),
    out = '';
  do {
    const d = v % 32;
    v = Math.floor(v / 32);
    out += chars[d + (v ? 32 : 0)];
  } while (v);
  return out;
};

test('Q1 exact repro: executed spans never bridge the unmapped gap over dead bad()', () => {
  const [file] = mapScriptCoverage(coverage, text, map, 'https://app.test/app.js.map');
  assert.ok(
    file.executed.every((span) => span.end.column <= 13 || span.start.column >= 19),
    JSON.stringify(file.executed),
  );
});

test('N3 null sources are unmapped barriers, not invalid source maps', () => {
  const files = mapScriptCoverage(
    coverage,
    text,
    { ...map, sources: [null, 'src/app.js'], sourcesContent: [null, text], mappings: 'AAAA,CCAA' },
    'https://app.test/a.map',
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].sourceKey, 'src/app.js');
});

test('N4 terminal original anchors outside sourcesContent cannot stretch a span', () => {
  assert.throws(
    () =>
      mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] },
        'x',
        { ...map, sourcesContent: ['0123456789'], mappings: 'AAAA,' + [1, 0, 0, 999].map(vlq).join('') },
        'https://app.test/a.map',
      ),
    /original position/,
  );
});

test('N1 source mapping has a segment-count guard before large indexes accumulate', () => {
  const count = 120_000;
  assert.throws(
    () =>
      mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: count + 1, count: 1 }] }] },
        'x'.repeat(count + 1),
        { ...map, sourcesContent: ['x'.repeat(count + 1)], mappings: 'AAAA,' + 'CAAC,'.repeat(count) },
        'https://app.test/a.map',
      ),
    /mapping.*limit/,
  );
});

test('N1 mapping rejects an expired CPU budget', () => {
  assert.throws(
    () => mapScriptCoverage(coverage, text, map, 'https://app.test/a.map', { deadline: 0 }),
    /mapping.*budget/,
  );
});

test('N6 source identity removes checkout roots and webpack namespaces', () => {
  const make = (source) =>
    mapScriptCoverage(coverage, text, { ...map, sources: [source] }, 'https://app.test/app.js.map', {
      projectRoot: source.startsWith('file:') ? path.dirname(path.dirname(fileURLToPath(source))) : process.cwd(),
    })[0];
  for (const source of [
    pathToFileURL(path.join(os.homedir(), 'checkout-one', 'src/app.js')).href,
    pathToFileURL(path.join(os.homedir(), 'checkout-two', 'src/app.js')).href,
    'webpack://fixture/src/app.js',
  ]) {
    const file = make(source);
    assert.equal(file.sourceKey, 'src/app.js');
    assert.equal(file.source, 'src/app.js');
    assert.ok(!JSON.stringify(file).includes(os.homedir()));
  }
});

test('B3 mapped execution drift records a named unknown and never throws', () => {
  const first = {
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [
        {
          url: 'https://app.test/a.js',
          status: 'mapped',
          files: mapScriptCoverage(coverage, text, map, 'https://app.test/a.map'),
        },
      ],
    },
  };
  const again = structuredClone(first);
  again.scriptReach.scripts[0].files[0].executed = [];
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  assert.equal(first.scriptReach.status, 'unknown');
  assert.match(first.scriptReach.reason, /^script evidence not reproducible: src\/app.js:1$/);
});

test('project roots preserve lib paths across different checkouts', () => {
  const make = (checkout) =>
    mapScriptCoverage(
      { functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }] },
      'xx',
      {
        version: 3,
        sources: ['a.js', 'b.js'].map((name) => pathToFileURL(path.join(os.homedir(), checkout, 'lib', name)).href),
        sourcesContent: ['x', 'x'],
        mappings: 'AAAA,CCAA',
      },
      'https://app.test/a.map',
      { projectRoot: path.join(os.homedir(), checkout) },
    );
  const a = make('checkout-one'),
    b = make('checkout-two');
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((f) => f.sourceKey),
    ['lib/a.js', 'lib/b.js'],
  );
  assert.ok(!JSON.stringify(a).includes(os.homedir()));
});

test('N2 compact evidence removes interior duplicate anchors but retains exclusive-end anchors', async () => {
  const { compactScriptEvidence } = await import('../dist/script-reach-storage.js');
  const span = (a, b) => ({ start: { line: 1, column: a }, end: { line: 1, column: b } });
  const file = {
    source: 'src/a.js',
    sourceKey: 'src/a.js',
    executed: [span(0, 5), span(2, 2), span(5, 5)],
    mixed: [],
    unexecuted: [],
  };
  assert.deepEqual(
    compactScriptEvidence({ url: 'https://app.test/a.js', status: 'mapped', files: [file] }).files[0].executed,
    [
      [1, 0, 5],
      [1, 5, 5],
    ],
  );
});

test('N6 development-server file URLs cannot retain home paths', async () => {
  const { storedScriptUrl } = await import('../dist/script-reach-identity.js');
  const url = 'https://app.test/@fs' + path.join(os.homedir(), 'checkout', 'src/app.js') + '?token=fixture#fragment';
  assert.equal(storedScriptUrl(url, path.join(os.homedir(), 'checkout')), 'https://app.test/src/app.js');
});
