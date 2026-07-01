import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptureUrlArgs, UsageError } from '../dist/capture-url.js';

test('defaults: just a url', () => {
  const o = parseCaptureUrlArgs(['https://example.com/pricing']);
  assert.deepEqual(o, {
    url: 'https://example.com/pricing',
    key: 'page',
    widths: [],
    out: 'styleproof-capture',
    ignore: [],
    waitSelector: undefined,
    height: 800,
    screenshots: true,
    crawl: false,
    maxDepth: 3,
    maxActionsPerState: 30,
    maxStates: 60,
    resetStorage: true,
  });
});

test('crawl flags parse', () => {
  const o = parseCaptureUrlArgs([
    'u',
    '--crawl',
    '--max-depth',
    '4',
    '--max-actions',
    '20',
    '--max-states',
    '80',
    '--no-reset-storage',
  ]);
  assert.equal(o.crawl, true);
  assert.equal(o.maxDepth, 4);
  assert.equal(o.maxActionsPerState, 20);
  assert.equal(o.maxStates, 80);
  assert.equal(o.resetStorage, false);
});

test('flags: spaced and inline forms both parse', () => {
  const spaced = parseCaptureUrlArgs([
    'https://x',
    '--key',
    'pricing',
    '--out',
    'design',
    '--wait',
    '.card',
    '--height',
    '900',
  ]);
  assert.equal(spaced.key, 'pricing');
  assert.equal(spaced.out, 'design');
  assert.equal(spaced.waitSelector, '.card');
  assert.equal(spaced.height, 900);

  const inline = parseCaptureUrlArgs(['https://x', '--key=pricing', '--out=design']);
  assert.equal(inline.key, 'pricing');
  assert.equal(inline.out, 'design');
});

test('widths: csv parsed, whitespace tolerated, order preserved', () => {
  assert.deepEqual(parseCaptureUrlArgs(['u', '--widths', '1440,1024,768']).widths, [1440, 1024, 768]);
  assert.deepEqual(parseCaptureUrlArgs(['u', '--widths', ' 1440 , 768 ']).widths, [1440, 768]);
  assert.deepEqual(parseCaptureUrlArgs(['u', '--widths=768,1440']).widths, [768, 1440]);
});

test('ignore: repeatable, accumulates', () => {
  assert.deepEqual(parseCaptureUrlArgs(['u', '--ignore', '.live', '--ignore', '.ticker']).ignore, ['.live', '.ticker']);
});

test('screenshots: toggled off and back on', () => {
  assert.equal(parseCaptureUrlArgs(['u', '--no-screenshots']).screenshots, false);
  assert.equal(parseCaptureUrlArgs(['u', '--no-screenshots', '--screenshots']).screenshots, true);
});

test('usage errors throw UsageError', () => {
  assert.throws(() => parseCaptureUrlArgs([]), UsageError, 'missing url');
  assert.throws(() => parseCaptureUrlArgs(['a', 'b']), UsageError, 'two urls');
  assert.throws(() => parseCaptureUrlArgs(['u', '--nope']), UsageError, 'unknown flag');
  assert.throws(() => parseCaptureUrlArgs(['u', '--widths', 'abc']), UsageError, 'non-numeric width');
  assert.throws(() => parseCaptureUrlArgs(['u', '--widths', '0']), UsageError, 'non-positive width');
  assert.throws(() => parseCaptureUrlArgs(['u', '--widths', '']), UsageError, 'empty widths');
  assert.throws(() => parseCaptureUrlArgs(['u', '--height', 'tall']), UsageError, 'non-numeric height');
  assert.throws(() => parseCaptureUrlArgs(['u', '--height', '0']), UsageError, 'non-positive height');
  assert.throws(() => parseCaptureUrlArgs(['u', '--key']), UsageError, 'flag missing value');
});
