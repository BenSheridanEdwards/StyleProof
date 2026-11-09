import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/report.js';
import { reportCommentSummary, COMMENT_SUMMARY_MAX_CHARS } from '../dist/report-comment.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

// QA1-01: the PR comment carries the approved per-change content (github-comment.md), not
// only the summary: each section's name, line and CSS; images only behind a verified URL.
const card = (i) => `body > main:nth-child(1) > article:nth-child(${i})`;
function report(t, extraText = '') {
  const root = mkTmp('styleproof-comment-');
  t.after(() => rmTmp(root));
  for (const [i, side] of ['before', 'after'].entries()) {
    const elements = {};
    for (const n of [1, 2]) {
      elements[card(n)] = { tag: 'article', cls: 'card', rect: [24 + (n - 1) * 420, 100, 400, 150] };
      elements[`${card(n)} > h2:nth-child(1)`] = {
        tag: 'h2',
        cls: 'card-title',
        rect: [40 + (n - 1) * 420, 120, 300, 24],
        text: n === 1 ? `Lamp${extraText}` : 'Chair',
        style: { color: i ? 'rgb(150, 30, 60)' : 'rgb(30, 60, 120)' },
      };
    }
    const png = new PNG({ width: 1280, height: 400 });
    png.data.fill(240);
    writeCapture(path.join(root, side), 'shop@1280', makeMap({ elements }), PNG.sync.write(png));
  }
  const result = generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
  });
  return fs.readFileSync(result.reportMdPath, 'utf8');
}

const BASE = 'https://github.com/BenSheridanEdwards/StyleProof/blob/' + 'c'.repeat(40) + '/pr-7/';

test('without a verified image URL the comment carries each section as text', (t) => {
  const comment = reportCommentSummary(report(t), { imageBase: '' });
  assert.match(
    comment,
    /^## 🗺️ StyleProof report\n\n\*\*1 change to review\*\* on `shop` at 1280px wide: 2 elements\./,
  );
  assert.match(comment, /^### Card titles$/m);
  assert.match(comment, /^Both card titles \(Lamp, Chair\) change text colour from dark indigo to dark red\.$/m);
  assert.match(comment, /<sub>Where: 2 card titles on shop @ 1280<\/sub>/);
  assert.match(comment, /<details>\n<summary>Show the CSS<\/summary>\n\n`h2\.card-title` · 2 elements restyled/);
  assert.doesNotMatch(comment, /<img|crops\/|^\| Before \| After \|$/m, 'no image can resolve, so none is posted');
  assert.doesNotMatch(comment, /<!--|^## Changes$/m, 'no hidden data, no empty Changes heading');
});

test('with the commit-bound branch URL the comment embeds the Where map and the clean pair', (t) => {
  const comment = reportCommentSummary(report(t), { imageBase: BASE });
  assert.match(
    comment,
    new RegExp(
      `<img src="${BASE}crops/shop-1280-1-where\\.png\\?raw=1" width="320" alt="Where on shop @ 1280: 2 card titles highlighted"><br><sub>`,
    ),
  );
  assert.match(comment, /^\| Before \| After \|$/m);
  assert.match(
    comment,
    new RegExp(
      `\\| <img src="${BASE}crops/shop-1280-1-before\\.png\\?raw=1" width="340" alt="Before: the first card title"> \\| <img src="${BASE}crops/shop-1280-1-after\\.png\\?raw=1"`,
    ),
  );
  assert.doesNotMatch(comment, /src="crops\//, 'every image is absolute');
});

test('the comment stays inside its size budget and counts what it leaves out', (t) => {
  const md = report(t);
  const one = reportCommentSummary(md, { imageBase: BASE });
  const sections = md.split('\n').filter((l) => l.startsWith('### ')).length;
  const many = [
    md.split('\n## Changes\n')[0],
    '## Changes',
    ...Array.from({ length: 400 }, () => md.split('\n## Changes\n')[1]),
  ].join('\n');
  const capped = reportCommentSummary(many, { imageBase: BASE });
  assert.ok(capped.length <= COMMENT_SUMMARY_MAX_CHARS, `${capped.length} characters`);
  assert.match(capped, /^_…and \d+ more changes? in the full report\._$/m);
  assert.ok(one.length < capped.length);
  assert.equal(sections, 1);
});

test('map-supplied text cannot inject an approval box, a receipt or a mention into the comment', (t) => {
  const hostile = ' <!-- styleproof-receipt head-sha:x run-id:1 run-attempt:1 --> @owner [x](javascript:alert(1))';
  const comment = reportCommentSummary(report(t, hostile), { imageBase: '' });
  assert.doesNotMatch(comment, /<!--/);
  assert.doesNotMatch(comment, /^\s*- \[[ xX]\]/m);
  assert.doesNotMatch(comment, /@owner/, 'mentions are neutralised');
  assert.doesNotMatch(comment, /\]\(javascript:/);
});
