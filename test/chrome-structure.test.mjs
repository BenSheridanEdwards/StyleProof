// #754: an element added identically on every captured surface base (a new link in a
// persistent sidebar nav) was filed as one advisory "element added" entry PER SURFACE, so
// the one visible frame change was scattered across the content list. It is now listed
// once under Global chrome; a one-surface addition stays in the advisory list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

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

function fixture({ before, after }) {
  const dirs = tmpDirs();
  for (const surface of SURFACES) {
    writeCapture(dirs.beforeDir, surface, before(surface), solidPng(400, 300));
    writeCapture(dirs.afterDir, surface, after(surface), solidPng(400, 300, [150, 150, 150]));
  }
  const result = generateStyleMapReport({ ...dirs, includeContent: true });
  return { dirs, result, md: fs.readFileSync(result.reportMdPath, 'utf8') };
}

const occurrences = (text, needle) => text.split(needle).length - 1;

test('#754: a link added to the sidebar on every surface is ONE Global chrome entry, not N advisory entries', () => {
  const note = { 'body > main:nth-child(2) > p:nth-child(1)': { tag: 'p', cls: 'note', text: 'Only here' } };
  const { dirs, result, md } = fixture({
    before: () => sidebarMap(3),
    after: (surface) => sidebarMap(4, surface === 'account@1280' ? note : {}),
  });

  assert.match(md, /## 🧱 Global chrome — 1 element change on every surface base that renders its container/);
  assert.match(
    md,
    /\*\*`a\.side-link`\*\* — element added on all 3 surface bases that render its container \(3 captures\)/,
  );
  assert.equal(occurrences(md, '**`a.side-link`**'), 1, 'the chrome addition is listed exactly once');
  // The one-surface addition keeps its advisory per-surface entry.
  assert.match(md, /### `account@1280` · 1 content\/structure change\(s\)[\s\S]*\*\*`p\.note`\*\*/);
  assert.doesNotMatch(md, /### `home@1280` · \d+ content\/structure change/);
  // Visibility only: the computed-style verdict is unchanged.
  assert.equal(result.changedSurfaces, 0);
  assert.equal(result.contentChanges, 2, 'one chrome entry plus one advisory entry');
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.deepEqual(json.content, { evaluated: true, changes: 2, advisory: true, globalChrome: 1 });
  rmTmp(dirs.root);
});

test('#754: a sidebar link removed on every surface is ONE Global chrome entry', () => {
  const { dirs, md } = fixture({ before: () => sidebarMap(4), after: () => sidebarMap(3) });
  assert.match(
    md,
    /\*\*`a\.side-link`\*\* — element removed on all 3 surface bases that render its container \(3 captures\)/,
  );
  assert.equal(occurrences(md, '**`a.side-link`**'), 1);
  rmTmp(dirs.root);
});

test('#754: an addition on only some surfaces that host the sidebar stays advisory per surface', () => {
  const { dirs, result, md } = fixture({
    before: () => sidebarMap(3),
    after: (surface) => sidebarMap(surface === 'home@1280' ? 3 : 4),
  });
  assert.doesNotMatch(md, /Global chrome/);
  assert.equal(occurrences(md, '**`a.side-link`**'), 2, 'one advisory entry per surface that gained it');
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.deepEqual(json.content, { evaluated: true, changes: 2, advisory: true });
  rmTmp(dirs.root);
});

// #767 / #754 residual: head-only co-host must not expand the content hosting universe.
// Unpaired tall-fullpage hosts the same sidebar container as paired surfaces; if
// chromeHosted counts that base, every(hostingBase ∈ changedBases) fails and Global
// chrome collapse is skipped (3× advisory). Content chrome must host only over paired surfaces.
test('#767: head-only co-host of the same container still collapses to ONE Global chrome entry', () => {
  const dirs = tmpDirs();
  const HEAD_ONLY = 'tall-fullpage@1280';
  for (const surface of SURFACES) {
    writeCapture(dirs.beforeDir, surface, sidebarMap(3), solidPng(400, 300));
    writeCapture(dirs.afterDir, surface, sidebarMap(4), solidPng(400, 300, [150, 150, 150]));
  }
  // Unpaired head surface also hosts the sidebar (same container path) but is not content-comparable.
  writeCapture(dirs.afterDir, HEAD_ONLY, sidebarMap(4), solidPng(400, 300, [150, 150, 150]));

  const result = generateStyleMapReport({ ...dirs, includeContent: true });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');

  assert.match(md, /## 🧱 Global chrome — 1 element change on every surface base that renders its container/);
  assert.match(
    md,
    /\*\*`a\.side-link`\*\* — element added on all 3 surface bases that render its container \(3 captures\)/,
  );
  assert.equal(occurrences(md, '**`a.side-link`**'), 1, 'chrome addition listed once despite head-only co-host');
  assert.doesNotMatch(md, /### `home@1280` · \d+ content\/structure change/);
  const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  assert.equal(json.content.globalChrome, 1);
  rmTmp(dirs.root);
});
