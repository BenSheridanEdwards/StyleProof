import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderReportHtml } from '../dist/report/html.js';
import { writeReportArtifacts } from '../dist/report/sections.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('report.html covers the report Markdown grammar (#698)', () => {
  const html = renderReportHtml(
    [
      '## 🗺️ StyleProof report',
      '',
      '**3 computed-style difference(s)** across 1 distinct change(s).',
      '_**Surface base** = one product UI state._',
      '',
      '### `home@900` · 1 element restyled <!-- styleproof-new -->',
      '',
      '`color` `#9ca3af` → `#2563eb`',
      '',
      '![before ◀ │ ▶ after](crops/home-900-2-composite.png)',
      '',
      '<sub>◀ before  ·  after ▶ — home @ 900</sub>',
      '',
      '- **`span.caret`** — gray → blue',
      '',
      '<details>',
      '<summary>Show the property change</summary>',
      '',
      '| Property | Before | After |',
      '| --- | --- | --- |',
      '| `color` | `#9ca3af` | `#2563eb` |',
      '',
      '</details>',
      '',
      '---',
      '',
      '> [!NOTE]',
      '> Advisory content.',
      '',
      `[View the run](https://github.com/${'acme'}/app/actions/runs/1)`,
      '',
      '<!-- styleproof-receipt head-sha:aaa run-id:1 run-attempt:1 -->',
    ].join('\n'),
  );

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<h2>🗺️ StyleProof report<\/h2>/);
  assert.match(html, /<strong>3 computed-style difference\(s\)<\/strong>/);
  assert.match(html, /<em><strong>Surface base<\/strong> = one product UI state\.<\/em>/);
  assert.match(html, /<h3><code>home@900<\/code> · 1 element restyled <!-- styleproof-new --><\/h3>/);
  assert.match(html, /<code>#9ca3af<\/code> → <code>#2563eb<\/code>/);
  assert.match(html, /<img src="crops\/home-900-2-composite\.png" alt="before ◀ │ ▶ after"/);
  assert.match(html, /<sub>◀ before {2}· {2}after ▶ — home @ 900<\/sub>/);
  assert.match(html, /<ul><li><strong><code>span\.caret<\/code><\/strong> — gray → blue<\/li><\/ul>/);
  assert.match(html, /<details>/);
  assert.match(html, /<summary>Show the property change<\/summary>/);
  assert.match(html, /<th>Property<\/th><th>Before<\/th><th>After<\/th>/);
  assert.match(html, /<td><code>color<\/code><\/td>/);
  assert.doesNotMatch(html, /<td>---<\/td>/, 'table separator row must not render as cells');
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote>\[!NOTE\]<br>Advisory content\.<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/github\.com\/acme\/app\/actions\/runs\/1">View the run<\/a>/);
  assert.match(html, /<!-- styleproof-receipt head-sha:aaa run-id:1 run-attempt:1 -->/);
});

test('report.html never interprets untrusted text as markup (#698)', () => {
  const html = renderReportHtml(
    [
      'A selector like `div > span` and `a < b` stays text.',
      '',
      'Identifiers like STYLE_REVIEW_REQUIRED and snake_case names are not italic.',
      '',
      '`**not bold**` and `_not italic_` inside code stay literal.',
      '',
      '**bold** is bold and _this_ is italic.',
    ].join('\n'),
  );
  assert.match(html, /<code>div &gt; span<\/code> and <code>a &lt; b<\/code>/);
  assert.match(html, /STYLE_REVIEW_REQUIRED and snake_case names are not italic\./);
  assert.doesNotMatch(html, /<em>REVIEW<\/em>/);
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.match(html, /<code>_not italic_<\/code>/);
  assert.match(html, /<strong>bold<\/strong> is bold and <em>this<\/em> is italic\./);
});

test('writeReportArtifacts emits report.html beside report.md and report.json (#698)', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-report-html-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const paths = writeReportArtifacts({
    outDir,
    md: ['## report', '', 'one `change` here'],
    gateMode: 'certify',
    counts: {},
    comparison: {},
    comparability: {},
    reportConsistency: {},
    baselineFailures: [],
    content: { evaluated: false, changes: 0, advisory: true },
    surfaces: [],
    confidence: {},
  });
  assert.equal(paths.reportHtmlPath, path.join(outDir, 'report.html'));
  assert.ok(fs.existsSync(paths.reportHtmlPath));
  const html = fs.readFileSync(paths.reportHtmlPath, 'utf8');
  assert.match(html, /<h2>report<\/h2>/);
  assert.match(html, /one <code>change<\/code> here/);
});

test('the committed demo report renders completely (#698)', () => {
  const md = fs.readFileSync(path.join(here, '..', 'docs/demo/report.md'), 'utf8');
  const html = renderReportHtml(md);
  assert.match(html, /<h2>🗺️ StyleProof report<\/h2>/);
  for (const crop of fs.readdirSync(path.join(here, '..', 'docs/demo/crops')).filter((f) => f.endsWith('.png'))) {
    assert.ok(
      html.includes(`src="crops/${crop}"`),
      `every demo crop must resolve relative to report.html — missing crops/${crop}`,
    );
  }
  assert.doesNotMatch(html, /!\[/, 'no image syntax may survive unrendered');
  assert.doesNotMatch(html, /&lt;!--/, 'comments must pass through as comments, not visible text');
});

test('report.html keeps an author-controlled comment inside a double-fenced value inert', async () => {
  const { propertyGlanceLine } = await import('../dist/report/markdown.js');
  const after = '"`<!--><img src=x onerror=alert(1)>-->"';
  const md = propertyGlanceLine([
    { kind: 'style', path: 'p', props: [{ prop: 'font-family', before: 'serif', after }] },
  ]);
  const html = renderReportHtml(md);
  assert.doesNotMatch(html, /<img src=x/, 'a CSS value must never become live markup');
  assert.doesNotMatch(html, /<!-->/);
  assert.match(html, /<code>&quot;`&lt;!--&gt;&lt;img src=x onerror=alert\(1\)&gt;--&gt;&quot;<\/code>/);
  // A single-fenced value holding a comment keeps its text instead of a stray placeholder.
  assert.match(renderReportHtml('`a<!-- x -->b`'), /<code>a&lt;!-- x --&gt;b<\/code>/);
  assert.match(renderReportHtml('`` `x` ``'), /<code>`x`<\/code>/);
});

test('report.html escapes map-supplied text on caption, summary, and comment lines', async () => {
  const { formatSurfaceWithContext } = await import('../dist/report/shared.js');
  const map = { metadata: { variantKind: 'popup', variantKey: '<img src=x onerror=alert(1)>' } };
  const html = renderReportHtml(
    [
      `<sub>before · ${formatSurfaceWithContext('home@1280', map)}</sub>`,
      '',
      '<summary><img src=x onerror=alert(1)></summary>',
      '',
      '<!-- not ours --><img src=x onerror=alert(1)>',
      '',
      '<subversive><img src=x onerror=alert(1)>',
    ].join('\n'),
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<sub>before · home @ 1280 · popup <code>&lt;img src=x onerror=alert\(1\)&gt;<\/code><\/sub>/);
  assert.match(html, /<summary>&lt;img src=x onerror=alert\(1\)&gt;<\/summary>/);
});
