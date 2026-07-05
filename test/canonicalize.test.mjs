// Canonicalization: an identical computed value serialized differently by a browser or
// build-tool version must NOT read as a change — but a real value change always must.
// This is the fix for re-baseline noise (a Chromium bump rewrites rgba()→#hex; a Tailwind
// migration reformats font-list spacing) drowning a diff in changes that aren't changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeStyleValue, styleValuesEqual } from '../dist/canonicalize.js';
import { diffStyleMaps } from '../dist/diff.js';

test('equal values in different spellings collapse (no false diff)', () => {
  for (const [a, b] of [
    ['rgba(8, 18, 32, 0.62)', '#0812209e'], // the Chromium re-serialization that started this
    ['rgb(255, 0, 0)', '#ff0000'],
    ['rgb(255, 0, 0)', '#f00'],
    ['rgba(255,0,0,1)', 'rgb(255, 0, 0)'], // spacing + alpha=1 dropped
    ['hsl(0, 100%, 50%)', 'rgb(255, 0, 0)'], // hsl vs rgb, same red
    ['hsla(120, 100%, 50%, 0.5)', 'rgba(0, 255, 0, 0.5)'],
    ['rgb(8 18 32 / 0.62)', 'rgba(8, 18, 32, 0.62)'], // modern space syntax
    ['"Share Tech Mono",ui-monospace,monospace', '"Share Tech Mono", ui-monospace, monospace'],
    ['1px  solid   red', '1px solid red'], // whitespace runs
    ['0 1px 2px rgba(0,0,0,.5)', '0 1px 2px rgba(0, 0, 0, 0.5)'], // color inside a shadow
  ]) {
    assert.ok(
      styleValuesEqual(a, b),
      `${a} should equal ${b} (canon: ${canonicalizeStyleValue(a)} vs ${canonicalizeStyleValue(b)})`,
    );
  }
});

test('a REAL value change is never collapsed (source of truth preserved)', () => {
  for (const [a, b] of [
    ['rgb(255, 0, 0)', 'rgb(255, 0, 1)'], // one channel off by 1
    ['#ff0000', '#ff0001'],
    ['rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.6)'], // alpha differs
    ['10px', '11px'],
    ['red', 'blue'], // named
    ['"Arial", sans-serif', '"Helvetica", sans-serif'], // different quoted family
    ['bold', 'normal'],
  ]) {
    assert.ok(!styleValuesEqual(a, b), `${a} must NOT equal ${b}`);
  }
});

test('unparseable colours and quoted strings are left untouched', () => {
  // A "#fff" inside content: is text, not a colour — not rewritten.
  assert.equal(canonicalizeStyleValue('"#fff"'), '"#fff"');
  // An unparseable colour function is returned as-is (never guessed).
  assert.equal(canonicalizeStyleValue('rgb(var(--x))'), 'rgb(var(--x))');
});

// The user-visible regression: a serialization-only difference produces ZERO findings.
test('diffStyleMaps ignores a serialization-only computed-style difference', () => {
  const el = (color, font) => ({
    defaults: {},
    states: {},
    elements: {
      body: { tag: 'body', cls: '', rect: [0, 0, 8, 8], style: { color, 'font-family': font } },
    },
  });
  const base = el('rgba(8, 18, 32, 0.62)', '"Share Tech Mono",ui-monospace');
  const head = el('#0812209e', '"Share Tech Mono", ui-monospace');
  const findings = diffStyleMaps(base, head);
  assert.equal(findings.length, 0, `serialization-only diff should yield no findings, got ${JSON.stringify(findings)}`);

  // ...but a real colour change still surfaces.
  const realChange = diffStyleMaps(base, el('#0912209e', '"Share Tech Mono",ui-monospace'));
  assert.ok(realChange.length > 0, 'a real colour change must still be a finding');
});
