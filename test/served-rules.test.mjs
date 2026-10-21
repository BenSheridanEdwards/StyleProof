import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servedRulesOf } from '../dist/capture/reach.js';

// The Change Reach ledger (#991) names every leaf rule of a stylesheet's text and
// marks it used when a matched rule-usage range overlaps it.

const used = (text, ...needles) =>
  needles.map((needle) => {
    const start = text.indexOf(needle);
    assert.notEqual(start, -1, `fixture lacks ${needle}`);
    return { startOffset: start, endOffset: start + needle.length };
  });

test('servedRulesOf keys leaf rules by at-rule chain and prelude', () => {
  const text = `
    @charset "utf-8";
    @import url("base.css");
    /* a { comment: "{" } */
    .panel { padding: 12px; }
    @media (min-width: 1440px) {
      @supports (display: grid) { .panel   >  .cell { display: grid; } }
      .panel { padding: 16px; }
    }
    .quote::before { content: "}{"; }`;
  assert.deepEqual(
    servedRulesOf(text, []).map((r) => r.key),
    [
      '.panel',
      '@media (min-width: 1440px) > @supports (display: grid) > .panel > .cell',
      '@media (min-width: 1440px) > .panel',
      '.quote::before',
    ],
  );
});

test('servedRulesOf marks only rules a matched range overlaps', () => {
  const text = '.a { color: red; }\n.b { color: blue; }\n@media (min-width: 9999px) { .a { color: pink; } }';
  const rules = servedRulesOf(text, used(text, '.a { color: red; }'));
  assert.deepEqual(
    rules.map((r) => [r.key, r.used ?? false]),
    [
      ['.a', true],
      ['.b', false],
      ['@media (min-width: 9999px) > .a', false],
    ],
  );
});

test('a changed declaration block changes the hash; whitespace does not', () => {
  const [a] = servedRulesOf('.a { color: red; }', []);
  const [spaced] = servedRulesOf('.a {\n  color:   red;\n}', []);
  const [changed] = servedRulesOf('.a { color: blue; }', []);
  assert.equal(a.hash, spaced.hash);
  assert.notEqual(a.hash, changed.hash);
});

test('servedRulesOf records custom properties declared and read, and keyframe or font references', () => {
  const text = `
    :root { --warn: #f59e0b; --gap: 4px; }
    .badge { color: var(--warn); margin: var( --gap ) var(--gap); animation: pulse 2s paused; }
    .title { font-family: "Brand Sans", sans-serif; }
    @keyframes pulse { to { opacity: 0.5; } }`;
  const [root, badge, title, keyframes] = servedRulesOf(text, []);
  assert.deepEqual(Object.keys(root.vars), ['--warn', '--gap']);
  assert.equal(root.uses, undefined);
  assert.deepEqual(badge.uses, ['--warn', '--gap']);
  assert.ok(badge.refs.includes('pulse'));
  assert.ok(title.refs.includes('Brand'), 'quoted family names are split into identifiers');
  assert.equal(keyframes.key, '@keyframes pulse');
  assert.equal(keyframes.used, undefined);
});

test('a changed custom property value changes its digest', () => {
  const [before] = servedRulesOf(':root { --warn: #16a34a; }', []);
  const [after] = servedRulesOf(':root { --warn: #f59e0b; }', []);
  assert.notEqual(before.vars['--warn'], after.vars['--warn']);
});

test('servedRulesOf ends on unterminated comments, strings and blocks', () => {
  for (const text of [
    '.a { color: red; } /* never closed',
    '.a { content: "never closed; }',
    '.a { color: red;',
    '@media (x) {',
  ]) {
    assert.doesNotThrow(() => servedRulesOf(text, []), text);
  }
});
