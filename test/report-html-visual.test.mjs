import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/report.js';
import { renderReportHtml } from '../dist/report/html.js';
import { encodeSectionMeta } from '../dist/report/section-meta.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const title = (i) => `body > section:nth-child(1) > h2:nth-child(${i})`;

function page() {
  const png = new PNG({ width: 800, height: 400 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([240, 240, 240, 255], i);
  return PNG.sync.write(png);
}

function fixture(t, options = {}) {
  const root = mkTmp('styleproof-html-visual-');
  t.after(() => rmTmp(root));
  for (const [dir, color] of [
    ['before', 'rgb(30, 60, 120)'],
    ['after', 'rgb(150, 30, 60)'],
  ]) {
    const elements = {};
    for (const i of [1, 2]) {
      elements[title(i)] = {
        tag: 'h2',
        cls: 'card-title',
        rect: [20 + (i - 1) * 300, 40, 200, 30],
        text: `Item ${i}`,
        style: { color, 'caret-color': color },
      };
    }
    writeCapture(path.join(root, dir), 'shop@800', makeMap({ elements }), page());
  }
  const result = generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
    ...options,
    layout: 'visual-first',
  });
  return {
    html: fs.readFileSync(path.join(root, 'out', 'report.html'), 'utf8'),
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
  };
}

test('report.html offers Auto, Light and Dark over light and dark colour tokens', (t) => {
  const { html } = fixture(t);
  assert.match(html, /:root \{ color-scheme: light; --bg: /);
  assert.match(
    html,
    /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ color-scheme: dark;/,
  );
  assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark;/);
  for (const theme of ['auto', 'light', 'dark'])
    assert.match(html, new RegExp(`<button type="button" data-set-theme="${theme}" aria-pressed="false">`));
  assert.match(html, /try \{ saved = localStorage\.getItem\('styleproof-report-theme'\); \} catch \{\}/);
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('theme'\)/);
});

test('an unbound report keeps the header, theme switch and jump links, and opens with the warning (RV19-01)', (t) => {
  // The note `styleproof-report` writes above the title when no --expected-*-sha was given (RV18-06).
  const note =
    '> ⚠ UNVERIFIED DIAGNOSTIC: source binding was not verified. This report did not check that its captures ' +
    'came from the base and head commits; run it with `--expected-before-sha` and `--expected-after-sha` to check them.';
  const outDir = path.join(import.meta.dirname, '..', 'docs', 'demo');
  const demo = fixture(t).md.replace(/⚠️ \*\*Product-state identity unproven[^\n]*\n\n/, '');
  for (const [name, md] of [
    ['bound', demo],
    ['unbound', `${note}\n\n${demo}`],
  ]) {
    const html = renderReportHtml(md, { outDir });
    assert.match(html, /<header class="top"><div class="topbar"><h1>StyleProof report<\/h1>/, name);
    for (const theme of ['auto', 'light', 'dark']) assert.match(html, new RegExp(`data-set-theme="${theme}"`), name);
    assert.match(html, /<nav class="toc" aria-label="Changes"><a href="#/, name);
    assert.match(html, /<p class="summary"><strong>\d+ changes? to review<\/strong>/, name);
  }
  const unbound = renderReportHtml(`${note}\n\n${demo}`, { outDir });
  const warning = unbound.indexOf('UNVERIFIED DIAGNOSTIC: source binding was not verified.');
  assert.ok(warning > 0, 'the warning is on the page');
  assert.match(unbound, /run it with <code>--expected-before-sha<\/code> and <code>--expected-after-sha<\/code>/);
  assert.ok(warning < unbound.indexOf('<header class="top">'), 'the page opens with the warning, as report.md does');
});

test('every no-change verdict opening is the header summary, not a note under a title-only header (RV19-07)', () => {
  const verdicts = [
    ['✓ No reviewable computed-style changes.', /✓ No reviewable computed-style changes\./],
    [
      '✗ **Reach gate** — 1 changed CSS rule(s) or reach evidence gap(s) were never matched in a captured state (see **Changed but never matched**). Not a clean no-change: they hold the check.',
      /✗ <strong>Reach gate<\/strong> — 1 changed CSS rule/,
    ],
    ['🧱 **1 visible element was added or removed** — it needs review.', /🧱 <strong>1 visible element was added/],
    [
      '⚠️ **1 surface failed to capture on the base:** `home@1280`. The rest of the base was captured; repair that surface on that commit and capture it again.',
      /⚠️ <strong>1 surface failed to capture on the base:<\/strong>/,
    ],
    [
      '⚠ **Report consistency failure:** the certification differ found **1 DOM** difference(s).',
      /⚠ <strong>Report consistency failure:<\/strong>/,
    ],
  ];
  for (const [line, shown] of verdicts) {
    const html = renderReportHtml(`## 🗺️ StyleProof report\n\n${line}\n\n## Changed but never matched\n\nx`, {
      outDir: process.env.TMPDIR ?? '.',
      layout: 'visual-first',
    });
    const header = html.match(/<header class="top">[\s\S]*?<\/header>/)?.[0] ?? '';
    assert.match(header, /<p class="summary">/, line);
    assert.match(header, shown, line);
  }
});

test('the header summary is only the opening verdict paragraph; report.md order is kept (RV20-01)', async (t) => {
  const { pairFixture, sceneMap } = await import('./helpers.mjs');
  const B = 'body > div:nth-child(1) > button:nth-child(1)';
  // A live region on both sides and a subtree volatile on head only: the verdict block is empty, so
  // report.md opens with the live paragraph, then the volatile lead and its region list.
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: { ...sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 }), volatile: ['body > footer'] },
    after: { ...sceneMap({ buttonColor: 'rgb(255, 0, 0)', bodyHeight: 800 }), volatile: ['body > footer', B] },
  });
  t.after(() => rmTmp(root));
  const md = fs.readFileSync(
    generateStyleMapReport({ beforeDir, afterDir, outDir, layout: 'visual-first' }).reportMdPath,
    'utf8',
  );
  const html = renderReportHtml(md.replace(/\n$/, ''), { outDir });
  const header = html.match(/<header class="top">[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.doesNotMatch(header, /newly volatile|live region/);
  const live = html.indexOf('live region(s) auto-excluded');
  const lead = html.indexOf('newly volatile on head');
  const list = html.indexOf('button:nth-child(1)', lead);
  assert.ok(
    html.indexOf('</header>') < live && live < lead && lead < list,
    'live paragraph, then the lead, then its list',
  );

  // A volatile lead with its list is one block, never split by the header.
  const alone = [
    '## 🗺️ StyleProof report',
    '',
    '✗ **1 subtree(s) newly volatile on head** — still mutating at capture settle on the head.',
    '- `home@1280` · `body > main`',
    '',
    encodeSectionMeta({ v: 1, id: 'volatile', paths: [], more: 0, pairs: [], where: [], pages: [] }),
  ].join('\n');
  assert.doesNotMatch(
    renderReportHtml(alone, { outDir }).match(/<header class="top">[\s\S]*?<\/header>/)[0],
    /volatile/,
  );
});

test('a cannot-certify line that opens the report is the header summary; a later ✗ block stays below it (RV20-01)', () => {
  const outDir = process.env.TMPDIR ?? '.';
  const blocked = [
    '## 🗺️ StyleProof report',
    '',
    '⛔ **This compare cannot certify:** 1 paired capture(s) are not proven to show the same product state on both sides.',
    '',
    '✗ **1 subtree(s) newly volatile on head** — still mutating at capture settle on the head.',
    '- `home@1280` · `body > main`',
    '',
    encodeSectionMeta({ v: 1, id: 'volatile', paths: [], more: 0, pairs: [], where: [], pages: [] }),
  ].join('\n');
  const page = renderReportHtml(blocked, { outDir });
  const top = page.match(/<header class="top">[\s\S]*?<\/header>/)[0];
  assert.match(top, /<p class="summary">⛔ <strong>This compare cannot certify:<\/strong>/);
  assert.doesNotMatch(top, /newly volatile/);
  assert.ok(page.indexOf('newly volatile') > page.indexOf('</header>'));
});

test('default no-change report with declared product state keeps legacy HTML chrome', async (t) => {
  const { pairFixture, sceneMap } = await import('./helpers.mjs');
  const map = sceneMap({ buttonColor: 'rgb(0, 0, 0)', bodyHeight: 800 });
  map.metadata = { ...map.metadata, productState: { id: 'home', revision: 'fixture-v1' } };
  const { beforeDir, afterDir, outDir, root } = pairFixture({
    surface: 'home@1280',
    before: map,
    after: map,
  });
  t.after(() => rmTmp(root));
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(markdown, /✓ No reviewable computed-style changes/);
  assert.doesNotMatch(markdown, /identity unproven/);
  const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
  assert.doesNotMatch(html, /<header class="top">/);
  assert.doesNotMatch(html, /data-set-theme=/);
});

test('visual-first comments carry clean pairs, Where geometry and budgeted whole pages', (t) => {
  const { md } = fixture(t);
  const line = md.split('\n').find((line) => line.startsWith('<!-- styleproof-section '));
  const meta = JSON.parse(decodeURIComponent(line.slice('<!-- styleproof-section '.length, -4)));
  assert.equal(meta.pairs.length, 1);
  assert.ok(meta.pairs[0].width > 0);
  assert.equal(meta.where[0].boxes.length, 2);
  assert.equal(meta.pages.length, 1);
  assert.match(meta.pages[0].after, /-head\.png$/);
  const fallback = fixture(t, { maxCropFiles: 3 }).md;
  const fallbackLine = fallback.split('\n').find((line) => line.startsWith('<!-- styleproof-section '));
  const limited = JSON.parse(decodeURIComponent(fallbackLine.slice('<!-- styleproof-section '.length, -4)));
  assert.equal(limited.pages.length, 0);
  assert.ok(limited.where.length > 0);
});
