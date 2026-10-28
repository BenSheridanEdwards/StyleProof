import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffStyleMapDirs } from '../dist/diff.js';
import { loadStyleMap } from '../dist/index.js';
import * as mapIO from '../dist/capture/map-io.js';
import { authoringSurfaceKeysInMapDir } from '../dist/selective-remap.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { collectStructureElevation } from '../dist/structure-elevation.js';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { generateStyleMapReport } from '../dist/report.js';
import { readCompareEvidence } from '../bin/diff/read.mjs';
import { withCaptureDirs } from '../bin/compare.mjs';
import { mkTmp, rmTmp, makeMap, writeCapture, fixtureCompatibilityKey } from './helpers.mjs';

const BUTTON = 'body > main > button';
const ADDED = 'body > main > p';
const LIVE = 'body > aside';

function fixture(t) {
  const root = mkTmp('styleproof-load-once-');
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const maps = [];

  for (const dir of [beforeDir, afterDir]) {
    fs.mkdirSync(dir);
    const head = dir === afterDir;

    for (const surface of ['home@1280', 'pricing@1280', 'settings@1280', 'plain@1280']) {
      if (!head && surface === 'plain@1280') continue;

      const map = {
        ...makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800] },
            'body > main': { tag: 'main', rect: [0, 60, 1000, 600] },
            [BUTTON]: { tag: 'button', rect: [20, 80, 100, 40], style: { color: head ? 'blue' : 'gray' } },
            [LIVE]: { tag: 'aside', rect: [0, 700, 100, 20] },
          },
        }),
        metadata: { surfaceKey: surface.replace('@1280', '') },
        volatile: [LIVE],
        liveCandidates: [{ path: LIVE, tag: 'aside', cls: '', reason: 'clock' }],
        inventory: [{ key: 'nav-button:home', kind: 'nav-button', label: 'Home' }],
        dataResidue: [{ key: 'home·/api/probe', surface: 'home', endpoint: '/api/probe', reason: 'HTTP 503' }],
      };

      if (head) map.elements[ADDED] = { tag: 'p', cls: '', style: {}, rect: [20, 150, 100, 40] };
      const file = path.join(dir, `${surface}.json${surface.startsWith('plain') ? '' : '.gz'}`);

      if (file.endsWith('.gz')) writeCapture(dir, surface, map);
      else fs.writeFileSync(file, JSON.stringify(map));
      maps.push(file);
    }

    fs.writeFileSync(
      path.join(dir, MAP_MANIFEST),
      JSON.stringify({
        version: 1,
        packageVersion: 'test',
        sha: 'a'.repeat(40),
        dirty: false,
        spec: 'test.spec.ts',
        specHash: 'a'.repeat(64),
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: false,
        har: false,
        compatibilityKey: fixtureCompatibilityKey('test'),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    fs.writeFileSync(
      path.join(dir, COVERAGE_LEDGER),
      JSON.stringify({
        version: 1,
        expected: null,
        exclude: {},
        determinism: 'replayed',
        dataResidue: 'gate',
      }),
    );
  }

  return { root, beforeDir, afterDir, maps };
}

function countMapReads(t, maps, expected = 1) {
  const open = t.mock.method(fs, 'openSync');

  return () => {
    const counts = maps.map((file) => [file, open.mock.calls.filter(({ arguments: args }) => args[0] === file).length]);
    open.mock.restore();
    assert.deepEqual(
      counts,
      maps.map((file) => [file, expected]),
      `each capture must be opened exactly ${expected} time(s)`,
    );
  };
}

function reportEvidence(dirs, outDir) {
  const { reportJsonPath, reportMdPath, reportHtmlPath, ...verdict } = generateReport({ ...dirs, outDir });
  assert.ok(fs.existsSync(reportHtmlPath));
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  return { json: digest(reportJsonPath), md: digest(reportMdPath), verdict };
}

test('diff evidence and structure elevation open each gzip and plain map once', (t) => {
  const dirs = fixture(t);
  const assertReads = countMapReads(t, dirs.maps);

  const evidence = readCompareEvidence(
    'styleproof-diff',
    { ...dirs, changeReach: 'gate' },
    { migration: false, pixels: false },
  );

  const elevation = collectStructureElevation({
    ...dirs,
    migration: false,
    surfacePaths: evidence.surfacePaths,
    surfaceKeyOf: evidence.surfaceKeyOf,
  });

  assert.equal(evidence.result.counts.style, 3);
  assert.ok(elevation.dom > 0, 'the added visible elements must be elevated');
  assert.equal(evidence.inventoryAudit.delta.removed.length, 0);
  assert.equal(evidence.residueAudit.unacknowledged.length, 1);
  assertReads();
});

test('report opens each map once across repeated reports in one process', (t) => {
  const dirs = fixture(t);
  const assertReads = countMapReads(t, dirs.maps);
  const first = reportEvidence(dirs, path.join(dirs.root, 'report-1'));
  const second = reportEvidence(dirs, path.join(dirs.root, 'report-2'));
  assert.deepEqual(second, first);
  assertReads();
});

test('large no-change catalogue reports parse each capture once and still catch injected changes', async (t) => {
  for (const mode of ['nochange', 'css', 'element']) {
    await t.test(mode, (t) => {
      const dirs = fixture(t);

      for (const file of dirs.maps) fs.unlinkSync(file);
      const files = [];

      for (let index = 0; index < 265; index++) {
        for (const dir of [dirs.beforeDir, dirs.afterDir]) {
          const map = makeMap({
            elements: {
              [BUTTON]: { tag: 'button', rect: [20, 80, 100, 40], style: { color: 'gray' } },
            },
          });

          if (dir === dirs.afterDir && index === 264) {
            if (mode === 'css') map.elements[BUTTON].style.color = 'blue';

            if (mode === 'element') map.elements[ADDED] = { tag: 'p', cls: '', rect: [20, 150, 100, 40], style: {} };
          }

          const surface = `example-${index}@1280`;
          writeCapture(dir, surface, map);
          files.push(path.join(dir, `${surface}.json.gz`));
        }
      }

      const assertReads = countMapReads(t, files);
      const result = generateStyleMapReport({ ...dirs, outDir: path.join(dirs.root, 'report') });
      assert.equal(result.comparison.hasReviewableEvidence, mode !== 'nochange');
      assert.equal(result.comparison.blocksCertification, false);
      assert.equal(result.totalFindings, mode === 'css' ? 1 : 0);
      assert.equal(result.comparison.reviewableCounts.dom, mode === 'element' ? 1 : 0);
      assertReads();

      // The CLI bracket hashes every file before and after reading: two receipt reads plus one parse.
      const assertDiffReads = countMapReads(t, files, 3);

      const evidence = withCaptureDirs('styleproof-diff', dirs, () => {
        const evidence = readCompareEvidence('styleproof-diff', dirs, { migration: false, pixels: false });

        const elevation = collectStructureElevation({
          ...dirs,
          migration: false,
          surfacePaths: evidence.surfacePaths,
          surfaceKeyOf: evidence.surfaceKeyOf,
        });

        return { ...evidence, elevation };
      });

      assert.equal(evidence.result.counts.style, mode === 'css' ? 1 : 0);
      assert.equal(evidence.elevation.dom, mode === 'element' ? 1 : 0);
      assertDiffReads();
    });
  }
});

test('warm and cold paths produce identical report digests, verdicts and diffs', (t) => {
  const dirs = fixture(t);
  const firstDiff = diffStyleMapDirs(dirs.beforeDir, dirs.afterDir);
  const warm = reportEvidence(dirs, path.join(dirs.root, 'warm-report'));
  const cold = { beforeDir: path.join(dirs.root, 'cold-before'), afterDir: path.join(dirs.root, 'cold-after') };
  fs.cpSync(dirs.beforeDir, cold.beforeDir, { recursive: true });
  fs.cpSync(dirs.afterDir, cold.afterDir, { recursive: true });
  assert.deepEqual(reportEvidence(cold, path.join(dirs.root, 'cold-report')), warm);
  assert.deepEqual(diffStyleMapDirs(dirs.beforeDir, dirs.afterDir), firstDiff);
  assert.deepEqual(diffStyleMapDirs(cold.beforeDir, cold.afterDir), firstDiff);
});

test('rewrites invalidate shared maps even at the same size with restored mtime', async (t) => {
  const dirs = fixture(t);
  const file = path.join(dirs.afterDir, 'plain@1280.json');
  fs.copyFileSync(path.join(dirs.beforeDir, 'home@1280.json.gz'), path.join(dirs.beforeDir, 'plain@1280.json.gz'));

  const findings = () =>
    diffStyleMapDirs(dirs.beforeDir, dirs.afterDir).surfaces.find((s) => s.surface === 'plain@1280').findings;

  const colors = () =>
    findings()
      .flatMap((f) => f.props ?? [])
      .filter((p) => p.prop === 'color')
      .map((p) => p.after);

  assert.deepEqual(colors(), ['blue']);
  const map = loadStyleMap(file);
  map.elements[BUTTON].style.color = 'purple';
  fs.writeFileSync(file, JSON.stringify(map));
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  assert.deepEqual(colors(), ['purple']);
  const before = fs.statSync(file, { bigint: true });
  const times = fs.statSync(file);
  map.elements[BUTTON].style.color = 'orange';
  // Wait for an observable filesystem tick rather than assuming nanosecond precision.

  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(file, JSON.stringify(map));
    fs.utimesSync(file, times.atime, times.mtime);

    if (fs.statSync(file, { bigint: true }).ctimeNs !== before.ctimeNs) break;
  }

  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.size, before.size, 'same-size replacement');
  assert.equal(after.mtimeNs, before.mtimeNs, 'mtime restored exactly');
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(colors(), ['orange']);
});

test('public loadStyleMap returns fresh mutable maps without changing later diffs', (t) => {
  const dirs = fixture(t);
  const expected = diffStyleMapDirs(dirs.beforeDir, dirs.afterDir);
  const file = dirs.maps[0];
  const first = loadStyleMap(file);
  const second = loadStyleMap(file);
  assert.equal(Object.isFrozen(first), false);
  assert.equal(Object.isFrozen(first.elements[BUTTON].style), false);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.elements[BUTTON], second.elements[BUTTON]);
  first.elements[BUTTON].style.color = 'orange';
  assert.equal(second.elements[BUTTON].style.color, 'gray');
  assert.deepEqual(diffStyleMapDirs(dirs.beforeDir, dirs.afterDir), expected);
});

test('shared loader keeps the public default file size limit and exact error', (t) => {
  const dirs = fixture(t);
  const file = path.join(dirs.root, 'oversized.json');
  const descriptor = fs.openSync(file, 'w');

  try {
    fs.ftruncateSync(descriptor, mapIO.MAX_STYLE_MAP_FILE_BYTES + 1);
  } finally {
    fs.closeSync(descriptor);
  }

  let message;
  assert.throws(
    () => loadStyleMap(file),
    (e) => {
      message = e.message;

      return /oversized/.test(message);
    },
  );
  assert.throws(
    () => mapIO.loadSharedStyleMap(file),
    (e) => e.message === message,
  );
});

test('shared loader refuses symlinks on cold and previously cached paths', (t) => {
  const dirs = fixture(t);
  const target = dirs.maps[0];
  const warm = path.join(dirs.root, 'warm.json.gz');
  const cold = path.join(dirs.root, 'cold.json.gz');
  fs.copyFileSync(target, warm);
  mapIO.loadSharedStyleMap(warm);
  fs.unlinkSync(warm);
  fs.symlinkSync(target, warm);
  fs.symlinkSync(target, cold);

  for (const file of [warm, cold]) {
    let message;
    assert.throws(
      () => loadStyleMap(file),
      (e) => {
        message = e.message;

        return /symbolic-link/.test(message);
      },
    );
    assert.throws(
      () => mapIO.loadSharedStyleMap(file),
      (e) => e.message === message,
    );
  }
});

test('shared loader evicts old maps after 128 distinct captures', (t) => {
  const dirs = fixture(t);
  const firstFile = dirs.maps[0];
  const first = mapIO.loadSharedStyleMap(firstFile);

  for (let index = 0; index < 128; index++) {
    const file = path.join(dirs.root, `capture-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(makeMap()));
    mapIO.loadSharedStyleMap(file);
  }

  assert.notStrictEqual(mapIO.loadSharedStyleMap(firstFile), first);
});

test('read scopes retain maps through nested readers and release them after success or failure', (t) => {
  const dirs = fixture(t);
  const firstFile = dirs.maps[0];

  for (const fail of [false, true]) {
    let first;

    const read = () =>
      mapIO.withStyleMapReadScope(() => {
        first = mapIO.loadSharedStyleMap(firstFile);
        mapIO.withStyleMapReadScope(() => {
          for (let index = 0; index < 129; index++) {
            const file = path.join(dirs.root, `scoped-${index}.json`);
            fs.writeFileSync(file, JSON.stringify(makeMap()));
            mapIO.loadSharedStyleMap(file);
          }
        });
        assert.strictEqual(mapIO.loadSharedStyleMap(firstFile), first);

        if (fail) throw new Error('reader failed');
      });

    if (fail) assert.throws(read, /reader failed/);
    else read();
    assert.notStrictEqual(mapIO.loadSharedStyleMap(firstFile), first);
  }
});

test('authoring key scans do not retain parsed base maps', (t) => {
  const dirs = fixture(t);
  authoringSurfaceKeysInMapDir(dirs.beforeDir);
  const files = dirs.maps.filter((file) => path.dirname(file) === dirs.beforeDir);
  const assertReads = countMapReads(t, files);

  for (const file of files) mapIO.loadSharedStyleMap(file);
  assertReads();
});

test('migration structure elevation does not read capture maps', (t) => {
  const dirs = fixture(t);
  fs.writeFileSync(dirs.maps[0], 'corrupt');
  assert.deepEqual(
    collectStructureElevation({
      ...dirs,
      migration: true,
      surfacePaths: new Map(),
      surfaceKeyOf: () => undefined,
    }),
    { chrome: { count: 0, elevated: [] }, visible: { count: 0, elevated: [] }, dom: 0 },
  );
});

// The report CLI nests the report's read scope inside its evidence-binding scope.
test('report evidence scope parses each capture once for unchanged, CSS-only and element-only catalogues', (t) => {
  for (const mode of ['nochange', 'css', 'element']) {
    const dirs = fixture(t);

    for (const file of dirs.maps) fs.unlinkSync(file);
    const files = [];

    const map = makeMap({
      elements: {
        [BUTTON]: { tag: 'button', rect: [20, 80, 100, 40], style: { color: 'gray' } },
      },
    });

    for (let index = 0; index < 265; index++) {
      for (const dir of [dirs.beforeDir, dirs.afterDir]) {
        const surface = `example-${index}@1280`;
        writeCapture(dir, surface, map);
        files.push(path.join(dir, `${surface}.json.gz`));
      }
    }

    if (mode === 'css') map.elements[BUTTON].style.color = 'blue';

    if (mode === 'element') map.elements[ADDED] = { tag: 'p', cls: '', rect: [20, 150, 100, 40], style: {} };
    writeCapture(dirs.afterDir, 'example-264@1280', map);
    // Fresh paths require two evidence-receipt reads and one parse per file.
    const assertReads = countMapReads(t, files, 3);

    const report = withCaptureDirs('styleproof-report', dirs, () =>
      generateStyleMapReport({ ...dirs, outDir: path.join(dirs.root, `report-${mode}`) }),
    );

    assert.equal(report.comparison.hasReviewableEvidence, mode !== 'nochange');
    assert.equal(report.comparison.blocksCertification, false);
    assert.equal(report.totalFindings, mode === 'css' ? 1 : 0);
    assert.equal(report.comparison.reviewableCounts.dom, mode === 'element' ? 1 : 0);
    assertReads();
  }
});
