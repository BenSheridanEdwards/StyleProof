import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderArtifactHtml, renderReportHtml } from '../dist/report/html.js';
import { writeReportArtifacts } from '../dist/report/sections.js';
import { createCropBudget } from '../dist/report/crop-budget.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('report.html covers the report Markdown grammar (#698)', () => {
  const html = renderReportHtml(
    [
      '## 🗺️ StyleProof report',
      '',
      '**1 change needs review**',
      '',
      '**1 distinct change** (3 computed-style difference(s)) in 1 changed surface base with an existing baseline.',
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
  assert.match(html, /<strong>1 change needs review<\/strong>/);
  assert.match(
    html,
    /<strong>1 distinct change<\/strong> \(3 computed-style difference\(s\)\) in 1 changed surface base with an existing baseline\./,
  );
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

test('report.html renders trailing paragraph breaks between property glance lines', () => {
  const html = renderReportHtml(
    ['`color` `#1e3c78` → `#961e3c`<br>', '`border-color` `#1e3c78` → `#961e3c`'].join('\n'),
  );
  assert.match(
    html,
    /<p><code>color<\/code> <code>#1e3c78<\/code> → <code>#961e3c<\/code><br>\s*<code>border-color<\/code> <code>#1e3c78<\/code> → <code>#961e3c<\/code><\/p>/,
  );
  assert.doesNotMatch(html, /&lt;br&gt;/);
});

test('report.html only accepts exact trailing paragraph breaks and escapes other markup', () => {
  const html = renderReportHtml(
    [
      'middle <br> stays text',
      '',
      'unsafe<br><script>alert(1)</script>',
      '',
      'other <strong>markup</strong><br>',
      '',
      'near matches <br/> <BR> <br> ',
      '',
      'escaped \\<br>',
      '',
      'ordinary',
      'paragraph lines',
    ].join('\n'),
  );
  assert.match(html, /<p>middle &lt;br&gt; stays text<\/p>/);
  assert.match(html, /<p>unsafe&lt;br&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(html, /<p>other &lt;strong&gt;markup&lt;\/strong&gt;<br><\/p>/);
  assert.match(html, /<p>near matches &lt;br\/&gt; &lt;BR&gt; &lt;br&gt; <\/p>/);
  assert.match(html, /<p>escaped &lt;br&gt;<\/p>/, 'a Markdown-escaped <br> stays literal text, as on main');
  assert.match(html, /<p>ordinary paragraph lines<\/p>/);
  assert.doesNotMatch(html, /<script\b|<strong\b/i);
});

test('report.html stacks a generated multi-property glance line with real line breaks', async () => {
  const { propertyGlanceLine } = await import('../dist/report/markdown.js');
  const md = propertyGlanceLine([
    {
      kind: 'style',
      path: 'h2',
      props: [
        { prop: 'border-color', before: '#1e3c78', after: '#961e3c' },
        { prop: 'color', before: '#1e3c78', after: '#961e3c' },
      ],
    },
  ]);
  const html = renderReportHtml(md);
  assert.doesNotMatch(html, /&lt;br&gt;/);
  assert.match(html, /<code>#961e3c<\/code><br> <code>color<\/code>/);
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
    crops: createCropBudget(60, 5_000_000),
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
    digest: [],
  });
  assert.equal(paths.reportHtmlPath, path.join(outDir, 'report.html'));
  assert.ok(fs.existsSync(paths.reportHtmlPath));
  const html = fs.readFileSync(paths.reportHtmlPath, 'utf8');
  assert.match(html, /<h2>report<\/h2>/);
  assert.match(html, /one <code>change<\/code> here/);
});

test('the committed demo report renders completely (#698)', () => {
  const md = fs.readFileSync(path.join(here, '..', 'docs/demo/report.md'), 'utf8');
  const html = renderReportHtml(md, { outDir: path.join(here, '..', 'docs/demo') });
  assert.equal(html, fs.readFileSync(path.join(here, '..', 'docs/demo/report.html'), 'utf8'));
  assert.match(html, /<h2>🗺️ StyleProof report<\/h2>/);
  for (const crop of fs.readdirSync(path.join(here, '..', 'docs/demo/crops')).filter((f) => f.endsWith('.png'))) {
    assert.ok(
      html.includes(
        `src="data:image/png;base64,${fs.readFileSync(path.join(here, '..', 'docs/demo/crops', crop)).toString('base64')}"`,
      ),
      `every demo crop must be inlined in report.html — missing crops/${crop}`,
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
  // codeValue breaks the `<!--` with an invisible zero-width space (#1015).
  assert.match(html, /<code>&quot;`&lt;!\u200b--&gt;&lt;img src=x onerror=alert\(1\)&gt;--&gt;&quot;<\/code>/);
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

test('report.html keeps an escaped `\\|` inside its table cell and code span (no cell split, no live link)', () => {
  const html = renderReportHtml(
    [
      '| Property | Before | After |',
      '| --- | --- | --- |',
      '| `font-family` | `serif` | `"\\|[Open full diff](javascript:alert%28document.domain%29)\\|"` |',
    ].join('\n'),
  );
  assert.match(
    html,
    /<tr><td><code>font-family<\/code><\/td><td><code>serif<\/code><\/td><td><code>&quot;\|\[Open full diff\]\(javascript:alert%28document.domain%29\)\|&quot;<\/code><\/td><\/tr>/,
  );
  assert.doesNotMatch(html, /href="javascript:/);
});

test('report.html renders Markdown backslash escapes and entities once, never as live links', () => {
  // escapeInlineMarkdown output for `[Open](javascript:x)`, `a<b`, `news_ticker`, `R&D`.
  const html = renderReportHtml('Candidates: div.\\[Open\\](javascript:x); div.a&lt;b; div.news\\_ticker; R&amp;D');
  assert.match(html, /div\.\[Open\]\(javascript:x\); div\.a&lt;b; div\.news_ticker; R&amp;D/);
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /&amp;lt;|&amp;amp;/);
});

test('report.html only links http(s) and relative URLs', () => {
  const html = renderReportHtml(
    [
      '[ok](https://example.com/run) [rel](crops/a.png) [bad](javascript:alert%281%29) [bad2](data:text/html,x)',
      '',
      '![shot](crops/a-composite.png) ![bad](javascript:alert%281%29)',
    ].join('\n'),
  );
  assert.match(html, /<a href="https:\/\/example\.com\/run">ok<\/a>/);
  assert.match(html, /<a href="crops\/a\.png">rel<\/a>/);
  assert.match(html, /<img src="crops\/a-composite\.png"/);
  assert.doesNotMatch(html, /href="(?:javascript|data):|src="javascript:/);
});

test('report.html refuses a non-http(s) link hidden behind a leading control character', () => {
  // Browsers strip leading C0 controls from a URL, so `\u0001javascript:` would still run.
  assert.doesNotMatch(renderReportHtml('[c](\u0001javascript:alert%281%29)'), /<a /);
});

test('report.html does not open a code span at a backslash-escaped backtick', () => {
  assert.match(renderReportHtml('**x\\`y** `sel`'), /<strong>x`y<\/strong> <code>sel<\/code>/);
});

test('text overflow preserves the verdict rather than replacing it with a truncation notice', () => {
  const md = '## STYLE_REVIEW_REQUIRED\n\n' + 'review this change '.repeat(300);
  assert.throws(() => renderReportHtml(md, { outDir: here, maxBytes: 3000 }), /cannot fit report text/);
});

test('HTML announces when preserved receipts exceed the combined artifact budget', () => {
  const html = renderArtifactHtml('# Report', { outDir: '.', maxBytes: 10000, receiptBytes: 10000 });
  assert.match(html, /Combined artifact byte budget exceeded to preserve report receipts/);
});

test('omitted HTML images do not promise complete findings in capped JSON', () => {
  const html = renderReportHtml('![Crop](crops/missing.png)', { outDir: '.', maxBytes: 10000 });
  assert.match(html, /1 image omitted/);
  assert.doesNotMatch(html, /report.json holds the full data/);
});

test('wide table cells carry escaped plain-text column labels', () => {
  const html = renderReportHtml(
    [
      '| **Rule** | _Change_ | `Gated by` | [Source](https://example.com) |',
      '| --- | --- | --- | --- |',
      '| .panel | changed | — | app.css |',
      '',
      '| **<img src=x onerror="alert(1)"> & "quoted"** | Change | Source | Why |',
      '| --- | --- | --- | --- |',
      '| value | changed | app.css | never matched |',
    ].join('\n'),
  );
  for (const label of ['Rule', 'Change', 'Gated by', 'Source']) {
    assert.ok(html.includes(`data-label="${label}"`));
  }
  assert.ok(html.includes('data-label="&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;"'));
  assert.doesNotMatch(html, /data-label="<|<img src=x/);
});

for (const columnCount of [1, 2, 3, 4, 5]) {
  test(`a ${columnCount}-column table ${columnCount >= 4 ? 'gets' : 'does not get'} the wide class`, () => {
    const row = (value) => '| ' + Array(columnCount).fill(value).join(' | ') + ' |';
    const html = renderReportHtml([row('Header'), row('---'), row('Value')].join('\n'));
    assert.equal(/<table[^>]*class="wide-table"/.test(html), columnCount >= 4);
    assert.equal((html.match(/data-label="Header"/g) ?? []).length, columnCount >= 4 ? columnCount : 0);
  });
}

test('generated Change Reach tables carry all five column labels', async () => {
  const { assessReachMaps, reachSectionLines } = await import('../dist/report/reach.js');
  const capture = (hash) => ({
    reach: { version: 2, scope: 'compared', sheets: ['/app.css'], rules: [{ key: '.panel', hash, sheet: 0 }] },
    scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts: [] },
  });
  const reach = assessReachMaps([capture('before')], [capture('after')], 'warn');
  const markdown = reachSectionLines(reach).join('\n');
  assert.match(markdown, /Changed but never matched/);
  // This renderer does not yet join script execution to changed lines or emit a script table.
  assert.ok(reach.gaps.some((gap) => gap.join === 'J2' && gap.status === 'unmeasured'));
  const html = renderReportHtml(markdown);
  for (const label of ['Rule', 'Change', 'Gated by', 'Source', 'Why']) {
    assert.ok(html.includes(`data-label="${label}"`));
  }
  assert.match(html, /<table[^>]*class="wide-table"/);
});

for (const rowCount of [1, 2000]) {
  test(`a three-column table with ${rowCount} rows keeps main's exact markup and byte cost`, () => {
    const markdown = [
      '| Property | Before | After |',
      '| --- | --- | --- |',
      ...Array(rowCount).fill('| `color` | `#111` | `#222` |'),
    ].join('\n');
    const expected =
      '<table><thead><tr><th>Property</th><th>Before</th><th>After</th></tr></thead><tbody>' +
      '<tr><td><code>color</code></td><td><code>#111</code></td><td><code>#222</code></td></tr>'.repeat(rowCount) +
      '</tbody></table>';
    const table = renderReportHtml(markdown).match(/<table\b[\s\S]*?<\/table>/)[0];
    assert.equal(table, expected);
  });
}

test('a wide header without body rows keeps ordinary visible table markup', () => {
  const html = renderReportHtml('| Rule | Change | Source | Why |\n| --- | --- | --- | --- |');
  assert.ok(
    html.includes('<table><thead><tr><th>Rule</th><th>Change</th><th>Source</th><th>Why</th></tr></thead></table>'),
  );
  assert.doesNotMatch(html, /class="wide-table"/);
});

test('wide tables add one label per cell without redundant descendant roles', () => {
  const markdown = [
    '| Rule | Change | Gated by | Source | Why |',
    '| --- | --- | --- | --- | --- |',
    ...Array(2000).fill('| `.panel` | changed | — | `/app.css` | Never matched |'),
  ].join('\n');
  const table = renderReportHtml(markdown).match(/<table\b[\s\S]*?<\/table>/)[0];
  assert.doesNotMatch(table, /<(?:thead|tbody|tr|th|td)[^>]* role=/);
  assert.equal((table.match(/data-label=/g) ?? []).length, 10000);
  const nativeTable = table.replace(/ class="wide-table"| role="table"| scope="col"| data-label="[^"]*"/g, '');
  assert.ok(Buffer.byteLength(table) < Buffer.byteLength(nativeTable) * 1.9);
});

test('only exceptionally long visible tokens opt ordinary tables into constrained sizing', () => {
  const render = (value) => renderReportHtml(`| Property | Value |\n| --- | --- |\n| width | ${value} |`);
  assert.doesNotMatch(render('&'.repeat(30)), /class="long-value-table"/);
  assert.doesNotMatch(render('A'.repeat(79)), /class="long-value-table"/);
  assert.doesNotMatch(render('`' + 'A'.repeat(79) + '`'), /class="long-value-table"/);
  assert.doesNotMatch(render('[crop](https://example.com/' + 'x'.repeat(90) + ')'), /class="long-value-table"/);
  assert.doesNotMatch(render('&amp;'.repeat(20)), /class="long-value-table"/);
  assert.match(render('`[crop](https://example.com/' + 'x'.repeat(90) + ')`'), /class="long-value-table"/);
  assert.match(render('A'.repeat(80)), /<table class="long-value-table">/);
});

test('wide header labels use image alternative text without carrying HTML', () => {
  const html = renderReportHtml(
    '| ![Rule label](/rule.png) | **Change** | Source | Why |\n| --- | --- | --- | --- |\n| .panel | changed | app.css | unmatched |',
  );
  assert.ok(html.includes('data-label="Rule label"'));
  assert.ok(html.includes('data-label="Change"'));
  assert.doesNotMatch(html, /data-label="[^"\n]*<(?:img|strong|script)/);
});
