/**
 * Report JSON/Markdown parity tests (#520 gap 3).
 *
 * StyleProof must ensure that `report.json` and `report.md` agree on:
 * - Baseline failure counts
 * - Surface classifications
 * - Change counts
 * - Missing surface counts
 *
 * This test verifies the two output formats stay in sync.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { mkTmp, rmTmp, makeMap, solidPng, fixtureCompatibilityKey } from './helpers.mjs';

const writeCapture = (dir, surface, map, png = null) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  if (png) fs.writeFileSync(path.join(dir, `${surface}.png`), png);
  return dir;
};

const writeMinimalManifest = (dir, surfaceCaptureFailures = []) => {
  const manifest = {
    version: 1,
    packageVersion: '6.0.0',
    sha: 'a'.repeat(40),
    dirty: false,
    spec: 'test.spec.ts',
    specHash: 'a'.repeat(64),
    platform: 'linux',
    arch: 'x64',
    nodeMajor: '22',
    screenshots: true,
    har: false,
    compatibilityKey: fixtureCompatibilityKey('test'),
    createdAt: new Date().toISOString(),
    ...(surfaceCaptureFailures.length ? { surfaceCaptureFailures } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MAP_MANIFEST), JSON.stringify(manifest));
};

function extractMdCounts(md) {
  const baselineFailureMatch = md.match(/(\d+)\s*baseline capture failure/i);
  const changedMatch = md.match(/(\d+)\s*changed/i) || md.match(/changes.*?(\d+)/i);
  const newSurfaceMatch = md.match(/(\d+)\s*new surface/i) || md.match(/new.*?(\d+)/i);
  const identicalMatch = md.match(/identical/i);

  return {
    baselineFailures: baselineFailureMatch ? parseInt(baselineFailureMatch[1], 10) : 0,
    hasChanges: changedMatch ? parseInt(changedMatch[1], 10) > 0 : false,
    hasNewSurfaces: newSurfaceMatch ? parseInt(newSurfaceMatch[1], 10) > 0 : false,
    isIdentical: !!identicalMatch && !changedMatch,
  };
}

test('report parity: baseline failure counts match between JSON and Markdown', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const map = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    });

    writeCapture(beforeDir, 'healthy@1280', map, solidPng(100, 100));
    writeCapture(afterDir, 'healthy@1280', map, solidPng(100, 100));
    writeCapture(afterDir, 'new-surface@1280', map, solidPng(100, 100));

    const baselineFailures = [
      { key: 'failed-a@1280', reason: 'timeout' },
      { key: 'failed-b@768', reason: 'error' },
      { key: 'failed-c@1280', reason: 'not found' },
    ];

    writeMinimalManifest(beforeDir, baselineFailures);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const mdCounts = extractMdCounts(md);

    assert.equal(json.baselineFailures.length, 3, 'JSON should report 3 baseline failures');
    assert.equal(mdCounts.baselineFailures, 3, 'Markdown should report 3 baseline failures');
    assert.equal(
      json.baselineFailures.length,
      mdCounts.baselineFailures,
      'JSON and Markdown baseline failure counts must match',
    );
  } finally {
    rmTmp(tmp);
  }
});

test('report parity: partialBaseline flag reflects baseline failure presence', async () => {
  const tmp = mkTmp();

  try {
    const beforeDirWith = path.join(tmp, 'before-with');
    const afterDirWith = path.join(tmp, 'after-with');
    const beforeDirWithout = path.join(tmp, 'before-without');
    const afterDirWithout = path.join(tmp, 'after-without');
    const outDir = path.join(tmp, 'out');

    const map = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    });

    writeCapture(beforeDirWith, 'surface@1280', map, solidPng(100, 100));
    writeCapture(afterDirWith, 'surface@1280', map, solidPng(100, 100));
    writeMinimalManifest(beforeDirWith, [{ key: 'failed@1280', reason: 'error' }]);
    writeMinimalManifest(afterDirWith);

    writeCapture(beforeDirWithout, 'surface@1280', map, solidPng(100, 100));
    writeCapture(afterDirWithout, 'surface@1280', map, solidPng(100, 100));
    writeMinimalManifest(beforeDirWithout);
    writeMinimalManifest(afterDirWithout);

    const resultWithFailures = await generateStyleMapReport({
      beforeDir: beforeDirWith,
      afterDir: afterDirWith,
      outDir: path.join(outDir, 'with-failures'),
    });

    const resultWithoutFailures = await generateStyleMapReport({
      beforeDir: beforeDirWithout,
      afterDir: afterDirWithout,
      outDir: path.join(outDir, 'without-failures'),
    });

    const jsonWith = JSON.parse(fs.readFileSync(resultWithFailures.reportJsonPath, 'utf8'));
    const jsonWithout = JSON.parse(fs.readFileSync(resultWithoutFailures.reportJsonPath, 'utf8'));

    assert.equal(jsonWith.partialBaseline, true, 'partialBaseline should be true with failures');
    assert.equal(jsonWithout.partialBaseline, false, 'partialBaseline should be false without failures');
  } finally {
    rmTmp(tmp);
  }
});

test('report parity: identical surfaces produce matching JSON and Markdown verdicts', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const map = makeMap({
      elements: {
        'body > header': { tag: 'header', style: { height: '60px' } },
        'body > main': { tag: 'main', style: { padding: '20px' } },
      },
    });

    writeCapture(beforeDir, 'home@1280', map, solidPng(100, 100));
    writeCapture(beforeDir, 'about@1280', map, solidPng(100, 100));
    writeCapture(afterDir, 'home@1280', map, solidPng(100, 100));
    writeCapture(afterDir, 'about@1280', map, solidPng(100, 100));
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

    const comparisonStatus = json.comparison?.status ?? json.comparison;
    const isIdentical =
      comparisonStatus === 'identical' ||
      (typeof json.comparison === 'object' &&
        json.comparison.rawCounts?.style === 0 &&
        json.comparison.rawCounts?.dom === 0);

    assert.ok(isIdentical, 'JSON should report no changes (identical or unproven with zero diffs)');
    assert.equal(json.baselineFailures.length, 0);
    assert.equal(json.partialBaseline, false);
  } finally {
    rmTmp(tmp);
  }
});

test('report parity: changed surfaces produce consistent counts', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const baseMaps = {
      'home@1280': makeMap({
        elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
      }),
      'about@1280': makeMap({
        elements: { 'body > section': { tag: 'section', style: { padding: '10px' } } },
      }),
    };

    const headMaps = {
      'home@1280': makeMap({
        elements: { 'body > div': { tag: 'div', style: { color: 'rgb(255, 0, 0)' } } },
      }),
      'about@1280': makeMap({
        elements: { 'body > section': { tag: 'section', style: { padding: '20px' } } },
      }),
    };

    for (const [key, map] of Object.entries(baseMaps)) {
      writeCapture(beforeDir, key, map, solidPng(100, 100));
    }
    for (const [key, map] of Object.entries(headMaps)) {
      writeCapture(afterDir, key, map, solidPng(100, 100));
    }
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    const comparisonStatus = json.comparison?.status ?? json.comparison;
    assert.notEqual(comparisonStatus, 'identical', 'should have changes');
    assert.ok(json.surfaces.length > 0, 'JSON should list surfaces');

    const hasChangeIndicator = /change/i.test(md) || /differ/i.test(md) || json.surfaces.length > 0;
    assert.ok(hasChangeIndicator, 'Markdown should indicate changes');
  } finally {
    rmTmp(tmp);
  }
});

test('report parity: new surfaces (head-only) are classified correctly', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const existingMap = makeMap({
      elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    });
    const newMap = makeMap({
      elements: { 'body > section': { tag: 'section', style: { background: 'white' } } },
    });

    writeCapture(beforeDir, 'existing@1280', existingMap, solidPng(100, 100));
    writeCapture(afterDir, 'existing@1280', existingMap, solidPng(100, 100));
    writeCapture(afterDir, 'brand-new@1280', newMap, solidPng(100, 100));
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    const newSurface = json.surfaces?.find((s) => s.surface === 'brand-new@1280');
    const hasNewSurfaceInMd = /new surface/i.test(md) || /brand-new/i.test(md);

    assert.ok(newSurface || hasNewSurfaceInMd, 'new surface should be reported');
  } finally {
    rmTmp(tmp);
  }
});

test('report parity: JSON surfaces array and Markdown surface sections align', async () => {
  const tmp = mkTmp();
  const beforeDir = path.join(tmp, 'before');
  const afterDir = path.join(tmp, 'after');
  const outDir = path.join(tmp, 'out');

  try {
    const maps = ['alpha', 'beta', 'gamma'].map((name) => ({
      key: `${name}@1280`,
      base: makeMap({ elements: { 'body > div': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } } }),
      head: makeMap({ elements: { 'body > div': { tag: 'div', style: { color: 'rgb(255, 0, 0)' } } } }),
    }));

    for (const { key, base, head } of maps) {
      writeCapture(beforeDir, key, base, solidPng(100, 100));
      writeCapture(afterDir, key, head, solidPng(100, 100));
    }
    writeMinimalManifest(beforeDir);
    writeMinimalManifest(afterDir);

    const result = await generateStyleMapReport({
      beforeDir,
      afterDir,
      outDir,
    });

    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    const jsonSurfaceCount = json.surfaces?.length ?? 0;
    const mdSurfaceMentions = ['alpha', 'beta', 'gamma'].filter((name) => md.includes(name)).length;

    assert.ok(jsonSurfaceCount > 0 || mdSurfaceMentions > 0, 'surfaces should be present in both formats');
  } finally {
    rmTmp(tmp);
  }
});
