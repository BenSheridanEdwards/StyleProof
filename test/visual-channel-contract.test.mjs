import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { pairFixture, rmTmp } from './helpers.mjs';
import { captureOptionsFor, resolveSettings } from '../dist/runner/settings.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const channels = { version: 1, keyframes: {} };

  const map = (source, enabled = true) => ({
    defaults: {},
    states: {},
    elements: { image: { tag: 'img', cls: 'asset', style: source === undefined ? {} : { 'img currentSrc': source } } },
    ...(enabled ? { visualChannels: channels } : {}),
  });

  function report(before, after) {
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      return fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    } finally {
      rmTmp(fixture.root);
    }
  }

  test('both sides opted out produce no visual-channel evidence block', () => {
    const text = report(map(undefined, false), map(undefined, false));
    assert.doesNotMatch(text, /Visual channel evidence|map predates/);
  });

  test('one-sided channel marker names the limit and leaves the following warning a separate paragraph', () => {
    for (const [before, after] of [
      [map(undefined, false), map('/a.png')],
      [map('/a.png'), map(undefined, false)],
    ]) {
      assert.deepEqual(diffStyleMaps(before, after), []);
      const text = report(before, after);
      assert.match(text, /not compared \(map predates keyframes\/currentSrc capture\)/);
      assert.match(text, /recapture both sides[^\n]+\n\n⚠️/);
    }
  });
}

{
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

  test('report recommends pixels for matched fonts without legacy notices when both channel captures are off', () => {
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
        assert.doesNotMatch(report, /map predates/);
        assert.equal(report.includes('run `--pixels` for this surface'), matched);
        if (matched) assert.match(report, /home@800.*changed `@font-face`/);
        assert.equal(result.comparison.rawCounts.style, 0);
      } finally {
        rmTmp(fixture.root);
      }
    }
    for (const missing of ['base', 'head']) {
      const before = fontMap('a', true),
        after = fontMap('b', true);
      delete (missing === 'base' ? before : after).reach;
      const fixture = pairFixture({ surface: 'home@800', before, after });
      try {
        const text = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
        assert.doesNotMatch(text, /run `--pixels` for this surface/);
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
}
