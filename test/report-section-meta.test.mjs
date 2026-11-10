import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeSectionMeta, encodeSectionMeta, SECTION_END } from '../dist/report/section-meta.js';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReportForTesting } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const meta = {
  v: 1,
  id: 'card-titles',
  paths: ['body > main > h2:nth-child(1)', 'a--b <script>alert(1)</script> -->'],
  more: 0,
  pairs: [
    {
      state: 'hover',
      before: 'crops/a-1-before.png',
      after: 'crops/a-1-after.png',
      width: 424,
      height: 180,
      what: 'the "first" card',
    },
  ],
  where: [
    {
      image: 'crops/a-1-where.png',
      side: 'after',
      page: [1280, 800],
      view: [0, 0, 1280, 340],
      boxes: [[33, 172, 382, 46]],
    },
  ],
  pages: [{ state: 'rest', before: 'crops/a-page-base.png', after: 'crops/a-page-head.png', width: 1280, height: 800 }],
};

test('a section comment round-trips its data', () => {
  assert.deepEqual(decodeSectionMeta(encodeSectionMeta(meta)), meta);
});

test('a section comment can never close early or carry markup', () => {
  const line = encodeSectionMeta(meta);
  const body = line.slice('<!-- '.length, -' -->'.length);
  assert.doesNotMatch(body, /[<>]|--/, 'no angle bracket or double dash inside the comment');
  assert.match(line, /^<!-- styleproof-section [^\s<>]+ -->$/);
  assert.equal(SECTION_END, '<!-- styleproof-section-end -->');
});

test('anything that is not a valid section comment decodes to null', () => {
  for (const line of [
    '<!-- styleproof-section not-json -->',
    `<!-- styleproof-section ${encodeURIComponent(JSON.stringify({ ...meta, v: 2 }))} -->`,
    `<!-- styleproof-section ${encodeURIComponent(JSON.stringify({ ...meta, where: [{ side: 'left' }] }))} -->`,
    `<!-- styleproof-section ${encodeURIComponent(JSON.stringify({ ...meta, pairs: [{ state: 1 }] }))} -->`,
    '### Card titles',
  ]) {
    assert.equal(decodeSectionMeta(line), null, line.slice(0, 40));
  }
});

test('section ids never take an id report.html already uses (RV5-05)', (t) => {
  const root = mkTmp('styleproof-section-ids-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const color = side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)';
    const elements = {
      'body > h2': { tag: 'h2', cls: 'coverage-title', rect: [20, 20, 300, 40], style: { color } },
      'body > p:nth-child(2)': { tag: 'p', cls: 'sp-page', rect: [20, 300, 300, 40], style: { color } },
      'body > div:nth-child(3)': {
        tag: 'div',
        cls: 'sp-page',
        rect: [20, 600, 300, 40],
        style: { 'background-color': color },
      },
    };
    writeCapture(path.join(root, side), 'home@1280', makeMap({ elements }), solidPng(1280, 900));
  }
  const result = generateStyleMapReportForTesting({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const ids = fs
    .readFileSync(result.reportMdPath, 'utf8')
    .split('\n')
    .map(decodeSectionMeta)
    .filter(Boolean)
    .map((meta) => meta.id);
  assert.equal(ids.length, 3, ids.join(', '));
  for (const id of ids) assert.doesNotMatch(id, /^(?:coverage-title|sp-page(?:-\d+)?)$/, id);
});
