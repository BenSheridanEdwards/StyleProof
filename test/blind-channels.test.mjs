import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import { pairFixture, rmTmp } from './helpers.mjs';
import { captureOptionsFor, resolveSettings } from '../dist/runner/settings.js';
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

test('runner defaults visual channels off and forwards the explicit opt-in', () => {
  for (const captureVisualChannels of [undefined, false, true]) {
    const settings = resolveSettings({ dir: 'head', freezeClock: false, captureVisualChannels });
    assert.equal(settings.captureVisualChannels, captureVisualChannels === true);
    assert.equal(
      captureOptionsFor({ key: 'home' }, settings, () => 0).captureVisualChannels,
      captureVisualChannels === true,
    );
  }
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

test('report names skipped legacy evidence and recommends pixels only for matched changed fonts', () => {
  const fontMap = (hash, used) => ({
    ...map({}),
    reach: {
      version: 2,
      scope: 'compared',
      sheets: ['inline'],
      rules: [
        { key: '@font-face', hash, sheet: 0, refs: ['Fixture'] },
        { key: 'body', hash: 'same', sheet: 0, refs: ['Fixture'], ...(used ? { used: true } : {}) },
      ],
    },
  });
  for (const matched of [true, false]) {
    const fixture = pairFixture({ surface: 'home@800', before: fontMap('a', matched), after: fontMap('b', matched) });
    try {
      const result = generateStyleMapReport(fixture);
      const report = fs.readFileSync(result.reportMdPath, 'utf8');
      assert.match(report, /not compared \(map predates keyframes\/currentSrc capture\)/);
      assert.equal(report.includes('run `--pixels` for this surface'), matched);
      if (matched) assert.match(report, /home@800.*changed `@font-face`/);
      assert.equal(result.comparison.rawCounts.style, 0);
    } finally {
      rmTmp(fixture.root);
    }
  }
});

test('new channel findings reach report reviewable counts without being advisory', () => {
  const before = map({ 'img currentSrc': '/before.png' }, evidence('same'));
  const after = map({ 'img currentSrc': '/after.png' }, evidence('same'));
  for (const gateMode of ['certify', 'review-gate']) {
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      const result = generateStyleMapReport({ ...fixture, gateMode });
      assert.equal(result.comparison.rawCounts.style, 1);
      assert.equal(result.comparison.reviewableCounts.style, 1);
      assert.match(fs.readFileSync(result.reportMdPath, 'utf8'), /img currentSrc/);
    } finally {
      rmTmp(fixture.root);
    }
  }
});

test('self-check includes skipped unknown and missing visual-channel evidence', () => {
  const first = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('a'));
  const missing = map({ 'animation keyframes (pulse)': 'pulse' });
  assert.deepEqual(diffStyleMaps(first, missing), []);
  assert.throws(() => assertDeterministicVisualChannels(first, missing, 'home'), /self-check failed/);
  const unknown = structuredClone(first);
  unknown.visualChannels.keyframes.pulse = { name: 'pulse', status: 'unknown' };
  assert.deepEqual(diffStyleMaps(first, unknown), []);
  assert.throws(() => assertDeterministicVisualChannels(first, unknown, 'home'), /self-check failed/);
});
