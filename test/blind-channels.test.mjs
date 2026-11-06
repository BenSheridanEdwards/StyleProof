import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStyleMaps } from '../dist/diff.js';

const map = (style, visualChannels) => ({
  defaults: {},
  elements: { body: { tag: 'body', cls: '', style } },
  states: {},
  ...(visualChannels ? { visualChannels } : {}),
});
const evidence = (body) => ({
  version: 1,
  keyframes: { pulse: { name: 'pulse', hash: body, body, status: 'known' } },
});

test('legacy maps skip keyframes and currentSrc on either side without hiding CSS changes', () => {
  const old = map({ color: 'red' });
  const captured = map(
    { color: 'red', 'animation keyframes (pulse)': 'pulse', 'img currentSrc': '/a.png' },
    evidence('a'),
  );
  assert.deepEqual(diffStyleMaps(old, captured), []);
  assert.deepEqual(diffStyleMaps(captured, old), []);
  const changed = structuredClone(captured);
  changed.elements.body.style.color = 'blue';
  assert.deepEqual(
    diffStyleMaps(old, changed)[0].props.map((p) => p.prop),
    ['color'],
  );
});

test('keyframe references compare canonical bodies, even if reference IDs agree', () => {
  const before = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('0% { opacity: 0; }'));
  const after = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('0% { opacity: 1; }'));
  assert.equal(diffStyleMaps(before, after)[0]?.props[0].prop, 'animation keyframes (pulse)');
});

test('unknown keyframes do not fabricate a body difference', () => {
  const before = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('body'));
  const after = map(
    { 'animation keyframes (pulse)': 'pulse' },
    {
      version: 1,
      keyframes: { pulse: { name: 'pulse', status: 'unknown' } },
    },
  );
  assert.deepEqual(diffStyleMaps(before, after), []);
});
