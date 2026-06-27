import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffContentMaps, diffContentDirs, diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

// ------------------------------------------------------------- diffContentMaps

test('diffContentMaps reports an element whose own text changed', () => {
  const a = makeMap({
    elements: { 'body > p:nth-child(1)': { tag: 'p', cls: 'lead', text: 'Original demo copy' } },
  });
  const b = makeMap({
    elements: { 'body > p:nth-child(1)': { tag: 'p', cls: 'lead', text: 'Updated demo copy' } },
  });
  const changes = diffContentMaps(a, b);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'body > p:nth-child(1)');
  assert.equal(changes[0].before, 'Original demo copy');
  assert.equal(changes[0].after, 'Updated demo copy');
});

test('diffContentMaps is a no-op when neither side captured text (feature off)', () => {
  const a = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'red' } } } });
  const b = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'blue' } } } });
  assert.equal(diffContentMaps(a, b).length, 0);
});

test('diffContentMaps ignores add/remove (owned by the style DOM diff)', () => {
  const a = makeMap({ elements: {} });
  const b = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'new paragraph' } } });
  assert.equal(diffContentMaps(a, b).length, 0);
});

test('diffContentMaps skips text churn in a volatile (live) region', () => {
  const a = makeMap({ elements: { 'body > span:nth-child(1)': { tag: 'span', text: '2m ago' } } });
  const b = {
    ...makeMap({ elements: { 'body > span:nth-child(1)': { tag: 'span', text: '3m ago' } } }),
    volatile: ['body > span:nth-child(1)'],
  };
  assert.equal(diffContentMaps(a, b).length, 0);
});

// ------------------------------------------------------- separation from the gate

test('a text-only change produces NO computed-style findings (content stays off the gate)', () => {
  const a = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'before', style: { color: 'red' } } } });
  const b = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'after', style: { color: 'red' } } } });
  // The style certification is blind to text by design — only the content layer sees it.
  assert.equal(diffStyleMaps(a, b).length, 0);
  assert.equal(diffContentMaps(a, b).length, 1);
});

// -------------------------------------------------------------- diffContentDirs

test('diffContentDirs counts content changes across same-named surfaces', () => {
  const dirs = pairFixture({
    surface: 'landing@1280',
    before: makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'one' } } }),
    after: makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'two' } } }),
  });
  const res = diffContentDirs(dirs.beforeDir, dirs.afterDir);
  assert.equal(res.count, 1);
  assert.equal(res.surfaces[0].surface, 'landing@1280');
  rmTmp(dirs.root);
});

// ----------------------------------------------- report: opt-in, advisory, non-gating

test('generateStyleMapReport renders the content section only when includeContent is set', () => {
  const dirs = tmpDirs();
  const png = solidPng(400, 200);
  const before = makeMap({
    elements: {
      'body > p:nth-child(1)': { tag: 'p', cls: 'lead', rect: [0, 0, 300, 40], text: 'Original demo copy' },
    },
  });
  const after = makeMap({
    elements: {
      'body > p:nth-child(1)': { tag: 'p', cls: 'lead', rect: [0, 0, 300, 40], text: 'Updated demo copy' },
    },
  });
  writeCapture(dirs.beforeDir, 'landing@1280', before, png);
  writeCapture(dirs.afterDir, 'landing@1280', after, png);

  // Default (off): no content section, content-only pair reads as identical.
  const off = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'off'),
  });
  assert.equal(off.contentChanges, 0);
  assert.ok(!fs.readFileSync(off.reportMdPath, 'utf8').includes('Content changes'));

  // Opt-in: advisory section appears, with before/after text and a composite crop…
  const on = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'on'),
    includeContent: true,
  });
  const md = fs.readFileSync(on.reportMdPath, 'utf8');
  assert.equal(on.contentChanges, 1);
  assert.ok(md.includes('## 📝 Content changes (advisory)'));
  assert.ok(md.includes('Original demo copy'));
  assert.ok(md.includes('Updated demo copy'));
  assert.ok(fs.existsSync(path.join(dirs.root, 'on', 'crops', 'landing-1280-content-1-composite.png')));

  // …and it NEVER gates: styles are identical, so the surface count and exit basis stay 0.
  assert.equal(on.changedSurfaces, 0);
  assert.equal(on.newSurfaces, 0);

  rmTmp(dirs.root);
});
