import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSectionMeta, encodeSectionMeta, SECTION_END } from '../dist/report/section-meta.js';

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
      w: 424,
      h: 180,
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
  pages: [{ state: 'rest', before: 'crops/a-page-base.png', after: 'crops/a-page-head.png', w: 1280, h: 800 }],
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
