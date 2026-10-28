import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_JSON_BYTES,
  DEFAULT_MAX_REPORT_BYTES,
} from '../dist/report/sections.js';
import { tmpDirs, makeMap, writeCapture, solidPng, rmTmp, spawnSyncBounded } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

const artifactFiles = ['report.html', 'report.md', 'report.json'];

const unlimited = {
  maxJsonBytes: Infinity,
  maxArtifactBytes: Infinity,
  maxReportBytes: Infinity,
  htmlMaxBytes: Number.MAX_SAFE_INTEGER,
};

function noisePng(width, height, seed) {
  const png = new PNG({ width, height });
  let state = seed;

  for (let i = 0; i < png.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      png.data[i + channel] = state >>> 24;
    }

    png.data[i + 3] = 255;
  }

  return PNG.sync.write(png);
}

function surfaceMap(surface, shift, rect = [10, 20, 200, 40], properties = 4) {
  const style = Object.fromEntries(
    Array.from({ length: properties }, (_, i) => [`property-${i}`, `${surface + shift + i}px`]),
  );

  return makeMap({
    elements: {
      'body > div:nth-child(1)': { tag: 'div', cls: 'card', rect, style },
      'body > div:nth-child(2)': { tag: 'div', cls: 'panel', rect, style },
    },
  });
}

function report(dirs, name, options = {}) {
  const outDir = path.join(dirs.root, name);
  const result = generateStyleMapReport({ ...dirs, outDir, ...options });
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(result.reportMdPath, 'utf8');

  return { outDir, result, json, md };
}

function artifactBytes(outDir) {
  return artifactFiles.reduce((sum, file) => sum + fs.statSync(path.join(outDir, file)).size, 0);
}

function equalArtifacts(first, second) {
  for (const file of artifactFiles) {
    assert.deepEqual(fs.readFileSync(path.join(first, file)), fs.readFileSync(path.join(second, file)), file);
  }
}

test('large report artifact budget preserves counts, one-sided entries and deterministic output', async (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const beforePng = noisePng(64, 64, 1);
  const afterPng = noisePng(64, 64, 2);

  for (let surface = 0; surface < 8; surface++) {
    writeCapture(dirs.beforeDir, `surface-${surface}@1280`, surfaceMap(surface, 0), beforePng);
    writeCapture(dirs.afterDir, `surface-${surface}@1280`, surfaceMap(surface, 30), afterPng);
  }

  for (let surface = 0; surface < 2; surface++) {
    writeCapture(dirs.afterDir, `new-${surface}@1280`, surfaceMap(surface, 0), afterPng);
  }

  const caps = { maxArtifactBytes: 90_000, maxJsonBytes: 18_000, maxReportBytes: 8_000 };
  const full = report(dirs, 'full', unlimited);
  assert.ok(artifactBytes(full.outDir) > caps.maxArtifactBytes, 'fixture exceeds the combined artifact budget');
  assert.ok(fs.statSync(full.result.reportJsonPath).size > caps.maxJsonBytes, 'fixture exceeds the JSON budget');
  assert.ok(Buffer.byteLength(full.md) > caps.maxReportBytes, 'fixture exceeds the retained markdown cap');
  const capped = report(dirs, 'capped', caps);

  await t.test('html, markdown and JSON together fit the test budget', () => {
    assert.ok(artifactBytes(capped.outDir) <= caps.maxArtifactBytes, `${artifactBytes(capped.outDir)} artifact bytes`);
    assert.ok(fs.statSync(capped.result.reportJsonPath).size <= caps.maxJsonBytes);
    assert.ok(Buffer.byteLength(capped.md) <= caps.maxReportBytes);
    const budget = capped.json.findingsBudget;
    assert.equal(budget.maxBytes, caps.maxJsonBytes);
    assert.equal(budget.listed + budget.omitted, budget.total);
    assert.equal(budget.total, capped.result.totalFindings);
    assert.ok(budget.omitted > 0);
    assert.match(capped.md, /omitted from report.json at its byte budget/);
    assert.match(capped.md, /original diff input/);
    assert.doesNotMatch(capped.md, /styleproof-diff.json/);

    for (const key of ['counts', 'comparison', 'reportConsistency']) {
      assert.deepEqual(capped.json[key], full.json[key], key);
    }

    const oneSided = (json) => json.surfaces.filter((surface) => surface.missing);
    assert.equal(oneSided(full.json).length, 2);
    assert.deepEqual(oneSided(capped.json), oneSided(full.json));
    const groups = capped.json.surfaces.filter((surface) => Array.isArray(surface.findings));
    assert.equal(
      groups.reduce((sum, group) => sum + group.findings.length, 0),
      budget.listed,
    );
    assert.equal(
      groups.reduce((sum, group) => sum + (group.findingsOmitted ?? 0), 0),
      budget.omitted,
    );
    let omitted = false;

    for (const group of groups) {
      omitted ||= group.findingsOmitted > 0;
      const original = full.json.surfaces.find((surface) => surface.representative === group.representative);
      assert.deepEqual(group.findings, omitted ? [] : original.findings);

      if (omitted) assert.equal(group.findingsOmitted, original.findings.length);
    }
  });

  await t.test('two output directories contain byte-identical artifacts', () => {
    const repeated = report(dirs, 'repeated', caps);
    equalArtifacts(capped.outDir, repeated.outDir);
  });

  await t.test('CLI honors --report-max-bytes after adding bindings and diagnostic text', () => {
    const cliDirs = tmpDirs();
    t.after(() => rmTmp(cliDirs.root));

    for (let surface = 0; surface < 4; surface++) {
      writeCapture(cliDirs.beforeDir, `surface-${surface}@1280`, surfaceMap(surface, 0), beforePng);
      writeCapture(cliDirs.afterDir, `surface-${surface}@1280`, surfaceMap(surface, 30), afterPng);
    }

    stampCertifyingFixture(cliDirs.beforeDir, 'a'.repeat(40));
    stampCertifyingFixture(cliDirs.afterDir, 'b'.repeat(40));
    const outDir = path.join(cliDirs.root, 'cli');
    const cli = fileURLToPath(new URL('../bin/styleproof-report.mjs', import.meta.url));

    const child = spawnSyncBounded(
      process.execPath,
      [cli, cliDirs.beforeDir, cliDirs.afterDir, '--out', outDir, '--report-max-bytes', '90000'],
      { cwd: dirs.root, encoding: 'utf8' },
    );

    assert.equal(child.status, 1, child.stderr + child.stdout);
    assert.ok(artifactBytes(outDir) <= 90_000, `${artifactBytes(outDir)} artifact bytes`);
    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.ok(json.sourceBinding);
    assert.ok(json.evidenceBinding);
    assert.match(fs.readFileSync(path.join(outDir, 'report.html'), 'utf8'), /UNVERIFIED/);
  });
});

test('small report artifacts are unchanged by default budgets', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));

  for (let surface = 0; surface < 3; surface++) {
    writeCapture(dirs.beforeDir, `small-${surface}@1280`, surfaceMap(surface, 0), solidPng(400, 480));
    writeCapture(dirs.afterDir, `small-${surface}@1280`, surfaceMap(surface, 30), solidPng(400, 480));
  }

  const capped = report(dirs, 'capped');
  const full = report(dirs, 'full', unlimited);
  equalArtifacts(capped.outDir, full.outDir);
  assert.equal(Object.hasOwn(capped.json, 'findingsBudget'), false);
  assert.equal(DEFAULT_MAX_ARTIFACT_BYTES, 2_000_000);
  assert.equal(DEFAULT_MAX_JSON_BYTES, 450_000);
  assert.equal(DEFAULT_MAX_REPORT_BYTES, 400_000);
});

test('large noise crops are downscaled to at most 300 KB per file', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  const rect = [0, 0, 320, 320];
  assert.ok(noisePng(320, 320, 1).length > 300_000, 'undownscaled crop exceeds the per-file cap');
  writeCapture(dirs.beforeDir, 'large@1280', surfaceMap(0, 0, rect), noisePng(320, 320, 1));
  writeCapture(dirs.afterDir, 'large@1280', surfaceMap(0, 30, rect), noisePng(320, 320, 2));
  const capped = report(dirs, 'capped');
  const cropsDir = path.join(capped.outDir, 'crops');
  const files = fs.readdirSync(cropsDir);
  const composites = files.filter((file) => file.endsWith('-composite.png'));
  assert.ok(composites.length > 0, 'downscaling must retain a composite');

  for (const file of files) {
    assert.ok(fs.statSync(path.join(cropsDir, file)).size <= 300_000, `${file} exceeds 300 KB`);
  }

  const composite = PNG.sync.read(fs.readFileSync(path.join(cropsDir, composites[0])));
  assert.ok(composite.width < 2 * 1280, 'composite must have been downscaled');
  assert.match(capped.md, /crop\(s\) downscaled.*smaller than 1:1/);

  if (capped.json.cropBudget) assert.ok(capped.json.cropBudget.omitted > 0);
});

test('outline over the JSON cap still omits all findings', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  writeCapture(dirs.beforeDir, 'changed@1280', surfaceMap(0, 0), solidPng(400, 480));
  writeCapture(dirs.afterDir, 'changed@1280', surfaceMap(0, 30), solidPng(400, 480));
  writeCapture(dirs.afterDir, 'new@1280', surfaceMap(1, 0), solidPng(400, 480));
  const capped = report(dirs, 'outline', { maxJsonBytes: 1 });
  assert.equal(capped.json.findingsBudget.listed, 0);
  assert.equal(capped.json.findingsBudget.omitted, capped.result.totalFindings);
  assert.ok(capped.json.surfaces.some((surface) => surface.missing));
  assert.ok(capped.json.surfaces.every((surface) => !surface.findings?.length));
});

test('receipts leaving tiny, zero or negative HTML budgets preserve report text', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  writeCapture(dirs.beforeDir, 'changed@1280', surfaceMap(0, 0), solidPng(400, 480));
  writeCapture(dirs.afterDir, 'changed@1280', surfaceMap(0, 30), solidPng(400, 480));
  const full = report(dirs, 'full');
  const receipts = fs.statSync(full.result.reportMdPath).size + fs.statSync(full.result.reportJsonPath).size;

  for (const remaining of [100, 0, -100]) {
    const capped = report(dirs, `remaining-${remaining}`, { maxArtifactBytes: receipts + remaining });
    assert.equal(capped.md, full.md);
    assert.deepEqual(capped.json, full.json);
    assert.match(fs.readFileSync(capped.result.reportHtmlPath, 'utf8'), /StyleProof report/);
  }
});

test('CLI reports an unusable HTML cap as exit 2 without a stack trace', (t) => {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  writeCapture(dirs.beforeDir, 'changed@1280', surfaceMap(0, 0), solidPng(400, 480));
  writeCapture(dirs.afterDir, 'changed@1280', surfaceMap(0, 30), solidPng(400, 480));
  stampCertifyingFixture(dirs.beforeDir, 'a'.repeat(40));

  stampCertifyingFixture(dirs.afterDir, 'b'.repeat(40));
  const cli = fileURLToPath(new URL('../bin/styleproof-report.mjs', import.meta.url));

  const child = spawnSyncBounded(
    process.execPath,
    [cli, dirs.beforeDir, dirs.afterDir, '--out', path.join(dirs.root, 'cli'), '--html-max-bytes', '1'],

    { encoding: 'utf8' },
  );

  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /increase the budget/);
  assert.doesNotMatch(child.stderr, /at renderReportHtml/);
});
