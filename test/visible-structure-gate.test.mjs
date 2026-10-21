// Visible added/removed elements on paired surfaces elevate to reviewable
// (STYLE_REVIEW_REQUIRED). Invisible / zero-size DOM churn and pure text stay advisory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { generateStyleMapReport } from '../dist/report.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import {
  isVisibleCapturedElement,
  collectElevatedVisibleStructure,
  withElevatedVisibleStructureCounts,
} from '../dist/visible-structure-gate.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF = path.join(ROOT, 'bin/styleproof-diff.mjs');
const REPORT = path.join(ROOT, 'bin/styleproof-report.mjs');

function writePairManifests(dirs) {
  const body = {
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
  };
  fs.writeFileSync(path.join(dirs.beforeDir, 'styleproof-manifest.json'), JSON.stringify(body));
  fs.writeFileSync(
    path.join(dirs.afterDir, 'styleproof-manifest.json'),
    JSON.stringify({ ...body, sha: 'b'.repeat(40) }),
  );
}

const SETUP = 'body > button.setup:nth-child(1)';
const WARN = `${SETUP} > i.warn:nth-child(1)`;
const OK = `${SETUP} > span.ok:nth-child(1)`;

function baseBoard(extra = {}) {
  return {
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 300], style: { display: 'block' } },
        [SETUP]: {
          tag: 'button',
          cls: 'setup',
          rect: [10, 10, 120, 32],
          style: { display: 'flex' },
          text: 'Setup',
        },
        ...extra,
      },
    }),
    viewport: { width: 400, height: 300 },
  };
}

function fixture({ before, after, includeContent = true }) {
  const dirs = tmpDirs();
  writeCapture(dirs.beforeDir, 'access@1280', before, solidPng(400, 300, [20, 20, 20]));
  writeCapture(dirs.afterDir, 'access@1280', after, solidPng(400, 300, [40, 40, 40]));
  writePairManifests(dirs);
  const result = generateStyleMapReport({ ...dirs, includeContent });
  return {
    dirs,
    result,
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

test('isVisibleCapturedElement: non-zero box, not display:none / visibility:hidden / opacity 0, in viewport', () => {
  const map = { ...makeMap({ elements: {} }), viewport: { width: 400, height: 300 } };
  assert.equal(
    isVisibleCapturedElement(
      { tag: 'i', cls: 'warn', rect: [10, 10, 16, 16], style: { display: 'inline-block', opacity: '1' } },
      map,
    ),
    true,
  );
  assert.equal(
    isVisibleCapturedElement({ tag: 'i', cls: 'x', rect: [10, 10, 0, 16], style: { display: 'block' } }, map),
    false,
  );
  assert.equal(
    isVisibleCapturedElement({ tag: 'i', cls: 'x', rect: [10, 10, 16, 16], style: { display: 'none' } }, map),
    false,
  );
  assert.equal(
    isVisibleCapturedElement(
      { tag: 'i', cls: 'x', rect: [10, 10, 16, 16], style: { display: 'block', visibility: 'hidden' } },
      map,
    ),
    false,
  );
  assert.equal(
    isVisibleCapturedElement(
      { tag: 'i', cls: 'x', rect: [10, 10, 16, 16], style: { display: 'block', opacity: '0' } },
      map,
    ),
    false,
  );
  // Outside the captured viewport
  assert.equal(
    isVisibleCapturedElement({ tag: 'i', cls: 'x', rect: [500, 10, 16, 16], style: { display: 'block' } }, map),
    false,
  );
});

test('visible element add on a paired surface elevates reviewableCounts.dom and needs Approve', () => {
  const { dirs, json, md } = fixture({
    before: baseBoard({
      [OK]: { tag: 'span', cls: 'ok', rect: [100, 16, 12, 12], style: { display: 'inline-block', opacity: '1' } },
    }),
    after: baseBoard({
      [WARN]: {
        tag: 'i',
        cls: 'warn',
        rect: [100, 16, 12, 12],
        style: { display: 'inline-block', opacity: '1' },
      },
    }),
  });
  assert.ok((json.reviewableCounts?.dom ?? 0) >= 1, 'visible add/remove must enter reviewableCounts.dom');
  assert.equal(json.comparison?.hasReviewableEvidence, true);
  assert.ok((json.elevatedVisibleStructure ?? json.content?.elevatedVisibleStructure ?? 0) >= 1);
  assert.match(md, /reviewable|needs review|STYLE_REVIEW_REQUIRED|Approve/i);
  // Must not claim an added/removed element "renders identically" / has no visible effect.
  assert.doesNotMatch(md, /element added[\s\S]{0,400}renders identically before and after/);
  assert.doesNotMatch(md, /element removed[\s\S]{0,400}renders identically before and after/);
  const verdict = classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: false, ...(json.comparison ?? {}) },
      reportConsistency: { ok: true },
      statesUncertified: 0,
      reviewableCounts: json.reviewableCounts,
      surfaces: [],
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: true },
  );
  assert.equal(verdict.state, 'STYLE_REVIEW_REQUIRED');
  rmTmp(dirs.root);
});

test('invisible / zero-size structure add stays advisory (does not elevate)', () => {
  const { dirs, json } = fixture({
    before: baseBoard(),
    after: baseBoard({
      'body > div.ghost:nth-child(2)': {
        tag: 'div',
        cls: 'ghost',
        rect: [10, 50, 0, 0],
        style: { display: 'none' },
      },
    }),
  });
  assert.equal(json.elevatedVisibleStructure ?? json.content?.elevatedVisibleStructure ?? 0, 0);
  assert.equal(json.reviewableCounts?.dom ?? 0, 0);
  assert.equal(json.comparison?.hasReviewableEvidence ?? false, false);
  rmTmp(dirs.root);
});

// #950: the report folds a one-sided subtree into its root; a root with no box of its own
// must not hide the visible elements folded into it from the gate.
const WRAP = 'body > div.wrap:nth-child(2)';
const DOCK = 'body > div.dock:nth-child(2)';
const contentsWrap = { tag: 'div', cls: 'wrap', rect: [0, 0, 0, 0], style: { display: 'contents' } };
const pill = { tag: 'span', cls: 'pill', rect: [20, 50, 69, 38], style: { display: 'inline-block' }, text: 'Go' };
const ZERO_SIZE_WRAPPERS = {
  'a display:contents wrapper around a visible element': {
    [WRAP]: contentsWrap,
    [`${WRAP} > span.pill:nth-child(1)`]: pill,
  },
  'a zero-height wrapper around a visible position:fixed element': {
    [DOCK]: { tag: 'div', cls: 'dock', rect: [0, 50, 400, 0], style: { display: 'block' } },
    [`${DOCK} > div.toast:nth-child(1)`]: {
      tag: 'div',
      cls: 'toast',
      rect: [20, 230, 300, 50],
      style: { display: 'block', position: 'fixed' },
    },
  },
};

/** styleproof-diff and report verdicts for a bound, complete, self-checked pair (so exit 0 certifies). */
function gateVerdicts(before, after) {
  const dirs = tmpDirs();
  const productState = { id: 'fixture', revision: '1' };
  writeCapture(dirs.beforeDir, 'access@1280', { ...before, metadata: { productState } }, solidPng(400, 300));
  writeCapture(dirs.afterDir, 'access@1280', { ...after, metadata: { productState } }, solidPng(400, 300, [9, 9, 9]));
  writePairManifests(dirs);
  const ledger = { version: 1, expected: ['access'], exclude: {}, determinism: 'self-checked' };
  for (const dir of [dirs.beforeDir, dirs.afterDir]) {
    fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify(ledger));
  }
  const jsonPath = path.join(dirs.root, 'out.json');
  const shas = ['--expected-before-sha', 'a'.repeat(40), '--expected-after-sha', 'b'.repeat(40)];
  const diff = spawnSync(process.execPath, [DIFF, dirs.beforeDir, dirs.afterDir, '--json', jsonPath, ...shas], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const report = generateStyleMapReport({ ...dirs, includeContent: true });
  const verdicts = {
    diffExit: diff.status,
    certifiesFully: json.certifiesFully,
    diffDom: json.reviewableCounts?.dom ?? 0,
    reportDom: JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8')).reviewableCounts?.dom ?? 0,
  };
  rmTmp(dirs.root);
  return verdicts;
}

const ELEVATED = { diffExit: 1, certifiesFully: false, diffDom: 1, reportDom: 1 };
const CERTIFIED = { diffExit: 0, certifiesFully: true, diffDom: 0, reportDom: 0 };

for (const [name, subtree] of Object.entries(ZERO_SIZE_WRAPPERS)) {
  for (const [direction, before, after] of [
    ['added', baseBoard(), baseBoard(subtree)],
    ['removed', baseBoard(subtree), baseBoard()],
  ]) {
    test(`${name} ${direction} needs review in both CLIs (#950)`, () => {
      assert.deepEqual(gateVerdicts(before, after), ELEVATED);
    });
  }
}

test('a zero-size wrapper whose children are hidden or zero-size stays advisory (#950)', () => {
  const ghosts = baseBoard({
    [WRAP]: contentsWrap,
    [`${WRAP} > i.none:nth-child(1)`]: { tag: 'i', cls: 'none', rect: [0, 0, 0, 0], style: { display: 'none' } },
    [`${WRAP} > i.flat:nth-child(2)`]: { tag: 'i', cls: 'flat', rect: [20, 50, 69, 0], style: { display: 'block' } },
    [`${WRAP} > i.hidden:nth-child(3)`]: {
      tag: 'i',
      cls: 'hidden',
      rect: [20, 50, 69, 38],
      style: { display: 'block', visibility: 'hidden' },
    },
  });
  assert.deepEqual(gateVerdicts(baseBoard(), ghosts), CERTIFIED);
  assert.deepEqual(gateVerdicts(ghosts, baseBoard()), CERTIFIED);
});

test('wrapping an existing element in a display:contents wrapper stays advisory (#950)', () => {
  // Own-text identity pairs the moved element, so only the boxless wrapper is one-sided.
  const bare = baseBoard({ 'body > span.pill:nth-child(2)': pill });
  const wrapped = baseBoard({ [WRAP]: contentsWrap, [`${WRAP} > span.pill:nth-child(1)`]: pill });
  for (const [before, after] of [
    [bare, wrapped],
    [wrapped, bare],
  ]) {
    const { dirs } = fixture({ before, after });
    assert.equal(collectElevatedVisibleStructure(dirs).count, 0);
    rmTmp(dirs.root);
  }
});

test('pure text content change stays advisory (no elevation)', () => {
  const { dirs, json } = fixture({
    before: baseBoard({
      [OK]: {
        tag: 'span',
        cls: 'ok',
        rect: [100, 16, 12, 12],
        style: { display: 'inline-block' },
        text: 'Setup · Vault connected',
      },
    }),
    after: baseBoard({
      [OK]: {
        tag: 'span',
        cls: 'ok',
        rect: [100, 16, 12, 12],
        style: { display: 'inline-block' },
        text: 'Setup · Vault connected · Discovery: ignored',
      },
    }),
  });
  assert.equal(json.elevatedVisibleStructure ?? json.content?.elevatedVisibleStructure ?? 0, 0);
  assert.equal(json.reviewableCounts?.dom ?? 0, 0);
  rmTmp(dirs.root);
});

test('styleproof-diff exit 1 when a visible element is added on a paired surface', () => {
  const dirs = tmpDirs();
  writeCapture(
    dirs.beforeDir,
    'access@1280',
    baseBoard({
      [OK]: { tag: 'span', cls: 'ok', rect: [100, 16, 12, 12], style: { display: 'inline-block' } },
    }),
    solidPng(400, 300),
  );
  writeCapture(
    dirs.afterDir,
    'access@1280',
    baseBoard({
      [WARN]: { tag: 'i', cls: 'warn', rect: [100, 16, 12, 12], style: { display: 'inline-block' } },
    }),
    solidPng(400, 300, [100, 100, 100]),
  );
  writePairManifests(dirs);
  const jsonPath = path.join(dirs.root, 'out.json');
  const result = spawnSync(process.execPath, [DIFF, dirs.beforeDir, dirs.afterDir, '--json', jsonPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr || result.stdout}`);
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.ok((json.reviewableCounts?.dom ?? 0) >= 1);
  assert.ok((json.elevatedVisibleStructure ?? 0) >= 1);
  rmTmp(dirs.root);
});

test('expanded below-fold addition requires review in both CLIs', () => {
  const scroller = 'body > main:nth-child(1)';
  const dirs = tmpDirs();
  try {
    const before = makeMap({
      elements: { [scroller]: { rect: [0, 0, 1280, 720], style: { overflow: 'auto' } } },
    });
    before.viewport = { width: 1280, height: 720, documentHeight: 720, screenshotHeight: 3000 };
    const after = structuredClone(before);
    after.elements[`${scroller} > div.banner:nth-child(1)`] = {
      tag: 'div',
      cls: 'banner',
      rect: [0, 2000, 1280, 80],
      screenshotRect: [0, 2000, 1280, 80],
      style: { position: 'absolute', display: 'block' },
    };
    for (const [dir, map] of [
      [dirs.beforeDir, before],
      [dirs.afterDir, after],
    ]) {
      writeCapture(dir, 'nested@1280', map, solidPng(1280, 3000));
    }
    writePairManifests(dirs);
    const jsonPath = path.join(dirs.root, 'diff.json');
    for (const [bin, args, receipt] of [
      [DIFF, ['--allow-unasserted', '--json', jsonPath], jsonPath],
      [REPORT, ['--out', dirs.outDir], path.join(dirs.outDir, 'report.json')],
    ]) {
      for (const [afterDir, expected] of [
        [dirs.beforeDir, 0],
        [dirs.afterDir, 1],
      ]) {
        const sourceArgs = [
          '--expected-before-sha',
          'a'.repeat(40),
          '--expected-after-sha',
          (expected ? 'b' : 'a').repeat(40),
        ];
        const result = spawnSync(process.execPath, [bin, dirs.beforeDir, afterDir, ...args, ...sourceArgs], {
          cwd: dirs.root,
          encoding: 'utf8',
          timeout: 60_000,
        });
        assert.equal(result.status, expected, `${path.basename(bin)}: ${result.stderr || result.stdout}`);
        assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).reviewableCounts.dom, expected);
      }
    }
  } finally {
    rmTmp(dirs.root);
  }
});

for (const [name, style, screenshotRect] of [
  ['display:none', { display: 'none' }, [0, 2000, 1280, 80]],
  ['visibility:hidden', { visibility: 'hidden' }, [0, 2000, 1280, 80]],
  ['opacity:0', { opacity: '0' }, [0, 2000, 1280, 80]],
  ['zero width', {}, [0, 2000, 0, 80]],
  ['zero height', {}, [0, 2000, 1280, 0]],
]) {
  test(`expanded below-fold ${name} addition stays advisory in diff and report`, () => {
    const before = baseBoard();
    before.viewport = { width: 1280, height: 720, documentHeight: 720, screenshotHeight: 3000 };
    const after = structuredClone(before);
    after.elements['body > div.ghost:nth-child(2)'] = {
      tag: 'div',
      cls: 'ghost',
      rect: [0, 2000, 1280, 80],
      screenshotRect,
      style,
    };
    const { dirs, json } = fixture({ before, after });
    try {
      assert.equal(json.reviewableCounts.dom, 0);
      assert.equal(json.elevatedVisibleStructure ?? 0, 0);
      const jsonPath = path.join(dirs.root, 'diff.json');
      const result = spawnSync(
        process.execPath,
        [
          DIFF,
          dirs.beforeDir,
          dirs.afterDir,
          '--allow-unasserted',
          '--json',
          jsonPath,
          '--expected-before-sha',
          'a'.repeat(40),
          '--expected-after-sha',
          'b'.repeat(40),
        ],
        { cwd: dirs.root, encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(result.status, 0, `expected exit 0: ${result.stderr || result.stdout}`);
      const diff = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(diff.reviewableCounts.dom, 0);
      assert.equal(diff.elevatedVisibleStructure ?? 0, 0);
    } finally {
      rmTmp(dirs.root);
    }
  });
}

test('withElevatedVisibleStructureCounts adds to reviewableCounts.dom', () => {
  assert.deepEqual(withElevatedVisibleStructureCounts({ dom: 0, style: 2, state: 0 }, 3), {
    dom: 3,
    style: 2,
    state: 0,
  });
  assert.deepEqual(withElevatedVisibleStructureCounts({ dom: 1, style: 0, state: 0 }, 0), {
    dom: 1,
    style: 0,
    state: 0,
  });
});

test('collectElevatedVisibleStructure counts unique visible adds/removes across surfaces', () => {
  const dirs = tmpDirs();
  const before = baseBoard({
    [OK]: { tag: 'span', cls: 'ok', rect: [100, 16, 12, 12], style: { display: 'inline-block' } },
  });
  const after = baseBoard({
    [WARN]: { tag: 'i', cls: 'warn', rect: [100, 16, 12, 12], style: { display: 'inline-block' } },
  });
  writeCapture(dirs.beforeDir, 'access@1280', before, solidPng(400, 300));
  writeCapture(dirs.afterDir, 'access@1280', after, solidPng(400, 300, [80, 80, 80]));
  const { count, elevated } = collectElevatedVisibleStructure({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
  });
  assert.ok(count >= 1, `expected ≥1 elevated, got ${count}: ${JSON.stringify(elevated)}`);
  assert.ok(elevated.some((e) => e.change.change === 'added' || e.change.change === 'removed'));
  rmTmp(dirs.root);
});

test('added/removed element with identical screenshot pixels does not claim "renders identically"', () => {
  const dirs = tmpDirs();
  const png = solidPng(400, 200);
  const before = {
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: { display: 'block' } },
        'body > div:nth-child(1)': {
          tag: 'div',
          cls: 'collapsed-child',
          rect: [10, 10, 200, 40],
          style: { display: 'block', opacity: '1' },
        },
      },
    }),
    viewport: { width: 400, height: 200 },
  };
  const after = {
    ...makeMap({
      elements: {
        body: { tag: 'body', rect: [0, 0, 400, 200], style: { display: 'block' } },
      },
    }),
    viewport: { width: 400, height: 200 },
  };
  writeCapture(dirs.beforeDir, 'landing@1280', before, png);
  writeCapture(dirs.afterDir, 'landing@1280', after, png);
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: path.join(dirs.root, 'out'),
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.ok(md.includes('element removed'));
  assert.ok(!md.includes('renders identically before and after'));
  assert.ok(
    md.includes('no distinct before/after crop') ||
      md.includes('No distinct before/after crop') ||
      md.includes('element itself was removed') ||
      md.includes('crop unavailable'),
    'expected accurate wording for missing structure crop',
  );
  rmTmp(dirs.root);
});
