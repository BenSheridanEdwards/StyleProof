// #766 A-narrowed: Global chrome navigable additions elevate to reviewable
// (STYLE_REVIEW_REQUIRED / styleproof-diff exit 1). Non-navigable chrome and
// per-surface-only structure stay advisory. Soft-pass HOLD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateStyleMapReport } from '../dist/report.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import { isInventoryClassElement, collectElevatedNavigableChromeAdds } from '../dist/chrome-navigable-gate.js';
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

const SURFACES = ['home@1280', 'settings@1280', 'account@1280'];
const SIDEBAR = 'body > nav:nth-child(1)';
const link = (n) => `${SIDEBAR} > a:nth-child(${n})`;

function sidebarMap(links, extra = {}) {
  const elements = {
    body: { tag: 'body', rect: [0, 0, 400, 300] },
    [SIDEBAR]: { tag: 'nav', cls: 'sidebar', rect: [0, 0, 80, 300] },
    'body > main:nth-child(2)': { tag: 'main', cls: 'page', rect: [80, 0, 320, 300] },
    ...extra,
  };
  for (let n = 1; n <= links; n++) {
    elements[link(n)] = { tag: 'a', cls: 'side-link', rect: [0, (n - 1) * 40, 80, 40], text: `Item ${n}` };
  }
  return makeMap({ elements });
}

function fixture({ before, after, includeContent = true }) {
  const dirs = tmpDirs();
  for (const surface of SURFACES) {
    writeCapture(dirs.beforeDir, surface, before(surface), solidPng(400, 300));
    writeCapture(dirs.afterDir, surface, after(surface), solidPng(400, 300, [150, 150, 150]));
  }
  const result = generateStyleMapReport({ ...dirs, includeContent });
  return {
    dirs,
    result,
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

test('isInventoryClassElement: anchors and nav-context buttons match; decorative spans do not', () => {
  assert.equal(isInventoryClassElement({ tag: 'a', cls: 'side-link' }, link(4)), true);
  assert.equal(isInventoryClassElement({ tag: 'button', cls: 'nav-tab' }, 'body > div > button:nth-child(1)'), true);
  assert.equal(isInventoryClassElement({ tag: 'button', cls: 'icon' }, `${SIDEBAR} > button:nth-child(1)`), true);
  assert.equal(isInventoryClassElement({ tag: 'span', cls: 'badge' }, `${SIDEBAR} > span:nth-child(1)`), false);
  assert.equal(isInventoryClassElement({ tag: 'div', cls: 'decor' }, `${SIDEBAR} > div:nth-child(1)`), false);
});

test('#766: Global chrome navigable link add elevates reviewableCounts and needs-review copy', () => {
  const { dirs, result, md, json } = fixture({
    before: () => sidebarMap(3),
    after: () => sidebarMap(4),
  });
  assert.match(md, /Global chrome/);
  assert.match(md, /needs review|reviewable|gates the check|STYLE_REVIEW_REQUIRED/i);
  // Elevated navigable chrome must NOT keep the advisory-only verdict disclaimer.
  assert.doesNotMatch(md, /🧱 \*\*1 global chrome[\s\S]{0,200}DOM structure does not change this check's verdict/);
  assert.doesNotMatch(md, /## 🧱 Global chrome[\s\S]{0,500}does not change the check's verdict/);
  assert.ok(
    (json.reviewableCounts?.dom ?? 0) >= 1 || json.comparison?.hasReviewableEvidence === true,
    'elevated chrome navigable add must enter reviewable evidence',
  );
  assert.equal(json.content?.elevatedNavigableChromeAdds ?? json.elevatedNavigableChromeAdds ?? 0, 1);
  // Approve clears STYLE_REVIEW_REQUIRED — never invent CERTIFICATION_FAILED from this alone.
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
  void result;
});

test('#766: per-surface-only structure add is not Global chrome (navigable chrome count stays 0)', () => {
  const note = {
    'body > main:nth-child(2) > p:nth-child(1)': {
      tag: 'p',
      cls: 'note',
      text: 'Only here',
      rect: [80, 10, 200, 24],
      style: { display: 'block' },
    },
  };
  const { dirs, json, md } = fixture({
    before: () => sidebarMap(3),
    after: (surface) => sidebarMap(3, surface === 'account@1280' ? note : {}),
  });
  assert.doesNotMatch(md, /Global chrome/);
  assert.equal(json.content?.elevatedNavigableChromeAdds ?? json.elevatedNavigableChromeAdds ?? 0, 0);
  // Visible per-surface add/remove now elevates (separate from #766 chrome).
  assert.ok((json.reviewableCounts?.dom ?? 0) >= 1);
  assert.equal(json.comparison?.hasReviewableEvidence ?? false, true);
  rmTmp(dirs.root);
});

test('#766: non-navigable Global chrome decoration is not a navigable-chrome elevation', () => {
  const decor = (n) => `${SIDEBAR} > span.badge:nth-child(${n})`;
  function mapWithBadges(count) {
    const elements = {
      body: { tag: 'body', rect: [0, 0, 400, 300] },
      [SIDEBAR]: { tag: 'nav', cls: 'sidebar', rect: [0, 0, 80, 300] },
      'body > main:nth-child(2)': { tag: 'main', cls: 'page', rect: [80, 0, 320, 300] },
      [link(1)]: { tag: 'a', cls: 'side-link', rect: [0, 0, 80, 40], text: 'Home' },
    };
    for (let n = 1; n <= count; n++) {
      elements[decor(n + 1)] = {
        tag: 'span',
        cls: 'badge',
        rect: [0, 40 * n, 80, 20],
        text: `${n}`,
        style: { display: 'inline-block' },
      };
    }
    return makeMap({ elements });
  }
  const { dirs, json, md } = fixture({
    before: () => mapWithBadges(1),
    after: () => mapWithBadges(2),
  });
  assert.match(md, /Global chrome/);
  // Still not a #766 navigable elevation — but a visible badge add now elevates via
  // the visible-structure gate.
  assert.equal(json.content?.elevatedNavigableChromeAdds ?? json.elevatedNavigableChromeAdds ?? 0, 0);
  assert.ok((json.reviewableCounts?.dom ?? 0) >= 1);
  assert.match(md, /reviewable|needs review|STYLE_REVIEW_REQUIRED/i);
  rmTmp(dirs.root);
});

test('#766: styleproof-diff exits 1 for Global chrome navigable link add (certify path)', () => {
  const dirs = tmpDirs();
  try {
    for (const surface of SURFACES) {
      writeCapture(dirs.beforeDir, surface, sidebarMap(3), solidPng(400, 300));
      writeCapture(dirs.afterDir, surface, sidebarMap(4), solidPng(400, 300, [150, 150, 150]));
    }
    writePairManifests(dirs);
    const res = spawnSync(
      process.execPath,
      [DIFF, dirs.beforeDir, dirs.afterDir, '--json', path.join(dirs.root, 'out.json')],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, STYLEPROOF_PRODUCT_STATE: '' },
      },
    );
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const out = JSON.parse(fs.readFileSync(path.join(dirs.root, 'out.json'), 'utf8'));
    assert.ok((out.reviewableCounts?.dom ?? 0) >= 1 || (out.elevatedNavigableChromeAdds ?? 0) >= 1);
    assert.match(res.stdout + res.stderr, /chrome|navigable|review/i);
  } finally {
    rmTmp(dirs.root);
  }
});

test('#766: collectElevatedNavigableChromeAdds fail-closes multi-base navigable adds not chrome-collapsed', () => {
  // Addition on 2 of 3 surfaces that host the sidebar — chromeHosted skips (not every host),
  // but Spec fail-closes shared navigable adds toward reviewable under A.
  const dirs = tmpDirs();
  try {
    for (const surface of SURFACES) {
      writeCapture(dirs.beforeDir, surface, sidebarMap(3), solidPng(400, 300));
      const links = surface === 'home@1280' ? 3 : 4;
      writeCapture(dirs.afterDir, surface, sidebarMap(links), solidPng(400, 300, [150, 150, 150]));
    }
    const elevated = collectElevatedNavigableChromeAdds({
      beforeDir: dirs.beforeDir,
      afterDir: dirs.afterDir,
    });
    assert.ok(elevated.count >= 1, 'multi-base navigable add must elevate fail-closed');
  } finally {
    rmTmp(dirs.root);
  }
});
