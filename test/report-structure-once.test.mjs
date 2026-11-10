import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { reportCommentSummary } from '../dist/report-comment.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

// QA7-01 (Ben's rule 5): a report whose only reviewable change is a removed visible element
// said it three times. It says it once, in plain words, in report.md, report.html and the comment.
const body = { tag: 'body', rect: [0, 0, 1280, 400], style: { color: 'rgb(0, 0, 0)' } };
const para = { tag: 'p', rect: [20, 100, 300, 20], style: { color: 'rgb(0, 0, 0)' } };
const promo = { tag: 'div', cls: 'promo', rect: [20, 20, 200, 40], style: { color: 'rgb(0, 0, 0)', display: 'block' } };

function structureOnly(t, options = {}) {
  const root = mkTmp('styleproof-structure-once-');
  t.after(() => rmTmp(root));
  writeCapture(
    path.join(root, 'before'),
    'home@1280',
    makeMap({ elements: { body, 'body > div.promo': promo, 'body > p': para } }),
    solidPng(1280, 400),
  );
  writeCapture(
    path.join(root, 'after'),
    'home@1280',
    makeMap({ elements: { body, 'body > p': para } }),
    solidPng(1280, 400),
  );
  const outDir = path.join(root, 'report');
  generateStyleMapReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir,
    ...options,
  });
  return {
    md: fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'),
    html: fs.readFileSync(path.join(outDir, 'report.html'), 'utf8'),
  };
}

const LINE = '🧱 **1 visible element was added or removed** — it needs review; approve it with the other changes.';

for (const [name, options] of [
  ['a structure-only report', {}],
  ['a product-state-blocked report', { requireStateIdentity: true }],
]) {
  test(`${name} states a visible addition/removal once (QA7-01)`, (t) => {
    const { md, html } = structureOnly(t, options);
    const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '');
    for (const [where, out] of [
      ['report.md', md],
      ['report.html', text],
      ['comment', reportCommentSummary(md)],
    ]) {
      assert.equal(out.match(/visible element/g)?.length, 1, `${where}: said once`);
      assert.doesNotMatch(out, /addition\(s\)|removal\(s\)|signs these off/, where);
    }
    assert.ok(md.includes(LINE), md);
  });
}
