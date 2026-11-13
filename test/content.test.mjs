import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { diffContentMaps, diffContentDirs, diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

/** For each content crop pair: [base-page Where map written, head-page Where map written]. */
function whereSides(cropDir) {
  return fs
    .readdirSync(cropDir)
    .filter((name) => name.endsWith('-after.png'))
    .map((name) => name.slice(0, -'-after.png'.length))
    .map((stem) => [
      fs.existsSync(path.join(cropDir, `${stem}-before-where.png`)),
      fs.existsSync(path.join(cropDir, `${stem}-where.png`)),
    ]);
}

/** x positions (map pixels) of the Where map's ring. */
function ringXs(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const xs = [];
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 224 && png.data[i + 1] === 17 && png.data[i + 2] === 157) xs.push((i / 4) % png.width);
  }
  return { width: png.width, xs };
}

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

  // Opt-in: advisory section appears, with before/after text and a clean crop pair…
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
  for (const side of ['before', 'after']) {
    assert.ok(fs.existsSync(path.join(dirs.root, 'on', 'crops', `landing-1280-content-1-${side}.png`)));
  }
  assert.match(md, /\| Before \| After \|/, 'content direction lives in the markdown table header');

  // …and it NEVER gates: styles are identical, so the surface count and exit basis stay 0.
  assert.equal(on.changedSurfaces, 0);
  assert.equal(on.newSurfaces, 0);

  rmTmp(dirs.root);
});

// A tiny label at the edge of a wide control needs the shared control context,
// an outline, and a magnified view at every consumer width. The old leaf-centred
// 320px crop clips the adjacent control and writes only the composite.
test('content crops keep a shared control visible and magnify its changed label across widths', () => {
  const dirs = tmpDirs();
  const fill = (png, x, y, w, h, color) => {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const offset = (py * png.width + px) * 4;
        png.data[offset] = color[0];
        png.data[offset + 1] = color[1];
        png.data[offset + 2] = color[2];
        png.data[offset + 3] = 255;
      }
    }
  };
  const screenshot = (width, labelColor) => {
    const png = PNG.sync.read(solidPng(width, 240, [245, 247, 250]));
    fill(png, 20, 40, 400, 80, [30, 41, 59]);
    fill(png, 40, 60, 96, 40, [16, 185, 129]);
    fill(png, 360, 70, 40, 16, labelColor);
    return PNG.sync.write(png);
  };
  const map = (width, text) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, width, 240] },
        'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [0, 0, width, 240] },
        'body > main:nth-child(1) > div:nth-child(1)': {
          tag: 'div',
          cls: 'control',
          rect: [20, 40, 400, 80],
        },
        'body > main:nth-child(1) > div:nth-child(1) > span:nth-child(2)': {
          tag: 'span',
          cls: 'label',
          rect: [360, 70, 40, 16],
          text,
        },
      },
    });

  for (const width of [480, 900, 1440]) {
    const surface = `workflow@${width}`;
    writeCapture(dirs.beforeDir, surface, map(width, 'Old'), screenshot(width, [239, 68, 68]));
    writeCapture(dirs.afterDir, surface, map(width, 'New'), screenshot(width, [59, 130, 246]));
  }

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'out'),
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.contentChanges, 3);
  assert.doesNotMatch(md, /magnified|zoom/, 'no magnified copy: the Where map locates small changes');

  for (const width of [480, 900, 1440]) {
    const prefix = `workflow-${width}-content-`;
    const crops = fs.readdirSync(path.join(dirs.root, 'out', 'crops')).filter((name) => name.startsWith(prefix));
    for (const side of ['before', 'after']) {
      const name = crops.find((candidate) => candidate.endsWith(`-${side}.png`) && !candidate.includes('where'));
      assert.ok(name, `${width}px writes clean ${side} evidence`);
      const crop = PNG.sync.read(fs.readFileSync(path.join(dirs.root, 'out', 'crops', name)));
      assert.equal(crop.width, 424, `${width}px retains the full 400px control plus padding`);
      let adjacentControlPixels = 0;
      for (let i = 0; i < crop.data.length; i += 4) {
        if (crop.data[i] === 16 && crop.data[i + 1] === 185 && crop.data[i + 2] === 129) adjacentControlPixels++;
      }
      assert.ok(adjacentControlPixels >= 96 * 40, `${width}px retains the adjacent control ${side}`);
    }
    // The label exists on both sides, so the head-page Where map locates it.
    assert.ok(
      crops.some((name) => name.endsWith('-where.png') && !name.endsWith('-before-where.png')),
      `${width}px locates the changed content on the Where map`,
    );
  }

  const customOut = path.join(dirs.root, 'custom-options');
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: customOut,
    includeContent: true,
    pad: 20,
    minWidth: 100,
    minHeight: 60,
    maxHeight: 120,
    zoomBelow: 0,
  });
  const customCrops = fs.readdirSync(path.join(customOut, 'crops'));
  for (const width of [480, 900, 1440]) {
    const name = customCrops.find(
      (candidate) => candidate.startsWith(`workflow-${width}-content-`) && candidate.endsWith('-after.png'),
    );
    assert.ok(name, `${width}px writes evidence with custom crop options`);
    const crop = PNG.sync.read(fs.readFileSync(path.join(customOut, 'crops', name)));
    assert.equal(crop.width, 440, `${width}px applies the configured 20px context padding`);
    assert.equal(crop.height, 120, `${width}px obeys the configured 120px maximum panel height`);
  }
  assert.ok(!customCrops.some((name) => name.endsWith('-zoom.png')), 'no magnified copy is written');

  rmTmp(dirs.root);
});

test('content structure crops highlight additions and removals only where each element exists', () => {
  const dirs = tmpDirs();
  const basePng = PNG.sync.read(solidPng(500, 240, [245, 247, 250]));
  const headPng = PNG.sync.read(solidPng(500, 240, [245, 247, 250]));
  const paint = (png, x, color) => {
    for (let y = 65; y < 85; y++) {
      for (let px = x; px < x + 70; px++) {
        const offset = (y * png.width + px) * 4;
        png.data[offset] = color[0];
        png.data[offset + 1] = color[1];
        png.data[offset + 2] = color[2];
      }
    }
  };
  paint(basePng, 40, [239, 68, 68]);
  paint(headPng, 330, [59, 130, 246]);
  const common = {
    body: { tag: 'body', rect: [0, 0, 500, 240] },
    'body > main:nth-child(1)': { tag: 'main', rect: [0, 0, 500, 240] },
    'body > main:nth-child(1) > div:nth-child(1)': { tag: 'div', cls: 'control', rect: [20, 40, 400, 80] },
  };
  const before = makeMap({
    elements: {
      ...common,
      'body > main:nth-child(1) > div:nth-child(1) > button:sp-key(removed)': {
        tag: 'button',
        cls: 'removed',
        rect: [40, 65, 70, 20],
        text: 'Remove',
      },
    },
  });
  const after = makeMap({
    elements: {
      ...common,
      'body > main:nth-child(1) > div:nth-child(1) > span:sp-key(added)': {
        tag: 'span',
        cls: 'added',
        rect: [330, 65, 70, 20],
        text: 'Add',
      },
    },
  });
  writeCapture(dirs.beforeDir, 'structure@500', before, PNG.sync.write(basePng));
  writeCapture(dirs.afterDir, 'structure@500', after, PNG.sync.write(headPng));
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
  });

  const annotations = whereSides(path.join(dirs.outDir, 'crops')).map(([before, after]) => [
    Number(before),
    Number(after),
  ]);
  assert.equal(annotations.length, 2);
  assert.ok(
    annotations.some(([before, after]) => before > 0 && after === 0),
    'removal is located only on the base page',
  );
  assert.ok(
    annotations.some(([before, after]) => before === 0 && after > 0),
    'addition is located only on the head page',
  );
  rmTmp(dirs.root);
});

test('one-sided crops ignore unrelated elements occupying added paths and ancestor paths', () => {
  const dirs = pairFixture({
    surface: 'path-collision@500',
    before: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': { tag: 'div', cls: 'collision', ownTextLength: 0, rect: [20, 40, 400, 80] },
      },
    }),
    after: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': { tag: 'div', cls: 'collision', ownTextLength: 0, rect: [330, 65, 70, 20] },
        'body > div:nth-child(1) > button:nth-child(1)': {
          tag: 'button',
          cls: 'scope-option',
          rect: [350, 67, 30, 16],
        },
        'body > div:nth-child(2)': { tag: 'div', cls: 'collision', ownTextLength: 0, rect: [20, 40, 400, 80] },
      },
    }),
    beforePng: solidPng(500, 240, [239, 68, 68]),
    afterPng: solidPng(500, 240, [59, 130, 246]),
  });
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    zoomBelow: 0,
  });

  const cropDir = path.join(dirs.outDir, 'crops');
  const afters = fs.readdirSync(cropDir).filter((name) => name.endsWith('-after.png'));
  assert.equal(whereSides(cropDir).length, 1, 'the shifted same-metadata sibling is not reported as a second addition');
  assert.deepEqual(
    afters.map((name) => PNG.sync.read(fs.readFileSync(path.join(cropDir, name))).width),
    [320],
  );
  assert.deepEqual(whereSides(cropDir), [[false, true]], 'the addition is located only on the head page');
  rmTmp(dirs.root);
});

test('shifted text changes locate the corresponding element instead of the reused raw path', () => {
  const dirs = pairFixture({
    surface: 'shifted-text@500',
    before: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'label',
          ownTextLength: 3,
          text: 'Old',
          rect: [40, 65, 70, 20],
        },
      },
    }),
    after: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'inserted',
          ownTextLength: 3,
          text: 'Add',
          rect: [330, 65, 70, 20],
        },
        'body > div:nth-child(2)': {
          tag: 'div',
          cls: 'label',
          ownTextLength: 3,
          text: 'New',
          rect: [40, 65, 70, 20],
        },
      },
    }),
    beforePng: solidPng(500, 240, [239, 68, 68]),
    afterPng: solidPng(500, 240, [59, 130, 246]),
  });
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    zoomBelow: 0,
  });

  const cropDir = path.join(dirs.outDir, 'crops');
  const md = fs.readFileSync(path.join(dirs.outDir, 'report.md'), 'utf8');
  const where = md.split('**`div.label`**')[1]?.match(/<img src="crops\/([^"]+-where\.png)"/)?.[1];
  assert.ok(where, 'the shifted text change has a Where map');
  // The label sits at x=40 on head; the inserted element at the reused raw path sits at x=330.
  const { width, xs } = ringXs(path.join(cropDir, where));
  assert.ok(
    xs.length > 0 && xs.every((x) => x < width / 2),
    'the ring marks the corresponding label, not the raw path',
  );
  rmTmp(dirs.root);
});

test('one-sided annotations preserve a removed element displaced by a shifted sibling', () => {
  const dirs = pairFixture({
    surface: 'removal-collision@500',
    before: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'collision',
          ownTextLength: 0,
          rect: [330, 65, 70, 20],
        },
        'body > div:nth-child(1) > button:nth-child(1)': {
          tag: 'button',
          cls: 'removed__button',
          ownTextLength: 6,
          text: 'Nested',
          rect: [350, 67, 30, 16],
        },
        'body > div:nth-child(2)': {
          tag: 'div',
          cls: 'collision',
          ownTextLength: 0,
          rect: [20, 40, 400, 80],
        },
      },
    }),
    after: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'collision',
          ownTextLength: 0,
          rect: [20, 40, 400, 80],
        },
      },
    }),
    beforePng: solidPng(500, 240, [239, 68, 68]),
    afterPng: solidPng(500, 240, [59, 130, 246]),
  });
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    zoomBelow: 0,
  });

  assert.equal(result.contentChanges, 1, 'the shifted same-metadata sibling is not reported as a second removal');
  const cropDir = path.join(dirs.outDir, 'crops');
  const afterName = fs.readdirSync(cropDir).find((name) => name.endsWith('-after.png'));
  assert.ok(afterName);
  assert.equal(PNG.sync.read(fs.readFileSync(path.join(cropDir, afterName))).width, 320);
  assert.deepEqual(whereSides(cropDir), [[true, false]], 'the removal is located only on the base page');
  rmTmp(dirs.root);
});

test('maxCrops bounds advisory content image sets without hiding textual findings', () => {
  const map = (prefix) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 500, 240] },
        'body > span:nth-child(1)': { tag: 'span', cls: 'one', rect: [20, 30, 80, 20], text: `${prefix} one` },
        'body > span:nth-child(2)': { tag: 'span', cls: 'two', rect: [20, 90, 80, 20], text: `${prefix} two` },
        'body > span:nth-child(3)': { tag: 'span', cls: 'three', rect: [20, 150, 80, 20], text: `${prefix} three` },
      },
    });
  const dirs = pairFixture({
    surface: 'crop-budget@500',
    before: map('Old'),
    after: map('New'),
    beforePng: solidPng(500, 240, [239, 68, 68]),
    afterPng: solidPng(500, 240, [59, 130, 246]),
  });
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    maxCrops: 1,
    zoomBelow: 0,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const names = fs.readdirSync(path.join(dirs.outDir, 'crops')).sort();
  assert.equal(result.contentChanges, 3);
  assert.equal(names.filter((name) => name.endsWith('-after.png')).length, 1);
  assert.equal(names.filter((name) => name.endsWith('-where.png')).length, 1);
  assert.match(md, /Old one/);
  assert.match(md, /Old two/);
  assert.match(md, /Old three/);
  // #971: the two uncropped entries are counted, with why.
  // #971 + rule 5: the two uncropped entries are counted once, in the opening, with the option.
  assert.match(
    md,
    /✂️ \*\*2 changes are missing crops\*\*, past the `--max-crops` limit of 1 per surface \(2 on `[^`]+`\)/,
  );
  assert.equal(md.split('--max-crops').length - 1, 2, 'the note is said once');
  rmTmp(dirs.root);
});

// #971: five visible additions on each of two surfaces (distinct classes, so nothing is Global chrome).
function twoSurfaceAdditions(opts = {}) {
  const dirs = tmpDirs();
  ['first@500', 'second@500'].forEach((surface, s) => {
    const body = { body: { tag: 'body', rect: [0, 0, 500, 240] } };
    const added = {};
    for (let k = 1; k <= 5; k++) {
      added[`body > section:nth-child(${k})`] = {
        tag: 'section',
        cls: `card-${s}-${k}`,
        rect: [10 + (k - 1) * 95, 60, 80, 80],
      };
    }
    writeCapture(dirs.beforeDir, surface, makeMap({ elements: body }), solidPng(500, 240));
    writeCapture(
      dirs.afterDir,
      surface,
      makeMap({ elements: { ...body, ...added } }),
      solidPng(500, 240, [59, 130, 246]),
    );
  });
  const result = generateStyleMapReport({ ...dirs, includeContent: true, zoomBelow: 0, ...opts });
  const composites = fs.readdirSync(path.join(dirs.outDir, 'crops')).filter((name) => name.endsWith('-after.png'));
  return { dirs, result, composites, md: fs.readFileSync(result.reportMdPath, 'utf8') };
}

test('#971: maxCrops caps content crops per surface, so a later surface keeps its crops', () => {
  const { dirs, result, composites, md } = twoSurfaceAdditions();
  assert.equal(result.contentChanges, 10);
  assert.equal(result.comparison.reviewableCounts.dom, 10, 'every visible addition gates the check');
  assert.equal(composites.filter((name) => name.startsWith('first-500-')).length, 5);
  assert.equal(composites.filter((name) => name.startsWith('second-500-')).length, 5, 'the second surface keeps all 5');
  assert.equal(new Set(composites).size, 10, 'crop file names stay unique across the section');
  assert.doesNotMatch(md, /Crop omitted/);
  rmTmp(dirs.root);
});

test('#971: a content change past the per-surface crop cap carries an omission note, verdict unchanged', () => {
  const full = twoSurfaceAdditions();
  const capped = twoSurfaceAdditions({ maxCrops: 3 });
  assert.equal(capped.composites.length, 6, '3 crops on each surface');
  // Rule 5: one opening line counts both uncropped additions on each surface; no entry repeats it.
  assert.match(
    capped.md,
    /✂️ \*\*4 changes are missing crops\*\*, past the `--max-crops` limit of 3 per surface \(2 on `first @ 500`, 2 on `second @ 500`\)\. Each is still listed and counted; raise `--max-crops` to show the crops\./,
  );
  assert.equal(capped.md.split('--max-crops').length - 1, 2, 'the note is said once');
  for (const surface of ['first@500', 'second@500']) {
    const section = capped.md.split(`### \`${surface}\``)[1].split('\n### ')[0];
    assert.equal(section.split('element added').length - 1, 5, `${surface} still lists all 5 additions`);
    assert.doesNotMatch(section, /max-crops/, `${surface} carries no per-entry note`);
  }
  assert.deepEqual(capped.result.comparison.reviewableCounts, full.result.comparison.reviewableCounts);
  assert.equal(capped.result.comparison.hasReviewableEvidence, true);
  rmTmp(full.dirs.root);
  rmTmp(capped.dirs.root);
});

test('a capped report does not claim content artifacts when content comparison is disabled', () => {
  const map = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 320, 180] } } });
  const dirs = pairFixture({
    surface: 'content-disabled@320',
    before: map,
    after: map,
    beforePng: solidPng(320, 180),
    afterPng: solidPng(320, 180),
  });
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    maxReportBytes: 0,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /advisory content\/structure change/);
  assert.doesNotMatch(md, /full image evidence remains in the published report artifacts/);
  rmTmp(dirs.root);
});

test('content evidence obeys the existing report budget without dropping generated artifacts', () => {
  const fixture = (outDir) => {
    const map = (text) =>
      makeMap({
        elements: {
          body: { tag: 'body', rect: [0, 0, 480, 240] },
          'body > span:nth-child(1)': { tag: 'span', cls: 'label', rect: [200, 80, 40, 20], text },
        },
      });
    const dirs = pairFixture({
      surface: 'budget@480',
      before: map('Old'),
      after: map('New'),
      beforePng: solidPng(480, 240, [240, 240, 240]),
      afterPng: solidPng(480, 240, [220, 220, 220]),
    });
    const result = generateStyleMapReport({
      beforeDir: dirs.beforeDir,
      afterDir: dirs.afterDir,
      outDir: path.join(dirs.root, outDir),
      includeContent: true,
      maxReportBytes: 900,
      zoomBelow: 0,
    });
    return {
      dirs,
      result,
      md: fs.readFileSync(result.reportMdPath, 'utf8'),
      crops: fs.readdirSync(path.join(dirs.root, outDir, 'crops')).sort(),
    };
  };

  const a = fixture('out-a');
  const b = fixture('out-b');
  assert.equal(a.result.contentChanges, 1);
  assert.ok(a.md.length < 1_200, `content detail stays bounded near the report ceiling (was ${a.md.length})`);
  assert.match(a.md, /display budget/);
  assert.match(a.md, /1 advisory content\/structure change\(s\); full image evidence remains/);
  assert.deepEqual(a.crops, [
    'budget-480-content-1-after.png',
    'budget-480-content-1-before.png',
    'budget-480-content-1-where.png',
  ]);
  assert.equal(a.md, b.md, 'the capped advisory report is byte-deterministic');
  assert.deepEqual(a.crops, b.crops, 'the capped artifact set is deterministic');
  rmTmp(a.dirs.root);
  rmTmp(b.dirs.root);
});

test('body is never selected as content context even when its captured rect fits', () => {
  const map = (text) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [20, 20, 400, 160] },
        'body > span:nth-child(1)': { tag: 'span', cls: 'label', rect: [360, 70, 20, 10], text },
      },
    });
  const dirs = pairFixture({
    surface: 'body-fallback@480',
    before: map('Old'),
    after: map('New'),
    beforePng: solidPng(480, 240, [240, 240, 240]),
    afterPng: solidPng(480, 240, [220, 220, 220]),
  });
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    minWidth: 200,
    minHeight: 80,
    maxHeight: 200,
    zoomBelow: 0,
  });
  const composite = PNG.sync.read(
    fs.readFileSync(path.join(dirs.outDir, 'crops', 'body-fallback-480-content-1-after.png')),
  );
  assert.equal(composite.width, 200, 'the body shell does not replace the 200px leaf-centred crop');
  rmTmp(dirs.root);
});

test('a full-page non-body shell is not selected as content context', () => {
  const map = (text) =>
    makeMap({
      elements: {
        body: { tag: 'body' },
        'body > main:nth-child(1)': { tag: 'main', cls: 'page', rect: [5, 5, 470, 230] },
        'body > main:nth-child(1) > span:nth-child(1)': {
          tag: 'span',
          cls: 'label',
          rect: [360, 70, 20, 10],
          text,
        },
      },
    });
  const dirs = pairFixture({
    surface: 'full-page-fallback@480',
    before: map('Old'),
    after: map('New'),
    beforePng: solidPng(480, 240, [240, 240, 240]),
    afterPng: solidPng(480, 240, [220, 220, 220]),
  });
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    pad: 0,
    minWidth: 200,
    minHeight: 80,
    maxHeight: 240,
    zoomBelow: 0,
  });
  const composite = PNG.sync.read(
    fs.readFileSync(path.join(dirs.outDir, 'crops', 'full-page-fallback-480-content-1-after.png')),
  );
  assert.equal(composite.width, 200, 'the inset 98%-wide and 96%-tall page shell does not replace the leaf crop');
  rmTmp(dirs.root);
});

test('oversized content ancestors retain the configured leaf-centred crop', () => {
  const dirs = pairFixture({
    surface: 'fallback@480',
    before: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 480, 240] },
        'body > main:nth-child(1)': { tag: 'main', rect: [0, 0, 480, 240] },
        'body > main:nth-child(1) > div:nth-child(1)': { tag: 'div', cls: 'oversized', rect: [10, 10, 460, 220] },
        'body > main:nth-child(1) > div:nth-child(1) > span:nth-child(1)': {
          tag: 'span',
          cls: 'label',
          rect: [400, 60, 20, 10],
          text: 'Old',
        },
      },
    }),
    after: makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 480, 240] },
        'body > main:nth-child(1)': { tag: 'main', rect: [0, 0, 480, 240] },
        'body > main:nth-child(1) > div:nth-child(1)': { tag: 'div', cls: 'oversized', rect: [10, 10, 460, 220] },
        'body > main:nth-child(1) > div:nth-child(1) > span:nth-child(1)': {
          tag: 'span',
          cls: 'label',
          rect: [400, 60, 20, 10],
          text: 'New',
        },
      },
    }),
    beforePng: solidPng(480, 240, [240, 240, 240]),
    afterPng: solidPng(480, 240, [220, 220, 220]),
  });
  generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
    minWidth: 200,
    minHeight: 80,
    maxHeight: 100,
  });
  const composite = PNG.sync.read(fs.readFileSync(path.join(dirs.outDir, 'crops', 'fallback-480-content-1-after.png')));
  assert.equal(composite.width, 200, 'the 460px-wide oversized ancestor does not replace the 200px leaf crop');
  assert.equal(composite.height, 80, 'the configured 80px leaf crop remains below maxHeight');
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
  // Added/removed elements must never claim the location "renders identically" /
  // has no visible effect — that wording is reserved for paired text/style crops.
  assert.ok(!md.includes('renders identically before and after'));
  assert.ok(md.includes('No distinct before/after crop') || md.includes('element itself was removed'));
  assert.ok(!md.includes('landing-1280-content-1-after.png'));
  assert.deepEqual(
    fs.readdirSync(path.join(dirs.root, 'out', 'crops')),
    [],
    'suppression emits no clean, annotated, or zoom evidence',
  );

  rmTmp(dirs.root);
});
