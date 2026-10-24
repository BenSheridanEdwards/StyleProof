import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servedRulesOf, trackServedRules } from '../dist/capture/reach.js';
import { assertDeterministicReach } from '../dist/runner/self-check.js';
import { changedRules, cssReach, servedRules } from '../bench/reach-joins.mjs';

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
  assert.deepEqual(title.refs, ['Brand Sans', 'sans-serif']);
  assert.equal(keyframes.key, '@keyframes pulse');
  assert.equal(keyframes.used, undefined);
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

const benchSheet = (url, text, ...selectors) => ({
  url,
  text,
  ranges: selectors.map((selector) => {
    const start = text.indexOf(selector);
    assert.notEqual(start, -1);
    return { start, end: start + selector.length };
  }),
});

test('bench J1 checks removed and renamed custom properties against idle consumers', () => {
  const base = servedRules([benchSheet('app.css', ':root { --warn: red; } .fault { color: var(--warn); }', ':root')]);
  for (const declaration of ['color: black;', '--renamed: red;']) {
    const head = servedRules([
      benchSheet('app.css', `:root { ${declaration} } .fault { color: var(--warn); }`, ':root'),
    ]);
    const change = changedRules(base, head)[0];
    const verdict = cssReach(change.rule, head, change.before);
    assert.equal(verdict.status, 'never-rendered');
    assert.match(verdict.why, /--warn/);
  }
});

test('bench J1 follows aliases across sheets and within the changed rule', () => {
  for (const aliases of [
    ['--middle: var( --warn ); --tone: var(--middle);', ''],
    ['', ':root { --middle: var( --warn ); --tone: var(--middle); }'],
  ]) {
    const catalog = (value, rendered) =>
      servedRules([
        benchSheet('tokens.css', `:root { --warn: ${value}; ${aliases[0]} }`, ':root'),
        benchSheet(
          'app.css',
          `${aliases[1]} .fault { color: var(--tone); } .healthy { color: var(--tone-extra); }`,
          ...rendered,
        ),
      ]);
    const base = catalog('red', aliases[1] ? [':root'] : []);
    for (const rendered of [[':root'], [':root', '.fault']]) {
      // The first variant has its aliases in tokens.css, so app.css has no :root.
      const selectors = aliases[1] ? rendered : rendered.filter((s) => s !== ':root');
      const head = catalog('blue', selectors);
      const change = changedRules(base, head)[0];
      assert.equal(
        cssReach(change.rule, head, change.before).status,
        rendered.includes('.fault') ? 'reached' : 'never-rendered',
      );
    }
  }
});

test('bench J1 flags missing consumers and cyclic aliases instead of claiming reach', () => {
  for (const aliases of ['', '--tone: var(--warn);', '--tone: var(--warn); --warn: var(--tone);']) {
    const base = servedRules([benchSheet('app.css', ':root { --warn: red; }', ':root')]);
    const head = servedRules([benchSheet('app.css', `:root { --warn: blue; ${aliases} }`, ':root')]);
    const change = changedRules(base, head)[0];
    assert.equal(cssReach(change.rule, head, change.before).status, 'never-rendered');
  }
});

test('bench catalogs retain a later sheet change and its own usage in either discovery order', () => {
  const first = benchSheet('first.css', '.a { color: red; }', '.a');
  const second = benchSheet('second.css', '.a { color: blue; } .a { padding: 1px; }');
  const changed = benchSheet('second.css', '.a { color: green; } .a { padding: 2px; }');
  const base = servedRules([first, second]);
  const head = servedRules([first, changed]);
  assert.deepEqual(base, servedRules([second, first]));
  assert.deepEqual(head, servedRules([changed, first]));
  assert.equal(head.rules.length, 3);
  const changes = changedRules(base, head);
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((c) => [c.rule.sheet, c.rule.ordinal]),
    [
      ['second.css', 0],
      ['second.css', 1],
    ],
  );
  for (const change of changes) assert.equal(cssReach(change.rule, head, change.before).status, 'never-rendered');
});

test('bench catalogs merge repeated captures without borrowing usage from another sheet or ordinal', () => {
  const text = '.a { color: red; } .a { color: blue; }';
  const entries = [
    { ...benchSheet('first.css', text), capture: 0 },
    { ...benchSheet('first.css', text, '.a { color: blue; }'), capture: 1 },
    { ...benchSheet('second.css', text), capture: 0 },
  ];
  const catalog = servedRules(entries);
  assert.deepEqual(catalog, servedRules([...entries].reverse()));
  assert.equal(catalog.rules.length, 4);
  assert.deepEqual(
    catalog.rules.filter((r) => catalog.used.has(r.key)).map((r) => [r.sheet, r.ordinal]),
    [['first.css', 1]],
  );
  assert.deepEqual(changedRules(catalog, servedRules([...entries].reverse())), []);
  const withOtherRule = servedRules([benchSheet('first.css', `.other { margin: 0; } ${text}`)]);
  const withoutOtherRule = servedRules([benchSheet('first.css', text)]);
  const removals = changedRules(withOtherRule, withoutOtherRule);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].side, 'base');
  assert.equal(removals[0].rule.selector, '.other');
});

test('bench catalogs reject missing identities, duplicate sheets and conflicting capture text', () => {
  const entry = benchSheet('app.css', '.a { color: red; }', '.a');
  assert.throws(() => servedRules([{ ...entry, url: '' }]), /stylesheet identity/);
  for (const entries of [
    [entry, entry],
    [entry, benchSheet('app.css', '.a { color: blue; }')],
    [
      { ...entry, capture: 0 },
      { ...benchSheet('app.css', '.a { color: blue; }'), capture: 1 },
    ],
  ]) {
    for (const order of [entries, [...entries].reverse()]) {
      assert.throws(() => servedRules(order), /ambiguous stylesheet/);
    }
  }
});
