import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeVlq, mapScriptCoverage } from '../dist/script-reach.js';

const sourceMap = {
  version: 3,
  sources: ['original.js'],
  sourcesContent: ['first();\nsecond();\n'],
  names: [],
  mappings: 'AAAA,KACA,KADA',
};
const entry = {
  functions: [
    {
      ranges: [
        { startOffset: 0, endOffset: 15, count: 1 },
        { startOffset: 5, endOffset: 10, count: 0 },
      ],
    },
  ],
};

test('VLQ decodes signed deltas and rejects invalid, truncated and overflowing values', () => {
  assert.deepEqual(decodeVlq('AAAA'), [0, 0, 0, 0]);
  assert.deepEqual(decodeVlq('DCEgB'), [-1, 1, 2, 16]);
  for (const value of ['!', 'g', '////////////////////A']) assert.throws(() => decodeVlq(value));
});

test('coverage maps executed and unexecuted branches to original lines and hashes content', () => {
  const [file] = mapScriptCoverage(entry, '123456789012345', sourceMap, 'https://example.test/app.js.map');
  assert.equal(file.source, 'https://example.test/original.js');
  assert.equal(file.contentHash, createHash('sha256').update(sourceMap.sourcesContent[0]).digest('hex'));
  assert.equal(file.executed[0].start.line, 1);
  assert.equal(file.unexecuted[0].start.line, 2);
});

test('a V8 boundary inside one mapped segment is mixed, not fully executed', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, mappings: 'AAAA' },
    'https://example.test/app.js.map',
  );
  assert.deepEqual(file.executed, []);
  assert.deepEqual(file.unexecuted, []);
  assert.deepEqual(file.mixed, [{ start: { line: 1, column: 0 }, end: { line: 1, column: 8 } }]);
});

test('missing original content leaves hash absent; vendored sources are excluded', () => {
  const map = { ...sourceMap, sourcesContent: undefined };
  assert.equal(
    mapScriptCoverage(entry, '123456789012345', map, 'https://example.test/app.js.map')[0].contentHash,
    undefined,
  );
  assert.deepEqual(
    mapScriptCoverage(
      entry,
      '123456789012345',
      { ...map, sources: ['webpack://app/node_modules/lib.js'] },
      'https://example.test/app.js.map',
    ),
    [],
  );
});

test('invalid source maps and unmapped spans never fabricate original coverage', () => {
  assert.throws(() => mapScriptCoverage(entry, '123', { ...sourceMap, version: 2 }, 'https://example.test/a.map'));
  assert.throws(() =>
    mapScriptCoverage(entry, '123', { ...sourceMap, mappings: 'ACAA' }, 'https://example.test/a.map'),
  );
  assert.deepEqual(mapScriptCoverage(entry, '123', { ...sourceMap, mappings: 'A' }, 'https://example.test/a.map'), []);
});

test('mixed original line retains executed and unexecuted column spans', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, sourcesContent: ['012345678901234'], mappings: 'AAAA,KAAK,KAAK' },
    'https://example.test/app.js.map',
  );
  assert.deepEqual(file.executed, [
    { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
    { start: { line: 1, column: 10 }, end: { line: 1, column: 15 } },
  ]);
  assert.deepEqual(file.unexecuted, [{ start: { line: 1, column: 5 }, end: { line: 1, column: 10 } }]);
});

test('unmapped segments terminate evidence and sourceRoot resolves relative sources', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, mappings: 'AAAA,K', sourceRoot: '../src' },
    'https://example.test/dist/app.js.map',
  );
  assert.equal(file.source, 'https://example.test/src/original.js');
  assert.deepEqual(file.unexecuted, []);
});

test('script self-check compares mapped evidence and rejects changed ranges or missing evidence', async () => {
  const { assertDeterministicScriptReach } = await import('../dist/runner/self-check.js');
  const { hashDeterminismMap } = await import('../dist/determinism-oracle.js');
  const scriptReach = {
    version: 1,
    window: 'navigation',
    status: 'measured',
    scripts: [
      {
        url: 'https://example.test/app.js',
        status: 'mapped',
        files: mapScriptCoverage(entry, '123456789012345', sourceMap, 'https://example.test/app.js.map'),
      },
    ],
  };
  const first = { elements: {}, scriptReach };
  const again = structuredClone(first);
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  again.scriptReach.scripts[0].files[0].executed = [];
  assert.throws(
    () => assertDeterministicScriptReach(first, again, 'home'),
    /self-check failed.*original-source script reach/,
  );
  assert.notEqual(hashDeterminismMap(first), hashDeterminismMap(again));
  assert.throws(() => assertDeterministicScriptReach(first, {}, 'home'), /missing/);
});

test('script reach defaults off and resolves independently of CSS reach', async () => {
  const { resolveSettings, captureOptionsFor } = await import('../dist/runner/settings.js');
  const defaults = resolveSettings({ dir: 'maps', freezeClock: false });
  assert.equal(defaults.captureScriptReach, false);
  const settings = resolveSettings({ dir: 'maps', freezeClock: false, captureScriptReach: true });
  assert.equal(settings.captureReach, false);
  assert.equal(captureOptionsFor({ key: 'home', go() {} }, settings, () => 0).captureScriptReach, true);
});

test('multiple generated branches mapping to one original span are mixed when execution conflicts', () => {
  const coverage = {
    functions: [
      {
        ranges: [
          { startOffset: 0, endOffset: 10, count: 1 },
          { startOffset: 5, endOffset: 10, count: 0 },
        ],
      },
    ],
  };
  const [file] = mapScriptCoverage(
    coverage,
    '0123456789',
    { ...sourceMap, mappings: 'AAAA,KAAA' },
    'https://example.test/app.js.map',
  );
  assert.deepEqual(file.executed, []);
  assert.deepEqual(file.unexecuted, []);
  assert.deepEqual(file.mixed, [{ start: { line: 1, column: 0 }, end: { line: 1, column: 8 } }]);
});

test('a rejecting script tracker adds unknown evidence without losing the map', async () => {
  const { attachScriptReach } = await import('../dist/capture/script-reach.js');
  const map = { elements: { body: { tag: 'body' } } };
  await attachScriptReach(map, {
    captureScriptReach: true,
    scriptReach: {
      async stop() {
        throw new Error('coverage read failed');
      },
    },
  });
  assert.equal(map.scriptReach.status, 'unknown');
  assert.deepEqual(map.elements, { body: { tag: 'body' } });
  const legacy = { elements: {} };
  await attachScriptReach(legacy, {});
  assert.equal(Object.hasOwn(legacy, 'scriptReach'), false);
});
