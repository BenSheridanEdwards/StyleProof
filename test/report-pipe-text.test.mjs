// RV15-03: a `|` in captured link or button text must not break the before/after pair row. The
// text-only comment (private repositories, artifact storage) posts no image at all, the public
// comment posts exactly the pair at absolute URLs, and report.html shows the pair once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { reportCommentSummary } from '../dist/report-comment.js';
import { renderReportHtml } from '../dist/report/html.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

for (const text of ['Docs and API', 'Docs | API', 'a || b |']) {
  test(`link text ${JSON.stringify(text)} keeps the pair row whole in the comment and report.html (RV15-03)`, (t) => {
    const root = mkTmp('styleproof-pipe-text-');
    t.after(() => rmTmp(root));
    for (const side of ['before', 'after']) {
      const map = makeMap({
        elements: {
          'body > a:nth-child(1)': {
            tag: 'a',
            cls: 'nav-link',
            text,
            rect: [20, 20, 200, 30],
            style: { color: side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)' },
          },
        },
      });
      writeCapture(path.join(root, side), 'home@1280', map, solidPng(1280, 400));
    }
    const outDir = path.join(root, 'report');
    const result = generateStyleMapReport({
      beforeDir: path.join(root, 'before'),
      afterDir: path.join(root, 'after'),
      outDir,
    });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const textOnly = reportCommentSummary(md, {});
    assert.equal((textOnly.match(/<img /g) ?? []).length, 0, 'the text-only comment posts no image');
    assert.doesNotMatch(textOnly, /crops\//, 'and no relative crops/ link');
    const pub = reportCommentSummary(md, { imageBase: 'https://github.com/o/r/blob/abc/pr-1/' });
    assert.doesNotMatch(pub, /src="crops\//, 'the public comment has no relative image');
    assert.equal((pub.match(/-1-(?:before|after)\.png\?raw=1/g) ?? []).length, 2, 'the pair, once');
    const html = renderReportHtml(md, { outDir });
    assert.equal((html.match(/alt="Before: /g) ?? []).length, 1, 'report.html shows the pair once');
    assert.equal((html.match(/alt="After: /g) ?? []).length, 1);
    // The alt says the captured text as it is, with no Markdown backslash left in it.
    if (text.includes('|')) assert.doesNotMatch(html, /alt="[^"]*\\\|/, 'no \\| in an alt');
    const rows = md.split('\n').filter((l) => l.startsWith('| <img'));
    assert.equal(rows.length, 1, 'one pair row in report.md');
    assert.equal(rows[0].split(' | ').length, 2, 'the row has exactly its two cells');
  });
}
