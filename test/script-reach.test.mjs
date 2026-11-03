import test from 'node:test';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
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
  assert.equal(file.source, 'original.js');
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
  assert.deepEqual(file.mixed, [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }]);
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

test('mixed original line retains distinct executed and unexecuted anchors', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, sourcesContent: ['012345678901234'], mappings: 'AAAA,KAAK,KAAK' },
    'https://example.test/app.js.map',
  );
  assert.deepEqual(file.executed, [
    { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    { start: { line: 1, column: 10 }, end: { line: 1, column: 10 } },
  ]);
  assert.deepEqual(file.unexecuted, [{ start: { line: 1, column: 5 }, end: { line: 1, column: 5 } }]);
});

test('unmapped segments terminate evidence and sourceRoot resolves relative sources', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, mappings: 'AAAA,K', sourceRoot: '../src' },
    'https://example.test/dist/app.js.map',
  );
  assert.equal(file.source, 'src/original.js');
  assert.deepEqual(file.unexecuted, []);
});

test('script self-check compares mapped evidence and records changed or missing evidence as unknown', async () => {
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
        files: compactScriptEvidence({
          url: 'https://example.test/app.js',
          status: 'mapped',
          files: mapScriptCoverage(entry, '123456789012345', sourceMap, 'https://example.test/app.js.map'),
        }).files,
      },
    ],
  };
  const first = { elements: {}, scriptReach };
  const again = structuredClone(first);
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  again.scriptReach.scripts[0].files[0].executed = [];
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  assert.equal(first.scriptReach.status, 'unknown');
  assert.notEqual(hashDeterminismMap(first), hashDeterminismMap(again));
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, {}, 'home'));
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
  assert.deepEqual(file.mixed, [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }]);
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

for (const mappings of ['AAAA', 'AAAA,K']) {
  test(`trailing unmapped code stays outside executed evidence: ${mappings}`, () => {
    const [file] = mapScriptCoverage(
      { functions: [{ ranges: [{ startOffset: 0, endOffset: 19, count: 1 }] }] },
      'ok(); if (f) bad();',
      { version: 3, sources: ['a.js'], sourcesContent: ['ok(); if (f) bad();'], mappings },
      'https://app.test/a.map',
    );
    assert.deepEqual(file.executed, [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }]);
  });
}

test('original anchors are indexed across generated order and unmapped gaps', () => {
  const [file] = mapScriptCoverage(
    entry,
    '123456789012345',
    { ...sourceMap, sourcesContent: ['ok(); if (f) bad();'], mappings: 'AAAU,K,K AAV'.replaceAll(' ', '') },
    'https://app.test/a.map',
  );
  assert.deepEqual(file.executed, [
    { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
    { start: { line: 1, column: 10 }, end: { line: 1, column: 10 } },
  ]);
});

test('20k segments and 10k V8 ranges map within a generous linear-sweep budget', () => {
  const count = 20_000;
  const generated = 'x'.repeat(count);
  const map = {
    version: 3,
    sources: ['a.js'],
    sourcesContent: [generated],
    mappings:
      'AAAA,' +
      Array(count - 1)
        .fill('CAAC')
        .join(','),
  };
  const ranges = [
    { startOffset: 0, endOffset: count, count: 1 },
    ...Array.from({ length: count / 2 }, (_, i) => ({ startOffset: i * 2, endOffset: i * 2 + 1, count: 0 })),
  ];
  const before = performance.now();
  const files = mapScriptCoverage({ functions: [{ ranges }] }, generated, map, 'https://app.test/a.map');
  const elapsed = performance.now() - before;
  assert.equal(files.length, 1);
  assert.ok(elapsed < 1800, `mapping took ${elapsed.toFixed(1)} ms (budget 1800 ms)`);
});

test('original source key is independent of capture origin and port', () => {
  const map = { ...sourceMap, sourceRoot: '../src' };
  const first = mapScriptCoverage(entry, '123456789012345', map, 'http://localhost:3100/dist/a.map')[0];
  const second = mapScriptCoverage(entry, '123456789012345', map, 'http://localhost:4100/dist/a.map')[0];
  assert.equal(first.sourceKey, 'src/original.js');
  assert.equal(first.sourceKey, second.sourceKey);
});

for (const gap of ['blob', 'query', 'timeout', 'third-party']) {
  test(`non-mapped ${gap} drift becomes unknown without failing self-check`, async () => {
    const { assertDeterministicScriptReach } = await import('../dist/runner/self-check.js');
    const evidence = (url, status = 'unmeasured') => ({
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [{ url, status, reason: 'source map absent' }],
    });
    const first = {
      scriptReach: evidence(gap === 'blob' ? 'blob:https://app.test/one' : 'https://app.test/unmapped.js?cache=1'),
    };
    const again = {
      scriptReach: evidence(
        gap === 'blob' ? 'blob:https://app.test/two' : 'https://app.test/unmapped.js?cache=2',
        gap === 'timeout' ? 'unknown' : 'unmeasured',
      ),
    };
    if (gap === 'third-party') again.scriptReach.scripts = [];
    assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
    assert.equal(first.scriptReach.status, 'unknown');
    assert.equal(first.scriptReach.reason, 'script evidence not reproducible');
  });
}

test('mapped app evidence ignores generated URLs and capture origins', async () => {
  const { assertDeterministicScriptReach } = await import('../dist/runner/self-check.js');
  const file = {
    source: 'http://localhost:3100/src/app.js',
    sourceKey: '/src/app.js',
    contentHash: 'hash',
    executed: [[1, 0, 4]],
    mixed: [],
    unexecuted: [],
  };
  const evidence = (url, source) => ({
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [{ url, status: 'mapped', files: [{ ...file, source }] }],
    },
  });
  const first = evidence('https://app.test/a.js?cache=1', file.source);
  const again = evidence('https://app.test/a.js?cache=2', 'http://localhost:4100/src/app.js');
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  assert.equal(first.scriptReach.status, 'measured');
});

test('non-Chromium reports the correct reason without probing coverage', async () => {
  const { trackScriptReach } = await import('../dist/capture/script-reach.js');
  const page = {
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'firefox' }) }) }),
    coverage: {
      startJSCoverage: async () => {
        throw new Error('must not probe');
      },
      stopJSCoverage: async () => {
        throw new Error('must not probe');
      },
    },
  };
  const tracker = await trackScriptReach(page);
  assert.equal((await tracker.stop()).reason, 'script coverage requires Chromium');
  await tracker.dispose();
});

test('a map-fetch failure on one run becomes unknown instead of a self-check failure', async () => {
  const { assertDeterministicScriptReach } = await import('../dist/runner/self-check.js');
  const first = {
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [
        {
          url: 'https://app.test/bundle.js',
          status: 'mapped',
          files: compactScriptEvidence({
            url: 'https://app.test/a.js',
            status: 'mapped',
            files: mapScriptCoverage(entry, '123456789012345', sourceMap, 'https://app.test/a.map'),
          }).files,
        },
      ],
    },
  };
  const again = {
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [{ url: 'https://app.test/bundle.js', status: 'unknown', reason: 'script map-read budget exhausted' }],
    },
  };
  assert.doesNotThrow(() => assertDeterministicScriptReach(first, again, 'home'));
  assert.equal(first.scriptReach.reason, 'script evidence not reproducible');
});
