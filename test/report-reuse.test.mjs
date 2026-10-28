import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { annotationPaths } from '../dist/report/annotation-paths.js';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const sibling = (n) => `body > main > button:nth-child(${n})`;
const NAV = 'body > nav';

test('annotationPaths reconciles each map pair once', () => {
  const first = { tag: 'button', cls: 'first', rect: [120, 180, 100, 30] };
  const second = { tag: 'button', cls: 'second', rect: [120, 650, 100, 30] };
  const stable = { tag: 'footer', rect: [0, 850, 400, 40] };
  const plainBefore = makeMap({ elements: { [sibling(1)]: first, [sibling(2)]: second, footer: stable } });

  const plainAfter = makeMap({
    elements: {
      [sibling(1)]: { ...first, cls: 'inserted' },
      [sibling(2)]: first,
      [sibling(3)]: second,
      footer: stable,
    },
  });

  let enumerations = 0;

  const observed = (map) => ({
    ...map,
    elements: new Proxy(map.elements, {
      ownKeys(target) {
        enumerations++;

        return Reflect.ownKeys(target);
      },
    }),
  });

  const before = observed(plainBefore);
  const after = observed(plainAfter);

  const insertion = [
    { kind: 'dom', change: 'removed', path: sibling(1) },
    { kind: 'dom', change: 'added', path: sibling(2) },
    { kind: 'dom', change: 'added', path: sibling(1) },
  ];

  const restyle = [{ kind: 'style', path: 'footer', props: [{ prop: 'color', before: 'gray', after: 'blue' }] }];
  const expected = (findings) => annotationPaths(findings, structuredClone(plainBefore), structuredClone(plainAfter));
  const initial = annotationPaths(insertion, before, after);
  assert.deepEqual(initial, { before: [], after: [sibling(1)] }, 'moved siblings are not outlined');
  assert.deepEqual(initial, expected(insertion));
  assert.ok(enumerations > 0, 'the first call visits the elements');
  const firstCount = enumerations;
  const repeated = annotationPaths(restyle, before, after);
  assert.deepEqual(repeated, expected(restyle));
  assert.deepEqual(repeated, { before: ['footer'], after: ['footer'] }, 'findings remain specific to each call');
  assert.equal(enumerations, firstCount, 'the same map objects must not be re-enumerated');
  assert.deepEqual(annotationPaths(insertion, before, { ...after }), expected(insertion));
  assert.ok(enumerations > firstCount, 'a new after object needs its own reconciliation');
  const secondCount = enumerations;
  assert.deepEqual(annotationPaths(restyle, { ...before }, after), expected(restyle));
  assert.ok(enumerations > secondCount, 'a new before object needs its own reconciliation');
});

function reportMap(head, chrome, changed) {
  const color = head && changed ? 'rgb(0, 0, 255)' : 'rgb(128, 128, 128)';

  const elements = {
    body: { tag: 'body', rect: [0, 0, 400, 900] },
    [NAV]: { tag: 'nav', cls: 'sidebar', rect: [0, 0, 80, 900], text: '' },
    'body > main': { tag: 'main', rect: [100, 150, 300, 600] },
  };

  const states = {};

  for (const [index, y] of [180, 650].entries()) {
    const target = sibling(index + 1);
    elements[target] = { tag: 'button', cls: `action-${index}`, rect: [120, y, 100, 30], style: { color } };
    states[target] = {
      hover: { [target]: { 'background-color': head && changed ? 'rgb(252, 165, 165)' : 'rgb(165, 243, 252)' } },
    };
  }

  if (chrome && head) {
    for (const n of [1, 2]) {
      elements[`${NAV} > a:nth-child(${n})`] = {
        tag: 'a',
        cls: `link-${n}`,
        rect: [0, n * 40, 80, 30],
        text: `Item ${n}`,
      };
    }
  }

  return makeMap({ elements, states });
}

function fixture(t, baseHeight = 900, chrome = false) {
  const root = mkTmp('styleproof-report-reuse-');
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const files = [];

  for (const dir of [beforeDir, afterDir]) {
    const head = dir === afterDir;

    for (const surface of chrome ? ['home@1280', 'pricing@960'] : ['home@1280']) {
      writeCapture(
        dir,
        surface,
        reportMap(head, chrome, surface === 'home@1280'),
        solidPng(400, baseHeight, head ? [210, 210, 210] : [200, 200, 200]),
      );
      const base = path.join(dir, `${surface}.png`);
      const hover = path.join(dir, `${surface}.hover.png`);
      fs.writeFileSync(hover, solidPng(400, 900, head ? [252, 165, 165] : [165, 243, 252]));
      files.push(base, hover);
    }
  }

  return { root, beforeDir, afterDir, outDir: path.join(root, 'report'), files };
}

test('report decodes each screenshot once per surface', async (t) => {
  for (const baseHeight of [900, 100]) {
    await t.test(`resting screenshot height ${baseHeight}`, (t) => {
      const dirs = fixture(t, baseHeight);
      const read = t.mock.method(fs, 'readFileSync');
      const result = generateReport(dirs);

      const counts = dirs.files.map((file) => [
        file,
        read.mock.calls.filter((call) => call.arguments[0] === file).length,
      ]);

      read.mock.restore();
      const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      assert.equal(json.surfaces.length, 1);
      assert.equal(json.surfaces[0].regions.length, 2, 'separated changes exercise repeated state crops');

      for (const region of json.surfaces[0].regions) {
        assert.ok(region.stateImages.hover.composite, 'each region has visible hover evidence');
      }

      assert.deepEqual(
        counts,
        dirs.files.map((file) => [file, 1]),
      );
    });
  }
});

async function uncachedReport(root) {
  // Use the real renderer with WeakMap lookups disabled only in the two cache-owning
  // modules. This also runs on the pre-cache code, without a committed output golden.
  const runtime = path.join(root, 'uncached-runtime');
  fs.cpSync(new URL('../dist/', import.meta.url), runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(runtime, 'node_modules'), 'dir');

  for (const module of ['annotation-paths', 'shared']) {
    const file = path.join(runtime, 'report', `${module}.js`);
    fs.writeFileSync(
      file,
      `class WeakMap extends globalThis.WeakMap { get() { return undefined; } }\n${fs.readFileSync(file, 'utf8')}`,
    );
  }

  return (await import(pathToFileURL(path.join(runtime, 'report.js')).href)).generateStructuralStyleMapReportForTesting;
}

function reportTree(outDir) {
  const files = fs
    .readdirSync(outDir, { recursive: true })
    .filter((file) => ['report.md', 'report.json', 'report.html'].includes(file) || file.startsWith(`crops${path.sep}`))
    .sort();

  assert.ok(files.includes('report.md') && files.includes('report.json') && files.includes('report.html'));
  assert.ok(
    files.some((file) => file.endsWith('.png')),
    'the byte comparison includes crops',
  );

  return files.map((file) => [file, fs.readFileSync(path.join(outDir, file))]);
}

test('report output and every crop are byte-identical to an uncached run across generations', async (t) => {
  const dirs = fixture(t, 900, true);
  const uncached = await uncachedReport(dirs.root);
  const uncachedDir = path.join(dirs.root, 'uncached-report');
  uncached({ ...dirs, outDir: uncachedDir, includeContent: true });
  const expected = reportTree(uncachedDir);
  const markdown = fs.readFileSync(path.join(uncachedDir, 'report.md'), 'utf8');
  assert.match(markdown, /Global chrome — 2 element changes/);

  for (const n of [1, 2]) {
    assert.ok(
      expected.some(([file]) => file.includes(`-chrome-${n}-composite.png`)),
      'each chrome entry has a crop',
    );
  }

  for (const generation of [1, 2]) {
    const outDir = path.join(dirs.root, `report-${generation}`);
    generateReport({ ...dirs, outDir, includeContent: true });
    assert.deepEqual(reportTree(outDir), expected, `report generation ${generation} matches the uncached bytes`);
  }
});
