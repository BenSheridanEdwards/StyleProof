// Visible added/removed elements on paired surfaces elevate to reviewable
// (STYLE_REVIEW_REQUIRED). Invisible / zero-size DOM churn and pure text stay advisory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
