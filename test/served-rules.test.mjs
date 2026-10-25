import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servedRulesOf, trackServedRules } from '../dist/capture/reach.js';
import { assertDeterministicReach } from '../dist/runner/self-check.js';

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
  assert.equal(root.aliases, undefined);
  assert.deepEqual(badge.uses, ['--warn', '--gap']);
  assert.equal(badge.aliases, undefined);
  assert.ok(badge.refs.includes('pulse'));
  assert.deepEqual(title.refs, ['Brand Sans', 'sans-serif']);
  assert.equal(keyframes.key, '@keyframes pulse');
  assert.equal(keyframes.used, undefined);
});

test('servedRulesOf records sorted, deduplicated custom property aliases', () => {
  const [root] = servedRulesOf(
    ':root { --warn: red; --middle: var( --warn ); --tone: var(--warn) var(--middle) var(--warn); }',
    [],
  );
  assert.deepEqual(root.aliases, { '--middle': ['--warn'], '--tone': ['--middle', '--warn'] });
});

test('servedRulesOf unions aliases across repeated custom property declarations', () => {
  const [root] = servedRulesOf(':root { --tone: var(--warn); --tone: var(--middle) var(--warn); --tone: blue; }', []);
  assert.deepEqual(root.aliases, { '--tone': ['--middle', '--warn'] });
  assert.deepEqual(root.uses, ['--warn', '--middle']);
});

test('servedRulesOf reads var() names past comments and in any case', () => {
  const [root] = servedRulesOf(
    `:root { --tone: var(/* c */ --warn); --mix: VAR( --a , var(/**/--b));
       color: var(--c/* d */); content: "var(--s)"; }`,
    [],
  );
  assert.deepEqual(root.aliases, { '--mix': ['--a', '--b'], '--tone': ['--warn'] });
  assert.deepEqual(root.uses, ['--warn', '--a', '--b', '--c']);
});

test('a var() name servedRulesOf cannot parse fails with unknown reach', () => {
  for (const text of [
    String.raw`:root { --tone: var(--w\61rn); }`,
    '.a { color: var(--wärn); }',
    '.a { color: var(); }',
  ]) {
    assert.throws(() => servedRulesOf(text, []), /served CSS reach is unknown: unsupported var\(\) reference/, text);
  }
});

test('servedRulesOf records @property without declarations, reads or usage', () => {
  const [property] = servedRulesOf('@property --brand { syntax: "<color>"; inherits: false; initial-value: red; }', []);
  assert.equal(property.key, '@property --brand');
  assert.equal(property.vars, undefined);
  assert.equal(property.uses, undefined);
  assert.equal(property.used, undefined);
});

test('a changed custom property value changes its digest', () => {
  const [before] = servedRulesOf(':root { --warn: #16a34a; }', []);
  const [after] = servedRulesOf(':root { --warn: #f59e0b; }', []);
  assert.notEqual(before.vars['--warn'], after.vars['--warn']);
});

test('servedRulesOf fails with unknown reach on unterminated comments, strings and blocks', () => {
  for (const text of [
    '.a { color: red; } /* never closed',
    '.a { content: "never closed; }',
    '.a { color: red;',
    '@media (x) {',
  ]) {
    assert.throws(() => servedRulesOf(text, []), /served CSS reach is unknown/, text);
  }
});

test('quoted and escaped delimiters do not swallow later rules or usage', () => {
  const text = String.raw`[data-label="{;}"] { color: red; }
    .escaped\{ { content: "quote\"}; still quoted"; }
    .last { color: blue; }`;
  const rules = servedRulesOf(text, used(text, '.last { color: blue; }'));
  assert.deepEqual(
    rules.map((r) => [r.key, r.used ?? false]),
    [
      ['[data-label="{;}"]', false],
      [String.raw`.escaped\{`, false],
      ['.last', true],
    ],
  );
  const before = servedRulesOf(String.raw`.a { content: "quote\"}; before"; }`, []);
  const after = servedRulesOf(String.raw`.a { content: "quote\"}; after"; }`, []);
  assert.notEqual(before[0].hash, after[0].hash);
});

test('statement delimiters in strings, comments and component values are opaque', () => {
  const text = `@import url("{;}.css");
    @media (test: "{;") { [data-label="}"] /* { ; */ { --value: fn(a;b); } }
    .last { color: blue; }`;
  assert.deepEqual(
    servedRulesOf(text, []).map((r) => r.key),
    ['@media (test: "{;") > [data-label="}"] /* { ; */', '.last'],
  );
});

test('significant whitespace in strings and escaped identifiers survives keys and hashes', () => {
  const rule = (css) => servedRulesOf(css, [])[0];
  assert.notEqual(
    rule('.a { content: "a  b"; white-space: pre; }').hash,
    rule('.a { content: "a b"; white-space: pre; }').hash,
  );
  assert.notEqual(rule('[data-label="a  b"] { color: red; }').key, rule('[data-label="a b"] { color: red; }').key);
  assert.notEqual(rule(String.raw`.a\  b { color: red; }`).key, rule(String.raw`.a\ b { color: red; }`).key);
  assert.notEqual(rule(String.raw`.a { content: "\31  2"; }`).hash, rule(String.raw`.a { content: "\31 2"; }`).hash);
});

test('nested CSS fails with unknown reach even when the outer rule matched', () => {
  for (const text of [
    '.panel { color: red; &.fault { color: blue; } }',
    '.panel { &:hover { color: blue; } }',
    '.panel { div { color: blue; } }',
    '.panel { @media (width > 1px) { color: blue; } }',
  ]) {
    assert.throws(() => servedRulesOf(text, used(text, text)), /served CSS reach is unknown/, text);
  }
});

test('malformed component values fail instead of producing partial evidence', () => {
  for (const text of ['.a { --x: fn(; }', '[data-label="x" { color: red; }', '.a { color: red; }}']) {
    assert.throws(() => servedRulesOf(text, []), /served CSS reach is unknown/, text);
  }
});

test('custom property digests include complete strings and balanced component values', () => {
  for (const [before, after] of [
    ['"a;b"', '"a;c"'],
    ['fn(a;b)', 'fn(a;c)'],
    ['{ x: a; y: b; }', '{ x: a; y: c; }'],
    [String.raw`"a\";b"`, String.raw`"a\";c"`],
    ['"a  b"', '"a b"'],
  ]) {
    const [left] = servedRulesOf(`:root { --label: ${before}; --other: yes; }`, []);
    const [right] = servedRulesOf(`:root { --label: ${after}; --other: yes; }`, []);
    assert.notEqual(left.vars['--label'], right.vars['--label'], `${before} versus ${after}`);
    assert.equal(left.vars['--other'], right.vars['--other']);
  }
});

test('font references preserve complete quoted and unquoted family names', () => {
  const [rule] = servedRulesOf('.title { font-family: "Brand  Sans", Foo Bar, "Semi;Comma,Font", sans-serif; }', []);
  assert.deepEqual(rule.refs, ['Brand  Sans', 'Foo Bar', 'Semi;Comma,Font', 'sans-serif']);
});

test('unsupported escaped font dependencies and shorthands fail with unknown reach', () => {
  for (const declaration of [
    String.raw`font-family: Brand\ Sans`,
    String.raw`font-family: "Brand\22 Sans"`,
    'font: italic 16px "Brand Sans"',
    'font-family: var(--family)',
  ]) {
    assert.throws(() => servedRulesOf(`.title { ${declaration}; }`, []), /served CSS reach is unknown/, declaration);
  }
});

async function trackedLedger(sheets) {
  let added;
  const client = {
    on: (event, listener) => {
      if (event === 'CSS.styleSheetAdded') added = listener;
    },
    send: async (command, params) => {
      if (command === 'CSS.enable') {
        for (const sheet of sheets) {
          added({ header: { origin: 'regular', isInline: true, sourceURL: '', ...sheet } });
        }
      }
      if (command === 'CSS.getStyleSheetText') return sheets.find((s) => s.styleSheetId === params.styleSheetId);
      if (command === 'CSS.stopRuleUsageTracking') {
        return {
          ruleUsage: sheets.flatMap((s) =>
            s.used ? [{ styleSheetId: s.styleSheetId, used: true, startOffset: 0, endOffset: s.text.length }] : [],
          ),
        };
      }
      return {};
    },
    detach: async () => {},
  };
  const tracker = await trackServedRules({ context: () => ({ newCDPSession: async () => client }) });
  try {
    await tracker.start();
    return await tracker.stop([]);
  } finally {
    await tracker.dispose();
  }
}

test('sheet discovery order cannot move usage between repeated rule keys', async () => {
  const sheets = [
    { styleSheetId: 'one', text: '.a { color: red; }', used: true },
    { styleSheetId: 'two', text: '.a { color: blue; }' },
  ];
  const first = await trackedLedger(sheets);
  assert.deepEqual(first, await trackedLedger([...sheets].reverse()));
  assert.equal(first.rules.filter((r) => r.used).length, 1);
  assert.equal(first.version, 2);
});

test('identical sheet labels and text fail as ambiguous in either discovery order', async () => {
  const sheets = [
    { styleSheetId: 'one', text: '.a { color: red; }', used: true },
    { styleSheetId: 'two', text: '.a { color: red; }' },
  ];
  for (const order of [sheets, [...sheets].reverse()]) {
    await assert.rejects(trackedLedger(order), /served CSS reach is unknown: ambiguous identical stylesheets/);
  }
});

test('reach self-check rejects ledger drift and missing evidence with unchanged styles', () => {
  const reach = { sheets: ['inline'], rules: [{ sheet: 0, key: '.a', hash: 'abc', used: true }] };
  const first = { elements: [], reach };
  assert.doesNotThrow(() => assertDeterministicReach(first, structuredClone(first), 'home'));
  for (const changed of [
    undefined,
    { ...reach, rules: [{ ...reach.rules[0], used: undefined }] },
    { ...reach, rules: [{ ...reach.rules[0], hash: 'def' }] },
    { ...reach, sheets: ['constructed'] },
    { ...reach, unreadable: 1 },
  ]) {
    assert.throws(
      () => assertDeterministicReach(first, { elements: [], reach: changed }, 'home'),
      /self-check failed: home is non-deterministic.*reach/,
    );
  }
  assert.throws(() => assertDeterministicReach({ elements: [] }, { elements: [] }, 'home'), /reach.*missing/);
});
