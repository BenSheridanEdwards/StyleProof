import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { pairFixture, rmTmp } from './helpers.mjs';
import * as values from '../dist/capture/visual-channel-values.js';

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

  test('unloaded sources are skipped on either side, including empty against empty, with a named limit', () => {
    for (const [before, after] of [
      [map(''), map('/a.png')],
      [map('/a.png'), map('')],
      [map(''), map('')],
    ]) {
      assert.deepEqual(diffStyleMaps(before, after), []);
      assert.match(report(before, after), /not compared \(unloaded image\)/);
    }
  });
}

{
  const map = (source) => ({
    defaults: {},
    states: {},
    elements: { image: { tag: 'img', cls: 'asset', style: { 'img currentSrc': source } } },
    visualChannels: { version: 1, keyframes: {} },
  });

  test('blob sources are stable skipped evidence on either side with a named report limit', () => {
    for (const [before, after] of [
      [map('(blob URL; not compared)'), map('/a.png')],
      [map('/a.png'), map('(blob URL; not compared)')],
      [map('(blob URL; not compared)'), map('(blob URL; not compared)')],
    ]) {
      assert.deepEqual(diffStyleMaps(before, after), []);
      const fixture = pairFixture({ surface: 'home@800', before, after });
      try {
        const text = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
        assert.match(text, /not compared \(blob URL\)/);
        assert.doesNotMatch(text, /unloaded image/);
      } finally {
        rmTmp(fixture.root);
      }
    }
  });

  test('a complete image with no source is compared, rather than skipped as unloaded', () => {
    assert.deepEqual(diffStyleMaps(map('/a.png'), map('(no source)'))[0]?.props, [
      { prop: 'img currentSrc', before: '/a.png', after: '(no source)' },
    ]);
  });

  test('image comparison limits also name skipped sources captured only in forced states', () => {
    for (const [value, reason] of [
      ['(blob URL; not compared)', 'blob URL'],
      ['', 'unloaded image'],
    ]) {
      const before = map('/a.png');
      const after = map('/a.png');
      before.states = { image: { hover: { image: { 'img currentSrc': '/a.png' } } } };
      after.states = { image: { hover: { image: { 'img currentSrc': value } } } };
      assert.deepEqual(diffStyleMaps(before, after), []);
      const fixture = pairFixture({ surface: 'home@800', before, after });
      try {
        const text = fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
        assert.ok(text.includes(`not compared (${reason}) on 1 captured image(s)`));
      } finally {
        rmTmp(fixture.root);
      }
    }
  });
}

{
  for (const [width, height, expected] of [
    [{ unit: 'px', value: 16 }, { unit: 'px', value: 16 }, true],
    [{ unit: 'px', value: 0 }, { unit: 'px', value: 0 }, true],
    [{ value: 'auto' }, { unit: 'px', value: 16 }, false],
    [{ unit: 'px', value: 16 }, { value: 'auto' }, false],
    [{ unit: 'percent', value: 100 }, { unit: 'px', value: 16 }, false],
    [undefined, undefined, false],
  ])
    test('opaque media requires two definite dimensions: ' + JSON.stringify([width, height]), () =>
      assert.equal(values.fixedMediaSize(width, height), expected),
    );
}
