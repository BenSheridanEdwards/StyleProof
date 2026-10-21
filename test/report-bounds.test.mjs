import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateStructuralStyleMapReportForTesting as generateStyleMapReport,
  summarizeProps,
} from '../dist/report.js';
import { codeValue } from '../dist/code-span.js';
import {
  makeMap,
  mkTmp,
  rmTmp,
  solidPng,
  pairFixture,
  tmpDirs,
  writeCapture,
  highlightPixelsBySide,
} from './helpers.mjs';

// ---------------------------------------- bounded report (always GitHub-renderable)

test('report.md stays under its byte budget (GitHub-renderable); report.json keeps every surface', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const N = 40;
  const M = 15;
  // Each surface carries a DISTINCT change (values keyed by surface index) so they
  // don't collapse into one "identical across N surfaces" group — N real detail blocks.
  const surfaceMap = (s, shift) =>
    makeMap({
      elements: Object.fromEntries(
        Array.from({ length: M }, (_, k) => [
          `body > div:nth-child(${k + 1})`,
          {
            tag: 'div',
            cls: `s${s}-c${k}`,
            rect: [10, 20 + k * 30, 200, 24],
            style: {
              color: `rgb(${(shift + s) % 256}, ${k}, 0)`,
              'padding-top': `${10 + shift + s}px`,
              'font-size': `${12 + k}px`,
              'margin-top': `${4 + shift}px`,
            },
          },
        ]),
      ),
    });
  // The screenshot only needs to hold every changed rect (y <= 464); report.md is
  // byte-identical to a 1280x800 run, at a fraction of the PNG encode/decode cost.
  for (let s = 0; s < N; s++) {
    const surface = `surface-${s}@1280`;
    writeCapture(beforeDir, surface, surfaceMap(s, 0), solidPng(400, 480));
    writeCapture(afterDir, surface, surfaceMap(s, 5), solidPng(400, 480));
  }

  const budget = 15_000;
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, maxReportBytes: budget });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.ok(md.length < budget * 2, `report.md must stay bounded near the budget (was ${md.length})`);
  assert.match(md, /summarized to keep this report renderable/, 'the cap is announced, not silent');
  assert.match(md, /· \d+ change\(s\)/, 'capped surfaces appear as one-line summaries');
  assert.equal(json.surfaces.length, N, 'report.json keeps every surface — the cap relocates detail, never drops it');

  // The cap must actually shrink a large report (uncapped is far bigger).
  const full = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir: path.join(root, 'out2'),
    maxReportBytes: Infinity,
  });
  const mdFull = fs.readFileSync(full.reportMdPath, 'utf8');
  assert.ok(
    mdFull.length > md.length * 2,
    `uncapped report should be far larger (capped ${md.length}, full ${mdFull.length})`,
  );
  rmTmp(root);
});

// ----------------------------------------------- hostile CSS values are escaped

// A CSS property value is author/attacker-influenced. A `|` would split a report
// table row; a backtick would close the code span and leak live Markdown. The
// render boundary must escape both so the value renders as ONE intact code cell.
test('end-to-end: a hostile CSS value renders as one intact row with no live markdown', () => {
  // A value carrying a pipe (row-splitter) AND a backtick (span-closer), plus a
  // second backtick to exercise the fence-widening path.
  const HOSTILE_BEFORE = 'counter(a) "|`x`|"';
  const HOSTILE_AFTER = 'counter(b) "|`y`|"';
  const boxWith = (content) =>
    makeMap({
      elements: {
        body: { tag: 'body', cls: '', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'box',
          rect: [40, 40, 200, 60],
          style: { content },
        },
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: boxWith(HOSTILE_BEFORE),
    after: boxWith(HOSTILE_AFTER),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800),
  });

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.changedSurfaces, 1);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Find the table row carrying the hostile value.
  const contentRow = md.split('\n').find((l) => l.startsWith('|') && l.includes('content') && l.includes('counter'));
  assert.ok(contentRow, 'the content change is rendered as a table row');

  // A GitHub table row is a single line with exactly the cell pipes it declares:
  // `| content | <before> | <after> |` → the only UNESCAPED pipes are the four
  // structural ones. Every pipe from the value must be backslash-escaped.
  const structuralPipes = (contentRow.match(/(^|[^\\])\|/g) ?? []).length;
  assert.equal(structuralPipes, 4, `row must keep exactly its 4 cell separators, got: ${contentRow}`);
  assert.ok(contentRow.includes('\\|'), 'the value pipes are backslash-escaped, not raw');

  // The value's literal text survives, readable (escape, not strip).
  assert.ok(md.includes('counter(a)') && md.includes('counter(b)'), 'both hostile values are shown verbatim');
  rmTmp(root);
});

// -------------------------------------------------- shared-chrome tier (#193)

test('report promotes a frame-wide change to a chrome callout, leaves a one-view change in place', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  // A persistent nav is on every view; head adds a second nav link on every view
  // (the shared frame). `home` additionally restyles its own h1 (view content).
  const nav = (extra) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
    ...extra,
  });
  const a2 = { 'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } } };
  for (const v of ['settings', 'reports']) {
    writeCapture(beforeDir, `${v}@1280`, makeMap({ elements: nav({}) }), solidPng(1280, 400));
    writeCapture(afterDir, `${v}@1280`, makeMap({ elements: nav(a2) }), solidPng(1280, 400));
  }
  writeCapture(
    beforeDir,
    'home@1280',
    makeMap({
      elements: {
        ...nav({}),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(0, 0, 0)' } },
      },
    }),
    solidPng(1280, 400),
  );
  writeCapture(
    afterDir,
    'home@1280',
    makeMap({
      elements: {
        ...nav(a2),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(255, 0, 0)' } },
      },
    }),
    solidPng(1280, 400),
  );

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  // One global-chrome callout at the top for the nav addition.
  assert.match(md, /## 🧱 Global chrome change/, md.slice(0, 1200));
  // The promoted group spans settings and reports; home renders in place (#752).
  assert.match(md, /across 2 of 3 captured surface base\(s\)/);
  assert.match(md, /rode the shared frame/);
  // The home h1 restyle is still shown — never hidden under the banner.
  assert.match(md, /title/);
  // Counts and exit-relevant results are unchanged by the presentational tier.
  assert.equal(res.newSurfaces, 0);
  rmTmp(root);
});

test('report headline and global chrome use surface-base counts with variant detail (#193)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const nav = (extra) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
    ...extra,
  });
  const a2 = { 'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } } };
  for (const base of ['home', 'settings']) {
    for (const w of [1280, 390]) {
      writeCapture(beforeDir, `${base}@${w}`, makeMap({ elements: nav({}) }), solidPng(w, 400));
      writeCapture(afterDir, `${base}@${w}`, makeMap({ elements: nav(a2) }), solidPng(w, 400));
    }
  }

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  const summary = md.slice(0, md.indexOf('\n### '));
  assert.match(summary, /2 changed surface bases \(4 variants\) with an existing baseline/);
  assert.doesNotMatch(summary, /Surface base.*@width/);
  assert.match(summary, /changes need review|change needs review/);
  assert.match(md, /## 🧱 Global chrome change — across all 2 captured surface base\(s\)/);
  rmTmp(root);
});

test('report headline counts live-state variants under metadata.surfaceKey product base', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const el = (color) => ({
    body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
    'body > button:nth-child(1)': {
      tag: 'button',
      cls: 'cta',
      rect: [10, 10, 120, 32],
      style: { color },
    },
  });
  const baseMap = (color) => makeMap({ elements: el(color) });
  const loadedMeta = { surfaceKey: 'dashboard', variantKey: 'loaded', variantKind: 'live-state' };
  writeCapture(beforeDir, 'dashboard@1280', baseMap('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'dashboard@1280', baseMap('rgb(255, 0, 0)'), solidPng(1280, 800));
  writeCapture(
    beforeDir,
    'dashboard-loaded@1280',
    { ...baseMap('rgb(0, 0, 0)'), metadata: loadedMeta },
    solidPng(1280, 800),
  );
  writeCapture(
    afterDir,
    'dashboard-loaded@1280',
    { ...baseMap('rgb(255, 0, 0)'), metadata: loadedMeta },
    solidPng(1280, 800),
  );

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  const summary = md.slice(0, md.indexOf('\n### ') >= 0 ? md.indexOf('\n### ') : md.length);
  assert.match(summary, /1 changed surface base \(2 variants\) with an existing baseline/);
  rmTmp(root);
});

test('report keeps a one-base, two-width change out of the global chrome tier (#752)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  // A tab strip is rendered by two bases only. settings-profile (two widths) and
  // settings-billing each restyle the same tab differently, so the path changed on
  // every base that hosts it — but no single change spans more than one base.
  const tabs = (color) => ({
    'html > body > div.tab-strip': { tag: 'div', cls: 'tab-strip', rect: [0, 0, 700, 40], style: { display: 'flex' } },
    'html > body > div.tab-strip > button:nth-child(1)': {
      tag: 'button',
      cls: 'tab',
      rect: [10, 4, 120, 32],
      style: { color },
    },
  });
  for (const w of [1024, 768]) {
    writeCapture(beforeDir, `settings-profile@${w}`, makeMap({ elements: tabs('rgb(0, 0, 0)') }), solidPng(w, 300));
    writeCapture(afterDir, `settings-profile@${w}`, makeMap({ elements: tabs('rgb(255, 0, 0)') }), solidPng(w, 300));
  }
  writeCapture(beforeDir, 'settings-billing@1280', makeMap({ elements: tabs('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'settings-billing@1280', makeMap({ elements: tabs('rgb(0, 0, 255)') }), solidPng(1280, 300));
  const page = makeMap({ elements: { 'html > body > main': { tag: 'main', style: { display: 'block' } } } });
  for (const v of ['home', 'reports']) {
    writeCapture(beforeDir, `${v}@1280`, page, solidPng(1280, 300));
    writeCapture(afterDir, `${v}@1280`, page, solidPng(1280, 300));
  }

  const md = fs.readFileSync(generateStyleMapReport({ beforeDir, afterDir, outDir }).reportMdPath, 'utf8');
  assert.doesNotMatch(md, /Global chrome/, 'a change seen on one surface base is a per-surface change, not chrome');
  assert.match(md, /settings-profile @ 1024, 768/, 'the two-width change still renders in place');
  rmTmp(root);
});

test('report does NOT promote a change that hit only some hosting surfaces (#193)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const nav = (color) => ({
    'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
    'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color } },
  });
  // nav on 3 views; the link recolours on only 2 → partial, never chrome.
  writeCapture(beforeDir, 'home@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'home@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), solidPng(1280, 300));
  writeCapture(beforeDir, 'settings@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'settings@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), solidPng(1280, 300));
  writeCapture(beforeDir, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));
  writeCapture(afterDir, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), solidPng(1280, 300));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.doesNotMatch(md, /Global chrome/, 'a change on only some hosting surfaces is not chrome');
  rmTmp(root);
});

// A cross-path annotation match is a MOVE claim, so it may suppress annotations
// only when the displacement is provable: the container where the paths diverge
// gained or lost captured children, or a same-container slide into a vacated
// slot. The three tests below pin the unprovable cases the reconciler must NOT
// swallow, and the provable one it must.

test('end-to-end: a size-changing duplicate style swap keeps annotated proof', () => {
  const item = (y, h, color) => ({ tag: 'li', cls: 'item', rect: [20, y, 200, h], style: { color } });
  const swapMap = (firstH, firstC, secondH, secondC) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: {} },
        'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 200], style: {} },
        'body > ul:nth-child(1) > li:nth-child(1)': item(20, firstH, firstC),
        'body > ul:nth-child(1) > li:nth-child(2)': item(80, secondH, secondC),
      },
    });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'sized-swap@400',
    before: swapMap(30, 'rgb(255, 0, 0)', 40, 'rgb(0, 0, 255)'),
    after: swapMap(40, 'rgb(0, 0, 255)', 30, 'rgb(255, 0, 0)'),
    beforePng: solidPng(400, 200),
    afterPng: solidPng(400, 200),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.ok(report.counts.style >= 2, 'the diff itself still records the restyle');
  assert.ok(annotatedPaths.length > 0, 'a restyle that could be a swap keeps annotated proof');
  rmTmp(root);
});

test('end-to-end: uniform-shell list insertion leaves unchanged displaced items unboxed', () => {
  const item = (y, color) => ({ tag: 'li', cls: 'item', rect: [20, y, 200, 30], style: { color } });
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1) > li:nth-child(1)': item(20, 'rgb(255, 0, 0)'),
      'body > ul:nth-child(1) > li:nth-child(2)': item(60, 'rgb(0, 0, 255)'),
      'body > ul:nth-child(1) > li:nth-child(3)': item(100, 'rgb(0, 128, 0)'),
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1)': { tag: 'ul', rect: [0, 0, 400, 300], style: {} },
      'body > ul:nth-child(1) > li:nth-child(1)': item(20, 'rgb(255, 255, 0)'),
      'body > ul:nth-child(1) > li:nth-child(2)': item(60, 'rgb(255, 0, 0)'),
      'body > ul:nth-child(1) > li:nth-child(3)': item(100, 'rgb(0, 0, 255)'),
      'body > ul:nth-child(1) > li:nth-child(4)': item(140, 'rgb(0, 128, 0)'),
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'uniform-insertion@400',
    before,
    after,
    beforePng: solidPng(400, 300),
    afterPng: solidPng(400, 300),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  const highlights = annotatedPaths
    .map((annotatedPath) => highlightPixelsBySide(path.join(outDir, annotatedPath)))
    .reduce((total, current) => ({ before: total.before + current.before, after: total.after + current.after }), {
      before: 0,
      after: 0,
    });
  assert.equal(highlights.before, 0, 'unchanged displaced items must not be boxed on the before side');
  assert.ok(highlights.after > 0, 'the inserted item itself stays annotated');
  rmTmp(root);
});

test('end-to-end: a removal and an identical addition in different containers both stay annotated', () => {
  const card = (y) => ({ tag: 'div', cls: 'card', rect: [20, y, 200, 80], style: { color: 'rgb(0, 0, 0)' } });
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 600, 500], style: {} },
      'body > section:nth-child(1)': { tag: 'section', rect: [0, 0, 600, 200], style: {} },
      'body > section:nth-child(1) > div:nth-child(1)': card(20),
      'body > section:nth-child(2)': { tag: 'section', rect: [0, 200, 600, 200], style: {} },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 600, 500], style: {} },
      'body > section:nth-child(1)': { tag: 'section', rect: [0, 0, 600, 200], style: {} },
      'body > section:nth-child(2)': { tag: 'section', rect: [0, 200, 600, 200], style: {} },
      'body > section:nth-child(2) > div:nth-child(1)': card(220),
    },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'cross-container@600',
    before,
    after,
    beforePng: solidPng(600, 500),
    afterPng: solidPng(600, 500),
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  const annotatedPaths = report.surfaces[0].regions.map((region) => region.images.annotated).filter(Boolean);
  assert.equal(report.counts.dom, 2, 'both structural findings remain in the audit');
  assert.ok(annotatedPaths.length > 0, 'independent changes in different containers keep visual proof');
  rmTmp(root);
});

test('end-to-end: a surface captured only on base renders as REMOVED, never as a new surface', () => {
  // missing:'after' = present in the baseline, absent on head — a feature going
  // invisible. It previously rendered under "new surface 🆕" with approve-the-
  // addition guidance, inviting reviewers to sign off a disappearance as growth.
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const box = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': { tag: 'div', cls: 'box', rect: [0, 0, 200, 100], style: { color } },
      },
    });
  writeCapture(beforeDir, 'home@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'home@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(beforeDir, 'pricing@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800)); // base only
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  assert.equal(res.newSurfaces, 0);
  assert.equal(res.oneSidedSurfaces, 1);
  const md = fs.readFileSync(res.reportMdPath, 'utf8');
  assert.match(md, /REMOVED surface 🗑️/);
  assert.match(md, /REMOVED surface\(s\)/);
  assert.match(md, /approving accepts the disappearance/i);
  assert.doesNotMatch(md, /pricing.*new surface 🆕/s);
  assert.doesNotMatch(md, /new surface\(s\)\*\* captured with no baseline/);
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const removedEntry = json.surfaces.find((s) => s.surface === 'pricing@1280');
  assert.equal(removedEntry.isRemoved, true);
  assert.equal(removedEntry.isNew, false);
  rmTmp(root);
});

// --------------------------------------------------------- #515 report.json persists baselineFailures + classification

test('end-to-end: report.json includes baselineFailures and classification per surface (#515)', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const box = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': { tag: 'div', cls: 'box', rect: [0, 0, 200, 100], style: { color } },
      },
    });
  writeCapture(beforeDir, 'home@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'home@1280', box('rgb(255, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'about@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'pricing@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  fs.writeFileSync(
    path.join(beforeDir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
      surfaceCaptureFailures: [
        { key: 'about@1280', reason: 'timeout on base', kind: 'capture' },
        { key: 'faq@auto', reason: 'viewport detection failed', kind: 'capture' },
        { key: 'team@900', reason: 'network error', kind: 'capture' },
        { key: 'blog@1280', reason: 'assertion failed', kind: 'capture' },
        { key: 'contact@1440', reason: 'element not found', kind: 'capture' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(afterDir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  assert.ok(Array.isArray(json.baselineFailures), 'report.json should have baselineFailures array');
  assert.equal(json.baselineFailures.length, 5, 'should have 5 baseline failures');
  assert.ok(
    json.baselineFailures.every((f) => f.reason === 'capture_failed'),
    'all failures should have bounded reason',
  );
  const homeSurface = json.surfaces.find((s) => s.representative === 'home@1280' || s.surface === 'home@1280');
  const aboutSurface = json.surfaces.find((s) => s.surface === 'about@1280');
  const pricingSurface = json.surfaces.find((s) => s.surface === 'pricing@1280');
  assert.ok(homeSurface, 'home surface should be in report');
  assert.ok(aboutSurface, 'about surface should be in report');
  assert.ok(pricingSurface, 'pricing surface should be in report');
  assert.equal(homeSurface.classification, 'changed', 'home should have classification changed');
  assert.equal(
    aboutSurface.classification,
    'baseline-repair-debt',
    'about should have classification baseline-repair-debt',
  );
  assert.equal(pricingSurface.classification, 'genuinely-new', 'pricing should have classification genuinely-new');
  assert.equal(aboutSurface.isNew, false, 'baseline-repair-debt surface should NOT be isNew');
  assert.equal(pricingSurface.isNew, true, 'genuinely-new surface should be isNew');
  rmTmp(root);
});

// --------------------------------------------------------- #516 Markdown labels from classification

test('end-to-end: Markdown surface labels match classification from report.json (#516)', () => {
  const root = mkTmp();
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const box = (color) =>
    makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > div:nth-child(1)': { tag: 'div', cls: 'box', rect: [0, 0, 200, 100], style: { color } },
      },
    });
  // before: home
  writeCapture(beforeDir, 'home@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  // after: home (changed), about (baseline-repair-debt - failed in baseline), pricing (genuinely-new)
  writeCapture(afterDir, 'home@1280', box('rgb(255, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'about@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  writeCapture(afterDir, 'pricing@1280', box('rgb(0, 0, 0)'), solidPng(1280, 800));
  // baseline manifest with capture failures for about
  fs.writeFileSync(
    path.join(beforeDir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
      surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
    }),
  );
  fs.writeFileSync(
    path.join(afterDir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Verify JSON classifications (prerequisite)
  const aboutSurface = json.surfaces.find((s) => s.surface === 'about@1280');
  const pricingSurface = json.surfaces.find((s) => s.surface === 'pricing@1280');
  assert.equal(aboutSurface.classification, 'baseline-repair-debt', 'about should be baseline-repair-debt in JSON');
  assert.equal(pricingSurface.classification, 'genuinely-new', 'pricing should be genuinely-new in JSON');

  // #516: Markdown labels must match classifications
  // baseline-repair-debt surfaces should use "baseline repair needed" label per issue spec (not "new surface")
  const aboutHeadingMatch = md.match(/`about@1280`[^`]*·[^`\n]*baseline repair needed/i);
  assert.ok(aboutHeadingMatch, 'about@1280 should have "baseline repair needed" in Markdown heading per #516 spec');
  assert.ok(!md.includes('`about@1280` · new surface'), 'about@1280 should NOT be labeled "new surface" in Markdown');

  // genuinely-new surfaces should use "new surface" label
  const pricingHeadingMatch = md.match(/`pricing@1280`[^`]*·[^`\n]*new surface/i);
  assert.ok(pricingHeadingMatch, 'pricing@1280 should have "new surface" in Markdown heading');

  // baseline failure count in Markdown should match JSON
  const baselineFailureCount = json.baselineFailures.length;
  const mdFailureCountMatch = md.match(/(\d+)\s+baseline\s+capture\s+failure/i);
  assert.ok(mdFailureCountMatch, 'Markdown should mention baseline capture failure count');
  assert.equal(parseInt(mdFailureCountMatch[1], 10), baselineFailureCount, 'Markdown failure count should match JSON');

  rmTmp(root);
});

// --------------------------------------------------------- #580 gateMode in report.json

test('report.json includes gateMode field defaulting to certify (#580)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const minimalMap = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  writeCapture(beforeDir, 'home@1280', minimalMap, null);
  writeCapture(afterDir, 'home@1280', minimalMap, null);

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.ok('gateMode' in json, 'report.json should include gateMode field');
  assert.equal(json.gateMode, 'certify', 'gateMode should default to certify');
  rmTmp(root);
});

test('report.json gateMode reflects advisory mode when specified (#580)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const minimalMap = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  writeCapture(beforeDir, 'home@1280', minimalMap, null);
  writeCapture(afterDir, 'home@1280', minimalMap, null);

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, gateMode: 'advisory' });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.equal(json.gateMode, 'advisory', 'gateMode should be advisory when specified');
  rmTmp(root);
});

test('report.json gateMode reflects review-gate mode when specified (#580)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const minimalMap = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  writeCapture(beforeDir, 'home@1280', minimalMap, null);
  writeCapture(afterDir, 'home@1280', minimalMap, null);

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, gateMode: 'review-gate' });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.equal(json.gateMode, 'review-gate', 'gateMode should be review-gate when specified');
  rmTmp(root);
});

test('report.json gateMode reflects migration mode when specified (#580)', () => {
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const minimalMap = makeMap({ elements: { body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} } } });
  writeCapture(beforeDir, 'home@1280', minimalMap, null);
  writeCapture(afterDir, 'home@1280', minimalMap, null);

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, gateMode: 'migration', migration: true });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  assert.equal(json.gateMode, 'migration', 'gateMode should be migration when specified');
  rmTmp(root);
});

// ------------------------------------------------------------
// #613 — Findings exhaustiveness: no silent drops
// ------------------------------------------------------------
// Prove report completeness: given a known set of diff findings, the report
// includes ALL of them without silent drops (accounting for documented
// aggregations). Fail-closed: input finding not in output = FAIL, output finding
// not in input (invented) = FAIL, wrong before/after in output = FAIL.
//
// Structure: The report has two layers:
// 1. JSON raw findings (surfaces[].findings[].props) — preserves all input props
//    for certification. rawCounts reflects these.
// 2. JSON counts & Markdown display — applies summarizeProps aggregation rules.
//    counts reflects the summarized view.
//
// Both layers must be exhaustive: no silent drops in raw findings, and the
// summarized view must correctly aggregate without losing information.

/**
 * Compute the expected output of summarizeProps for a set of input PropChanges.
 * This mirrors the documented aggregation rules in prop-summary.ts.
 */
function expectedSummarizedProps(inputProps) {
  return summarizeProps(inputProps);
}

/**
 * Extract all raw PropChange rows from a surface's findings in report.json.
 * Returns a flat array of { prop, before, after } objects as stored in JSON.
 */
function extractRawProps(surface) {
  const result = [];
  for (const finding of surface.findings ?? []) {
    if (finding.kind === 'style' || finding.kind === 'state') {
      for (const p of finding.props ?? []) {
        result.push({ prop: p.prop, before: p.before, after: p.after });
      }
    }
  }
  return result;
}

test('findings exhaustiveness: non-aggregated findings appear in raw JSON and Markdown (#613)', () => {
  // Create a synthetic finding with properties that do NOT aggregate.
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'card',
        rect: [100, 100, 200, 150],
        style: {
          'background-color': 'rgb(255, 255, 255)',
          'font-size': '14px',
          'line-height': '1.5',
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'card',
        rect: [100, 100, 200, 150],
        style: {
          'background-color': 'rgb(240, 240, 240)',
          'font-size': '16px',
          'line-height': '1.6',
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Expected: 3 non-aggregated findings
  const expectedInputProps = [
    { prop: 'background-color', before: 'rgb(255, 255, 255)', after: 'rgb(240, 240, 240)' },
    { prop: 'font-size', before: '14px', after: '16px' },
    { prop: 'line-height', before: '1.5', after: '1.6' },
  ];

  assert.equal(json.surfaces.length, 1, 'should have exactly one surface');
  const rawProps = extractRawProps(json.surfaces[0]);

  // Fail-closed: every expected prop MUST appear in raw JSON findings
  for (const expected of expectedInputProps) {
    const found = rawProps.find(
      (p) => p.prop === expected.prop && p.before === expected.before && p.after === expected.after,
    );
    assert.ok(found, `SILENT DROP (raw): '${expected.prop}' (${expected.before} → ${expected.after}) not in JSON`);
  }

  // Fail-closed: summarized counts should match
  const expectedSummarized = expectedSummarizedProps(expectedInputProps);
  assert.equal(json.counts.style, expectedSummarized.length, 'counts.style should reflect summarized count');

  // Fail-closed: Markdown should contain all summarized props
  for (const prop of expectedSummarized) {
    assert.match(md, new RegExp(prop.prop), `SILENT DROP (markdown): '${prop.prop}' not in Markdown`);
  }

  rmTmp(root);
});

test('findings exhaustiveness: 4-side padding aggregates in counts and Markdown, raw preserved (#613)', () => {
  // All 4 padding sides change → aggregated to 1 in counts/Markdown, but 4 in raw
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: {
          'padding-top': '10px',
          'padding-right': '10px',
          'padding-bottom': '10px',
          'padding-left': '10px',
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: {
          'padding-top': '20px',
          'padding-right': '20px',
          'padding-bottom': '20px',
          'padding-left': '20px',
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Raw JSON should have all 4 longhands (for certification)
  const rawProps = extractRawProps(json.surfaces[0]);
  for (const side of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']) {
    const found = rawProps.find((p) => p.prop === side);
    assert.ok(found, `SILENT DROP (raw): '${side}' not preserved in JSON findings`);
    assert.equal(found.before, '10px');
    assert.equal(found.after, '20px');
  }

  // rawCounts should reflect 4 raw findings
  assert.equal(json.rawCounts.style, 4, 'rawCounts.style should be 4 (all longhands)');

  // counts (summarized) should be 1 (aggregated shorthand)
  assert.equal(json.counts.style, 1, 'counts.style should be 1 (aggregated to padding shorthand)');

  // Markdown should show the shorthand, not longhands
  assert.match(
    md,
    /^\| `padding` \| `10px` \| `20px` \|$/m,
    'Markdown should list the padding shorthand with its values',
  );
  assert.doesNotMatch(md, /padding-(?:top|right|bottom|left)/, 'Markdown should not list the padding longhands');

  rmTmp(root);
});

test('findings exhaustiveness: logical→physical dropped in display, raw preserved (#613)', () => {
  // Logical twin matches physical → dropped in display, kept in raw
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'panel',
        rect: [100, 100, 200, 150],
        style: {
          'border-bottom-color': 'red',
          'border-block-end-color': 'red',
          'margin-bottom': '10px',
          'margin-block-end': '15px', // diverges from physical
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'panel',
        rect: [100, 100, 200, 150],
        style: {
          'border-bottom-color': 'blue',
          'border-block-end-color': 'blue',
          'margin-bottom': '20px',
          'margin-block-end': '25px', // still diverges
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Raw findings should have ALL props (for certification)
  const rawProps = extractRawProps(json.surfaces[0]);
  assert.ok(
    rawProps.find((p) => p.prop === 'border-bottom-color'),
    'raw should have border-bottom-color',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'border-block-end-color'),
    'raw should preserve border-block-end-color',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'margin-bottom'),
    'raw should have margin-bottom',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'margin-block-end'),
    'raw should have margin-block-end',
  );

  // rawCounts should reflect all 4 raw findings
  assert.equal(json.rawCounts.style, 4, 'rawCounts.style should be 4');

  // counts (summarized) should be 3: border-bottom-color, margin-bottom, margin-block-end
  // (border-block-end-color dropped as identical to physical)
  assert.equal(json.counts.style, 3, 'counts.style should match summarized');

  // Markdown should show physical and divergent logical, but not the matching logical twin
  assert.match(md, /border-bottom-color/, 'Markdown should have border-bottom-color');
  assert.match(md, /margin-block-end/, 'Markdown should have divergent margin-block-end');
  assert.doesNotMatch(md, /border-block-end-color/, 'Markdown should drop the logical twin of border-bottom-color');

  rmTmp(root);
});

test('findings exhaustiveness: currentColor echo dropped in display, raw preserved (#613)', () => {
  // caret-color echoing color change → dropped in display, kept in raw
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > input:nth-child(1)': {
        tag: 'input',
        cls: 'field',
        rect: [100, 100, 200, 40],
        style: {
          color: 'rgb(0, 0, 0)',
          'caret-color': 'rgb(0, 0, 0)', // echoes color
          'text-decoration-color': 'rgb(100, 100, 100)', // diverges
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > input:nth-child(1)': {
        tag: 'input',
        cls: 'field',
        rect: [100, 100, 200, 40],
        style: {
          color: 'rgb(255, 0, 0)',
          'caret-color': 'rgb(255, 0, 0)', // still echoes
          'text-decoration-color': 'rgb(200, 200, 200)', // changed independently
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Raw findings should have ALL props (for certification)
  const rawProps = extractRawProps(json.surfaces[0]);
  assert.ok(
    rawProps.find((p) => p.prop === 'color'),
    'raw should have color',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'caret-color'),
    'raw should preserve caret-color (even if echo)',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'text-decoration-color'),
    'raw should have text-decoration-color',
  );

  // rawCounts should reflect all 3 raw findings
  assert.equal(json.rawCounts.style, 3, 'rawCounts.style should be 3');

  // counts (summarized) should be 2: color + text-decoration-color (caret-color echo dropped)
  const expectedSummarized = expectedSummarizedProps([
    { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'caret-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'text-decoration-color', before: 'rgb(100, 100, 100)', after: 'rgb(200, 200, 200)' },
  ]);
  assert.equal(json.counts.style, expectedSummarized.length, 'counts.style should match summarized');

  // Markdown should show color and divergent text-decoration-color
  assert.match(md, /\bcolor\b/, 'Markdown should have color');
  assert.match(md, /text-decoration-color/, 'Markdown should have divergent text-decoration-color');

  rmTmp(root);
});

test('findings exhaustiveness: multiple elements, all raw findings accounted for (#613)', () => {
  // Multiple elements with different findings — verify exhaustive coverage.
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > nav:nth-child(1)': {
        tag: 'nav',
        cls: 'navbar',
        rect: [0, 0, 1280, 60],
        style: { 'background-color': 'rgb(255, 255, 255)' },
      },
      'body > main:nth-child(2)': {
        tag: 'main',
        cls: 'content',
        rect: [0, 60, 1280, 740],
        style: { 'font-size': '14px' },
      },
      'body > footer:nth-child(3)': {
        tag: 'footer',
        cls: 'footer',
        rect: [0, 760, 1280, 40],
        style: { color: 'rgb(100, 100, 100)' },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > nav:nth-child(1)': {
        tag: 'nav',
        cls: 'navbar',
        rect: [0, 0, 1280, 60],
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
      'body > main:nth-child(2)': {
        tag: 'main',
        cls: 'content',
        rect: [0, 60, 1280, 740],
        style: { 'font-size': '16px' },
      },
      'body > footer:nth-child(3)': {
        tag: 'footer',
        cls: 'footer',
        rect: [0, 760, 1280, 40],
        style: { color: 'rgb(80, 80, 80)' },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  // Collect all raw props across all findings
  const allRawProps = [];
  for (const surface of json.surfaces) {
    for (const finding of surface.findings ?? []) {
      if (finding.kind === 'style' || finding.kind === 'state') {
        for (const p of finding.props ?? []) {
          allRawProps.push({ path: finding.path, prop: p.prop, before: p.before, after: p.after });
        }
      }
    }
  }

  // Expected: 3 elements, 1 prop each = 3 total raw props
  assert.equal(allRawProps.length, 3, `expected 3 raw findings, got ${allRawProps.length}`);

  // Verify each element's finding is present
  const navProp = allRawProps.find((p) => p.path.includes('nav') && p.prop === 'background-color');
  assert.ok(navProp, 'SILENT DROP: navbar background-color not found');
  assert.equal(navProp.before, 'rgb(255, 255, 255)');
  assert.equal(navProp.after, 'rgb(240, 240, 240)');

  const mainProp = allRawProps.find((p) => p.path.includes('main') && p.prop === 'font-size');
  assert.ok(mainProp, 'SILENT DROP: main font-size not found');
  assert.equal(mainProp.before, '14px');
  assert.equal(mainProp.after, '16px');

  const footerProp = allRawProps.find((p) => p.path.includes('footer') && p.prop === 'color');
  assert.ok(footerProp, 'SILENT DROP: footer color not found');
  assert.equal(footerProp.before, 'rgb(100, 100, 100)');
  assert.equal(footerProp.after, 'rgb(80, 80, 80)');

  // Counts should also be correct
  assert.equal(json.rawCounts.style, 3);
  assert.equal(json.counts.style, 3); // No aggregation for these props

  rmTmp(root);
});

test('findings exhaustiveness: wrong before/after value = FAIL (#613)', () => {
  // Verifies the test catches wrong values, not just presence.
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: { 'border-radius': '4px' },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: { 'border-radius': '8px' },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  const rawProps = extractRawProps(json.surfaces[0]);
  const radiusProp = rawProps.find((p) => p.prop === 'border-radius');

  assert.ok(radiusProp, 'border-radius finding should be present');
  assert.equal(radiusProp.before, '4px', 'before value mismatch = FAIL');
  assert.equal(radiusProp.after, '8px', 'after value mismatch = FAIL');

  rmTmp(root);
});

test('findings exhaustiveness: state-delta findings also exhaustive (#613)', () => {
  // Interactive state findings (hover, focus, etc.) must also be exhaustive.
  // Note: states structure is { [path]: { [state]: { [sub]: { [prop]: value } } } }
  const { beforeDir, afterDir, outDir, root } = tmpDirs();
  const btnPath = 'body > button:nth-child(1)';

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      [btnPath]: {
        tag: 'button',
        cls: 'btn',
        rect: [100, 100, 120, 40],
        style: { 'background-color': 'rgb(0, 100, 200)' },
      },
    },
    states: {
      [btnPath]: {
        hover: { [btnPath]: { 'background-color': 'rgb(0, 120, 220)' } },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      [btnPath]: {
        tag: 'button',
        cls: 'btn',
        rect: [100, 100, 120, 40],
        style: { 'background-color': 'rgb(0, 100, 200)' },
      },
    },
    states: {
      [btnPath]: {
        hover: { [btnPath]: { 'background-color': 'rgb(0, 150, 255)' } },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Find state findings in raw JSON
  let stateFindings = [];
  for (const surface of json.surfaces) {
    for (const finding of surface.findings ?? []) {
      if (finding.kind === 'state') {
        stateFindings.push(finding);
      }
    }
  }

  assert.ok(stateFindings.length > 0, 'should have state findings');

  const hoverFinding = stateFindings.find((f) => f.state === 'hover');
  assert.ok(hoverFinding, 'SILENT DROP: hover state finding not found');
  assert.ok(hoverFinding.props.length > 0, 'hover finding should have props');

  const bgProp = hoverFinding.props.find((p) => p.prop === 'background-color');
  assert.ok(bgProp, 'SILENT DROP: hover background-color not in state finding');
  assert.equal(bgProp.before, 'rgb(0, 120, 220)');
  assert.equal(bgProp.after, 'rgb(0, 150, 255)');

  // Counts should reflect state findings
  assert.equal(json.rawCounts.state, 1, 'rawCounts.state should be 1');

  // Markdown should mention hover state
  assert.match(md, /hover/i, 'Markdown should mention hover state');

  rmTmp(root);
});

test('findings exhaustiveness: markdown report contains all summarized props (#613)', () => {
  // Verify the Markdown output contains all summarized findings.
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'card',
        rect: [100, 100, 200, 150],
        style: {
          'background-color': 'rgb(255, 255, 255)',
          'box-shadow': 'none',
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'card',
        rect: [100, 100, 200, 150],
        style: {
          'background-color': 'rgb(245, 245, 245)',
          'box-shadow': '0px 2px 4px rgba(0, 0, 0, 0.1)',
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Both properties should appear in the markdown
  assert.match(md, /background-color/, 'SILENT DROP: background-color not in markdown');
  assert.match(md, /box-shadow/, 'SILENT DROP: box-shadow not in markdown');

  rmTmp(root);
});

test('findings exhaustiveness: gap shorthand aggregates in display, raw preserved (#613)', () => {
  // row-gap + column-gap → gap shorthand in display, raw preserved
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'grid',
        rect: [100, 100, 400, 300],
        style: {
          'row-gap': '10px',
          'column-gap': '10px',
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'grid',
        rect: [100, 100, 400, 300],
        style: {
          'row-gap': '20px',
          'column-gap': '20px',
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Raw JSON should have both longhands (for certification)
  const rawProps = extractRawProps(json.surfaces[0]);
  assert.ok(
    rawProps.find((p) => p.prop === 'row-gap'),
    'raw should preserve row-gap',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'column-gap'),
    'raw should preserve column-gap',
  );

  // rawCounts should be 2
  assert.equal(json.rawCounts.style, 2, 'rawCounts.style should be 2 (both longhands)');

  // counts (summarized) should be 1 (aggregated to gap shorthand)
  assert.equal(json.counts.style, 1, 'counts.style should be 1 (gap shorthand)');

  // Markdown should show gap shorthand
  assert.match(md, /gap/, 'Markdown should contain gap shorthand');

  rmTmp(root);
});

test('findings exhaustiveness: outline shorthand aggregates in display, raw preserved (#613)', () => {
  // outline-width + outline-style + outline-color → outline shorthand in display
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        rect: [100, 100, 120, 40],
        style: {
          'outline-width': '2px',
          'outline-style': 'solid',
          'outline-color': 'rgb(0, 100, 200)',
        },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        rect: [100, 100, 120, 40],
        style: {
          'outline-width': '3px',
          'outline-style': 'dashed',
          'outline-color': 'rgb(0, 150, 255)',
        },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));
  const md = fs.readFileSync(res.reportMdPath, 'utf8');

  // Raw JSON should have all 3 longhands (for certification)
  const rawProps = extractRawProps(json.surfaces[0]);
  assert.ok(
    rawProps.find((p) => p.prop === 'outline-width'),
    'raw should preserve outline-width',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'outline-style'),
    'raw should preserve outline-style',
  );
  assert.ok(
    rawProps.find((p) => p.prop === 'outline-color'),
    'raw should preserve outline-color',
  );

  // rawCounts should be 3
  assert.equal(json.rawCounts.style, 3, 'rawCounts.style should be 3 (all longhands)');

  // counts (summarized) should be 1 (aggregated to outline shorthand)
  assert.equal(json.counts.style, 1, 'counts.style should be 1 (outline shorthand)');

  // Markdown should show outline shorthand
  assert.match(md, /outline/, 'Markdown should contain outline shorthand');

  rmTmp(root);
});

test('findings exhaustiveness: invented finding in report = FAIL (#613)', () => {
  // This test verifies the mechanism catches invented findings
  const { beforeDir, afterDir, outDir, root } = tmpDirs();

  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: { 'background-color': 'rgb(255, 255, 255)' },
      },
    },
  });

  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'box',
        rect: [100, 100, 200, 150],
        style: { 'background-color': 'rgb(240, 240, 240)' },
      },
    },
  });

  writeCapture(beforeDir, 'page@1280', before, solidPng(1280, 800));
  writeCapture(afterDir, 'page@1280', after, solidPng(1280, 800));

  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const json = JSON.parse(fs.readFileSync(res.reportJsonPath, 'utf8'));

  const rawProps = extractRawProps(json.surfaces[0]);

  // Verify NO invented findings (props we didn't put in)
  const inventedProps = rawProps.filter((p) => p.prop !== 'background-color');
  assert.equal(inventedProps.length, 0, `INVENTED FINDINGS: ${inventedProps.map((p) => p.prop).join(', ')}`);

  // Verify the expected finding IS there
  const bgProp = rawProps.find((p) => p.prop === 'background-color');
  assert.ok(bgProp, 'expected background-color finding');

  rmTmp(root);
});

test('a hostile element path key stays inside its code span in report.md and report.html', () => {
  // Element path keys come from the capture map (untrusted in the fork split).
  const hostile = 'body > p` [Approve here](javascript:alert%28document%2Edomain%29) `';
  // Volatile subtree paths come from the same maps and print in the headline's lists.
  const headVolatile = 'main` [Head link](javascript:alert%281%29) `';
  const baseVolatile = 'aside` [Base link](javascript:alert%282%29) `';
  const map = (color, volatile) => ({
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        [hostile]: { tag: 'p', cls: 'lede', rect: [100, 100, 400, 40], style: { color } },
      },
    }),
    volatile: [volatile],
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: map('rgb(0, 0, 0)', baseVolatile),
    after: map('rgb(255, 0, 0)', headVolatile),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800, [180, 180, 180]),
  });
  try {
    // Default options: the folded plain-English bullets carry the label too.
    generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    const headings = md.split('\n').filter((line) => line.includes('Approve here'));
    assert.ok(headings.length >= 2, 'heading and summary bullet both render the label');
    for (const line of headings) {
      assert.match(line, /``p` \[Approve here\]\(javascript:alert%28document%2Edomain%29\) `\.lede``/);
    }
    assert.ok(
      md.includes('- `home@1280` · `` main` [Head link](javascript:alert%281%29) ` ``'),
      'head-only volatile path',
    );
    assert.ok(
      md.includes('- `home@1280` · `` aside` [Base link](javascript:alert%282%29) ` ``'),
      'base-only volatile path',
    );
    assert.doesNotMatch(html, /href="javascript:/);
  } finally {
    rmTmp(root);
  }
});

test('a hostile colour-token name or pseudo-element stays inside its code span in report.md and report.html', () => {
  // Token names are page-controlled `:root` custom properties; CSS escapes let them carry a full URL.
  const token = 'tok`[Approve](https://evil.example/approve)`';
  const pseudo = '::before` [Pseudo link](https://evil.example/pseudo) `';
  const map = (color) => ({
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
        'body > button': {
          tag: 'button',
          cls: 'cta',
          rect: [100, 100, 200, 40],
          style: { 'background-color': color },
          pseudo: { [pseudo]: { color } },
        },
      },
    }),
    tokens: { [`--${token}`]: 'rgb(26, 127, 55)' },
  });
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: map('rgb(26, 127, 55)'),
    after: map('rgb(180, 35, 42)'),
    beforePng: solidPng(1280, 800),
    afterPng: solidPng(1280, 800, [180, 180, 180]),
  });
  try {
    generateStyleMapReport({ beforeDir, afterDir, outDir });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    assert.ok(md.includes('`` tok`[Approve](https://evil.example/approve)` ``'), 'token name keeps one code span');
    assert.ok(
      md.includes('On `` ::before` [Pseudo link](https://evil.example/pseudo) ` ``:'),
      'pseudo keeps one code span',
    );
    assert.doesNotMatch(html, /href="https:\/\/evil\.example/);
  } finally {
    rmTmp(root);
  }
});

test('codeValue escapes only the pipe, leaving backslashes for cmark-gfm to render as written', () => {
  // GitHub's table parser splits at a `|` without a backslash directly before it and unescapes
  // `\|` alone, so the cell below renders as `content: "a\|b" | x\\|y` exactly as captured.
  const value = String.raw`content: "a\|b" | x\\|y`;
  assert.equal(codeValue(value), '`' + String.raw`content: "a\\|b" \| x\\\|y` + '`');
});
