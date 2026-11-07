import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { pairFixture, rmTmp } from './helpers.mjs';

const prop = 'animation keyframes (pulse)';
function map(rest, state, pseudo = '') {
  const ref = (value) => (value === undefined ? {} : { [prop]: value });
  return {
    defaults: {},
    elements: {
      body: {
        tag: 'body',
        cls: '',
        style: pseudo ? {} : ref(rest),
        ...(pseudo ? { pseudo: { [pseudo]: ref(rest) } } : {}),
      },
    },
    states: { body: { hover: { ['body' + pseudo]: { ...ref(state), color: 'red' } } } },
    visualChannels: {
      version: 1,
      keyframes: {
        unknown: { name: 'pulse', status: 'unknown' },
        a: { name: 'pulse', status: 'known', body: 'a' },
        b: { name: 'pulse', status: 'known', body: 'b' },
      },
    },
  };
}
for (const pseudo of ['', '::before'])
  for (const side of ['base', 'head'])
    test(`unknown ${side} resting evidence never becomes a ${pseudo || 'element'} state finding`, () => {
      const unknown = map('unknown', 'b', pseudo),
        known = map('a', undefined, pseudo);
      const [before, after] = side === 'base' ? [unknown, known] : [known, unknown];
      after.states.body.hover['body' + pseudo].color = 'blue';
      const changes = diffStyleMaps(before, after).flatMap((f) => f.props ?? []);
      assert.deepEqual(
        changes.map((p) => p.prop),
        ['color'],
      );
      const fixture = pairFixture({ surface: 'home@800', before, after });
      try {
        assert.match(fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8'), /unknown.*not compared/);
      } finally {
        rmTmp(fixture.root);
      }
    });

test('a missing state delta resolves to its known resting body for channel comparisons', () => {
  assert.deepEqual(diffStyleMaps(map('a', undefined), map('a', 'a')), []);
  const changes = diffStyleMaps(map('a', undefined), map('a', 'b')).flatMap((f) => f.props ?? []);
  assert.deepEqual(changes, [{ prop, before: 'a', after: 'b' }]);
});

test('a hover-only name without a resting entry still detects a real body edit', () => {
  assert.equal(diffStyleMaps(map(undefined, 'a'), map(undefined, 'b')).flatMap((f) => f.props ?? []).length, 1);
});

test('an unloaded resting image also prevents a fabricated state source finding', () => {
  const before = map(undefined, undefined);
  before.elements.body.style = { 'img currentSrc': '' };
  before.states.body.hover.body = { 'img currentSrc': '/a.png' };
  const after = structuredClone(before);
  after.elements.body.style['img currentSrc'] = '/loaded.png';
  after.states.body.hover.body['img currentSrc'] = '/b.png';
  assert.deepEqual(diffStyleMaps(before, after), []);
});
