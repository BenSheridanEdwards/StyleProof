import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/report.js';
import { pairFixture, rmTmp } from './helpers.mjs';

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

test('proved keyframes absence is a normal compared change; unreadable stays unknown', () => {
  const before = map(undefined);
  before.elements.image.style = { 'animation keyframes (pulse)': 'pulse' };
  before.visualChannels = {
    version: 1,
    keyframes: { pulse: { name: 'pulse', status: 'known', body: '100% { opacity: 1; }' } },
  };
  const after = structuredClone(before);
  after.visualChannels.keyframes.pulse = { name: 'pulse', status: 'none' };
  assert.deepEqual(diffStyleMaps(before, after)[0]?.props, [
    { prop: 'animation keyframes (pulse)', before: '100% { opacity: 1; }', after: '(no @keyframes)' },
  ]);
  after.visualChannels.keyframes.pulse = { name: 'pulse', status: 'unknown' };
  assert.deepEqual(diffStyleMaps(before, after), []);
});
