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

test('a change section is a card: name, line, SVG Where map, clean pair, collapsed CSS, paths and whole page', (t) => {
  const { html } = fixture(t);
  assert.match(html, /<header class="top"><div class="topbar"><h1>StyleProof report<\/h1>/);
  assert.match(
    html,
    /<p class="summary"><strong>1 change to review<\/strong> on <code>shop<\/code> at 800px wide: 2 elements\.<\/p>/,
  );
  assert.match(html, /<nav class="toc" aria-label="Changes"><a href="#card-titles">Card titles<\/a><\/nav>/);
  assert.match(html, /<section class="change" id="card-titles">/);
  assert.match(
    html,
    /<h2>Card titles<\/h2><p class="line">Both card titles \(Item 1, Item 2\) change text colour from dark indigo to dark red\.<\/p>/,
  );
  // The only boxes are on the map: an SVG ring over the inlined whole head page.
  assert.match(
    html,
    /<svg viewBox="0 \d+ 800 \d+" role="img" aria-label="Where on shop @ 800: 2 card titles highlighted" class="map"/,
  );
  assert.match(html, /<image id="sp-page-\d+" href="data:image\/png;base64,[^"]+" width="800" height="400"\/>/);
  assert.equal(html.match(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" rx="6" class="ring"\/>/g)?.length, 2);
  assert.match(
    html,
    /<span class="side before">Before<\/span><\/figcaption><img class="shot before" src="data:image\/png;base64,[^"]+" width="\d+" height="\d+" alt="Before: the first card title">/,
  );
  assert.match(
    html,
    /<span class="side after">After<\/span><\/figcaption><img class="shot after" src="data:image\/png;base64,/,
  );
  assert.match(html, /<details class="more css"><summary>Show the CSS<\/summary>/);
  assert.doesNotMatch(html, /<details class="more css" open/);
  assert.match(html, /<p class="selector"><code>h2\.card-title<\/code> · 2 elements restyled<\/p>/);
  assert.match(html, /<td><i class="sw" style="background:#1e3c78"><\/i><code>#1e3c78<\/code><\/td>/);
  assert.match(html, /<tr class="follower"><td><code>caret-color<\/code> \(follows <code>color<\/code>\)/);
  assert.match(
    html,
    /<details class="paths"><summary>Element paths<\/summary><ol><li><code>body &gt; section:nth-child\(1\) &gt; h2:nth-child\(1\)<\/code><\/li>/,
  );
  assert.match(html, /<details class="more pages"><summary>Show the whole page<\/summary>/);
  assert.match(html, /<span class="state">whole page<\/span>/);
  assert.match(
    html,
    /<h2 id="coverage-title">What was captured<\/h2><ul><li>The <strong>shop<\/strong> page at 800px wide/,
  );
  assert.match(html, /<footer>/);
  // The GitHub heading and the hidden data are not repeated as page text.
  assert.doesNotMatch(html, /<h2>Changes<\/h2>|styleproof-section %7B|Where on the page:/);
});

test('without the whole page the Where map falls back to the overview PNG', (t) => {
  // Two crops plus the map use three files; the whole pages do not fit after them.
  const { html, md } = fixture(t, { maxCropFiles: 3 });
  assert.match(md, /-where\.png/);
  assert.doesNotMatch(html, /<svg /);
  assert.match(
    html,
    /<img class="map" src="data:image\/png;base64,[^"]+" alt="Where on shop @ 800: 2 card titles highlighted">/,
  );
  assert.doesNotMatch(html, /Show the whole page/);
});

test('section data from report.md is escaped, and a forged image path is never loaded', () => {
  const meta = {
    v: 1,
    id: 'x" onclick="alert(1)',
    paths: ['<script>alert(1)</script>'],
    more: 0,
    pairs: [{ state: 'rest', before: 'javascript:alert(1)', after: 'crops/a.png', w: 10, h: 10, what: '"><script>' }],
    where: [],
    pages: [],
  };
  const html = renderReportHtml(
    [
      '## 🗺️ StyleProof report',
      '',
      '### Name',
      '',
      encodeSectionMeta(meta),
      '',
      'A line.',
      '',
      '<details>',
      '<summary>Show the CSS</summary>',
      '',
      '`p` · 1 element restyled',
      '',
      '</details>',
      '',
      '<!-- styleproof-section-end -->',
    ].join('\n'),
  );
  assert.equal(html.match(/<script\b/g)?.length, 1, 'only the theme script');
  assert.doesNotMatch(html, /javascript:alert|id="x" onclick/);
  assert.match(html, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  assert.match(html, /alt="After: &quot;&gt;&lt;script&gt;"/);
});

test('a budget too small for the full design still keeps every word in a plain page', () => {
  const root = mkTmp('styleproof-html-compact-');
  try {
    const md = '## 🗺️ StyleProof report\n\n**1 change to review** on `home` at 900px wide: 1 element.\n';
    const full = renderReportHtml(md, { outDir: root, maxBytes: 2_000_000 });
    const plain = renderReportHtml(md, { outDir: root, maxBytes: 2_500 });
    assert.match(full, /data-set-theme/);
    assert.ok(Buffer.byteLength(plain) <= 2_500);
    assert.doesNotMatch(plain, /<script\b/);
    assert.match(plain, /1 change to review<\/strong> on <code>home<\/code>/);
  } finally {
    rmTmp(root);
  }
});

test('each whole page is inlined once, however many Where maps draw on it (RV2-14)', (t) => {
  const root = mkTmp('styleproof-html-once-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const color = side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)';
    const png = new PNG({ width: 1280, height: 900 });
    png.data.fill(235);
    const elements = {};
    for (const [i, cls] of ['title', 'price', 'note'].entries()) {
      elements[`body > p:nth-child(${i + 1})`] = { tag: 'p', cls, rect: [20, 40 + i * 250, 300, 40], style: { color } };
    }
    writeCapture(path.join(root, side), 'home@1280', makeMap({ elements }), PNG.sync.write(png));
  }
  const outDir = path.join(root, 'report');
  const result = generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir,
  });
  const html = renderReportHtml(fs.readFileSync(result.reportMdPath, 'utf8'), { outDir });
  const maps = html.match(/<svg [^>]*class="map"/g) ?? [];
  assert.equal(maps.length, 3, 'three sections, three SVG maps');
  const head = fs
    .readFileSync(path.join(outDir, 'crops', 'home-1280-page-head.png'))
    .toString('base64')
    .slice(0, 200);
  const inMaps = [...html.matchAll(/<svg [^>]*class="map"[\s\S]*?<\/svg>/g)].filter((m) => m[0].includes(head)).length;
  assert.equal(inMaps, 1, 'the head page is inlined in one map; the others reuse it');
  assert.equal((html.match(/<use href="#sp-page-\d+"\/>/g) ?? []).length, 2);
});
