import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
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
  assert.equal(changes[0].kind, 'text');
  assert.equal(changes[0].path, 'body > p:nth-child(1)');
  assert.equal(changes[0].before, 'Original demo copy');
  assert.equal(changes[0].after, 'Updated demo copy');
});

test('diffContentMaps is a no-op when neither side captured text (feature off)', () => {
  const a = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'red' } } } });
  const b = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'blue' } } } });
  assert.equal(diffContentMaps(a, b).length, 0);
});

test('diffContentMaps reports add/remove as advisory structure', () => {
  const a = makeMap({ elements: {} });
  const b = makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', text: 'new paragraph' } } });
  assert.deepEqual(diffContentMaps(a, b), [
    {
      kind: 'structure',
      path: 'body > p:nth-child(1)',
      cls: '',
      change: 'added',
    },
  ]);
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
  // The rendered text differs, so the screenshots must differ too — an identical
  // pair would (correctly) suppress the composite as pixel-identical.
  writeCapture(dirs.beforeDir, 'landing@1280', before, solidPng(400, 200));
  writeCapture(dirs.afterDir, 'landing@1280', after, solidPng(400, 200, [180, 180, 180]));

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
  assert.ok(md.includes('## 📝 Content and structure changes (advisory)'));
  assert.ok(md.includes('Original demo copy'));
  assert.ok(md.includes('Updated demo copy'));
  const compositePath = path.join(dirs.root, 'on', 'crops', 'landing-1280-content-1-composite.png');
  assert.ok(fs.existsSync(compositePath));
  const composite = PNG.sync.read(fs.readFileSync(compositePath));
  const label = [139, 148, 158];
  const labelPixels = [0, 0];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < composite.width; x++) {
      const offset = (y * composite.width + x) * 4;
      if (
        composite.data[offset] === label[0] &&
        composite.data[offset + 1] === label[1] &&
        composite.data[offset + 2] === label[2]
      ) {
        labelPixels[x < composite.width / 2 ? 0 : 1]++;
      }
    }
  }
  assert.equal(labelPixels[0], 416, 'content composite embeds the exact BEFORE glyphs');
  assert.equal(labelPixels[1], 316, 'content composite embeds the exact AFTER glyphs');

  // …and it NEVER gates: styles are identical, so the surface count and exit basis stay 0.
  assert.equal(on.changedSurfaces, 0);
  assert.equal(on.newSurfaces, 0);

  rmTmp(dirs.root);
});

// A removal above repeated same-shaped siblings must not orphan every shifted
// row: count-preserving signature groups pair k-th to k-th in document order.
// Reproduces a consumer report where removing 2 helper texts inside a dialog
// produced 420 phantom removed+added entries for the shifted rows' subtrees.
test('sibling removal above repeated same-signature rows reports only the real removals', () => {
  const row = (parentIndex) => ({
    [`body > div:nth-child(1) > div:nth-child(${parentIndex})`]: {
      tag: 'div',
      cls: 'row',
      rect: [0, parentIndex * 30, 300, 24],
    },
    [`body > div:nth-child(1) > div:nth-child(${parentIndex}) > span:nth-child(1)`]: {
      tag: 'span',
      cls: 'label',
      rect: [4, parentIndex * 30, 80, 16],
      text: 'Label',
    },
  });
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': { tag: 'div', cls: 'panel', rect: [0, 0, 320, 200] },
      'body > div:nth-child(1) > div:sp-key(note1)': {
        tag: 'div',
        cls: 'field-note',
        rect: [0, 0, 300, 20],
        text: 'Memory note',
      },
      'body > div:nth-child(1) > div:sp-key(hint1)': {
        tag: 'div',
        cls: 'hint',
        rect: [0, 20, 300, 20],
        text: 'Model hint',
      },
      ...row(3),
      ...row(4),
      ...row(5),
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': { tag: 'div', cls: 'panel', rect: [0, 0, 320, 200] },
      ...row(1),
      ...row(2),
      ...row(3),
    },
  });

  const changes = diffContentMaps(before, after);
  assert.deepEqual(
    changes.map((change) => [change.change, change.cls]),
    [
      ['removed', 'hint'],
      ['removed', 'field-note'],
    ],
  );

  // The shifted rows are style-identical, so the certification stays clean too.
  assert.deepEqual(diffStyleMaps(before, after, { includeStructure: false }), []);
});

// A structural change with no rendered effect (an element inside a collapsed
// <details>) must not present two identical crops as before/after proof.
test('content report names a pixel-identical location instead of an identical before/after crop', () => {
  const dirs = tmpDirs();
  const png = solidPng(400, 200);
  const before = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > div:nth-child(1)': { tag: 'div', cls: 'collapsed-child', rect: [10, 10, 200, 40] },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body' },
    },
  });
  writeCapture(dirs.beforeDir, 'landing@1280', before, png);
  writeCapture(dirs.afterDir, 'landing@1280', after, png);

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'out'),
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.contentChanges, 1);
  assert.ok(md.includes('element removed'));
  assert.ok(md.includes('renders identically before and after'));
  assert.ok(!md.includes('landing-1280-content-1-composite.png'));
  assert.ok(!fs.existsSync(path.join(dirs.root, 'out', 'crops', 'landing-1280-content-1-composite.png')));

  rmTmp(dirs.root);
});
