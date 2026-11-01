import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import * as reach from '../dist/capture/reach.js';
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

test('escaped function names fail with unknown reach in reads, aliases and fallbacks', () => {
  for (const reference of [
    String.raw`v\61r(--warn)`,
    String.raw`\76 ar(--warn)`,
    String.raw`v\61\72(--warn)`,
    String.raw`va\r(--warn)`,
    String.raw`\000076\000061\000072(--warn)`,
  ]) {
    for (const declaration of [`color: ${reference}`, `--tone: ${reference}`, `color: var(--tone, ${reference})`]) {
      assert.throws(
        () => servedRulesOf(`.a { ${declaration}; }`, []),
        /served CSS reach is unknown: unsupported var\(\) reference/,
        declaration,
      );
    }
  }
});

test('an escaped function in an idle consumer fails capture instead of hiding reach', async () => {
  const text = String.raw`:root { --warn: red; }
    .theme { color: var(--warn); }
    .hidden { color: v\61r(--warn); }`;
  assert.throws(
    () => servedRulesOf(text, used(text, ':root', '.theme')),
    /served CSS reach is unknown: unsupported var\(\) reference/,
  );
  await assert.rejects(
    trackedLedger([{ styleSheetId: 'one', text }]),
    /served CSS reach is unknown: unsupported var\(\) reference/,
  );
});

test('escaped text outside function names stays opaque to var() reads', () => {
  const [rule] = servedRulesOf(
    String.raw`.a { content: "v\61r(--quoted)"; /* v\61r(--commented) */
      --label: pla\69n; --tone: var(--warn); color: var(--tone); }`,
    [],
  );
  assert.deepEqual(rule.uses, ['--warn', '--tone']);
  assert.deepEqual(rule.aliases, { '--tone': ['--warn'] });
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

test('font shorthands and function values resolve candidate names', () => {
  for (const [declaration, name] of [
    ['font: inherit', 'inherit'],
    ['font: 16px --weird', '--weird'],
    ['font-family: /*a*/ --weird', '--weird'],
    ['animation: --x 1s steps(2)', '--x'],
    ['animation: --x 1s', '--x'],
    ['animation-name: --x', '--x'],
    ['font: 700 16px/normal Brand Sans', 'Brand Sans'],
    ['font: bold Brand Sans', 'Brand Sans'],
    ['font: italic 700 16px/1.5 "Brand Sans", serif', 'Brand Sans'],
    ['font: 16px Brand Sans, serif', 'Brand Sans'],
    ['font: 700 clamp(28px, 4vw, 46px)/1 "Brand Sans"', 'Brand Sans'],
    ['font-family: /* x */ "Brand Sans"', 'Brand Sans'],
    ['animation: pulse 1s cubic-bezier(.4, 0, .2, 1) infinite', 'pulse'],
    ['animation: pulse 1s steps(4, jump-end)', 'pulse'],
  ]) {
    assert.ok(servedRulesOf(`.t { ${declaration}; }`, [])[0].refs.includes(name), declaration);
  }
});

test('unsupported escaped and substituted dependencies fail with unknown reach', () => {
  for (const declaration of [
    String.raw`font-family: Brand\ Sans`,
    String.raw`font-family: "Brand\22 Sans"`,
    'font-family: env(x)',
    'font-family: attr(x)',
    'font-family: inherit(--x)',
    'font-family: --brand()',
    'font: 16px --brand()',
    'animation: --spin() 1s',
    'animation-name: --spin(1)',
    'font-family: ident("Brand" "Sans")',
    'animation: pulse calc(1s * env(x))',
    'animation: var(--motion)',
    'animation-name: "pulse"',
  ]) {
    assert.throws(() => servedRulesOf(`.title { ${declaration}; }`, []), /served CSS reach is unknown/, declaration);
  }
});

async function trackedLedger(sheets, opts = {}) {
  let added;
  const client = {
    on: (event, listener) => {
      if (event === 'CSS.styleSheetAdded') added = listener;
    },
    send: async (command, params) => {
      if (command === 'CSS.enable') {
        for (const sheet of sheets) {
          added({ header: { origin: 'regular', isInline: true, sourceURL: '', frameId: 'main', ...sheet } });
        }
      }
      if (command === 'CSS.getMatchedStylesForNode') {
        if (opts.registrationFails) throw new Error('registrations unavailable');
        return { cssPropertyRegistrations: opts.registrations ?? [], cssPropertyRules: opts.propertyRules ?? [] };
      }
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (command === 'DOM.getDocument') {
        return { root: opts.document ?? { children: opts.shadow ? [{ shadowRoots: [{}] }] : [] } };
      }
      if (command === 'DOM.resolveNode' && opts.inlineRoots?.includes(params.backendNodeId)) {
        opts.onInlineResolve?.(params.backendNodeId);
        if (opts.inlineResolveFails) throw new Error('inline root unavailable');
        return { object: opts.inlineMissingObject ? {} : { objectId: `inline-${params.backendNodeId}` } };
      }
      if (command === 'Runtime.callFunctionOn' && params.objectId.startsWith('inline-')) {
        opts.onInlineCall?.(params);
        if (opts.inlineCallFails) throw new Error('inline root detached');
        return opts.inlineResponse ?? { result: { value: { names: [], reader: false, count: 1 } } };
      }
      if (command === 'DOM.resolveNode') {
        const sheet = sheets.find((s) => s.ownerNode === params.backendNodeId);
        if (sheet.resolveFails) throw new Error('owner unavailable');
        return { object: { objectId: sheet.styleSheetId } };
      }
      if (command === 'Runtime.callFunctionOn') {
        const sheet = sheets.find((s) => s.styleSheetId === params.objectId);
        if (sheet.callFails) throw new Error('owner detached');
        return { result: { value: sheet.inDocument ?? true } };
      }
      if (command === 'CSS.getStyleSheetText') {
        opts.onRead?.();
        return sheets.find((s) => s.styleSheetId === params.styleSheetId);
      }
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
  const tracker = await trackServedRules({
    context: () => ({ newCDPSession: async () => client }),
    evaluate: async (fn, input) => {
      if (opts.evaluate) return opts.evaluate(fn, input);
      return {
        fingerprint: opts.prints ? opts.prints.shift() : 'dom',
        matched: input?.probes.map((p) => p !== null && (opts.inScope ?? (() => true))(p)) ?? [],
      };
    },
  });
  try {
    await tracker.start();
    return await tracker.stop([], opts.compared ?? ['html']);
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

test('browser-owned details sheets are excluded in either discovery order', async () => {
  const sheets = [
    { styleSheetId: 'ua1', text: ':host summary { display: list-item; }', ownerNode: 7 },
    { styleSheetId: 'ua2', text: ':host summary { display: list-item; }', ownerNode: 8 },
    { styleSheetId: 'app', text: '.a { color: red; }', used: true },
  ];
  const document = {
    children: [7, 8].map((backendNodeId) => ({
      shadowRoots: [{ shadowRootType: 'user-agent', children: [{ backendNodeId }] }],
    })),
  };
  const first = await trackedLedger(sheets, { document });
  assert.deepEqual(first, await trackedLedger([...sheets].reverse(), { document }));
  assert.deepEqual(first.sheets, ['inline']);
  assert.equal(
    first.rules.some((r) => r.key.includes(':host')),
    false,
  );
});

test('author light-DOM sheets on a user-agent shadow host remain in the ledger', async () => {
  const ledger = await trackedLedger(
    [
      { styleSheetId: 'author', text: '.author { color: red; }', ownerNode: 9 },
      { styleSheetId: 'ua', text: ':host summary { display: list-item; }', ownerNode: 7 },
    ],
    {
      document: {
        backendNodeId: 1,
        children: [{ backendNodeId: 9 }],
        shadowRoots: [{ shadowRootType: 'user-agent', children: [{ backendNodeId: 7 }] }],
      },
    },
  );
  assert.deepEqual(ledger.sheets, ['inline']);
  assert.deepEqual(
    ledger.rules.map((r) => r.key),
    ['.author'],
  );
});

test('author shadow sheets duplicating document sheets remain ambiguous', async () => {
  await assert.rejects(
    trackedLedger(
      [
        { styleSheetId: 'document', text: '.a { color: red; }' },
        { styleSheetId: 'shadow', text: '.a { color: red; }', ownerNode: 7 },
      ],
      { document: { shadowRoots: [{ shadowRootType: 'open', children: [{ backendNodeId: 7 }] }] } },
    ),
    /ambiguous identical stylesheets/,
  );
});

test('reach self-check rejects ledger drift and missing evidence with unchanged styles', () => {
  const reach = { sheets: ['inline'], rules: [{ sheet: 0, key: '.a', hash: 'abc', used: true }] };
  const first = { elements: [], reach };
  assert.doesNotThrow(() => assertDeterministicReach(first, structuredClone(first), 'home'));
  for (const changed of [
    undefined,
    { ...reach, rules: [{ ...reach.rules[0], used: undefined }] },
    { ...reach, rules: [{ ...reach.rules[0], used: undefined, outside: true }] },
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

for (const [selector, expected, chain = []] of [
  ['.link:hover', '.link'],
  ['.a::after', '.a'],
  ['.a ::before', '.a *'],
  ['.a /* comment */::before', '.a /* comment */*'],
  ['.a/* comment */::before', '.a/* comment */'],
  [':host-context(.on)', undefined],
  [':hover', '*'],
  [':not(:hover)', ':not(*)'],
  ['a[title=":hover"]', 'a[title=":hover"]'],
  [String.raw`[title="a\":hover"]:focus`, String.raw`[title="a\":hover"]`],
  [String.raw`.escaped\:hover`, String.raw`.escaped\:hover`],
  ['[data-name="::part(title)"]:active', '[data-name="::part(title)"]'],
  ['.a:focus-visible:focus-within:focus:active', '.a'],
  ['.a:hovering', undefined],
  [String.raw`.a::be\66 ore`, undefined],
  [String.raw`.a:hove\72`, undefined],
  ['.a::beforeé', undefined],
  ['.a:hoveré', undefined],
  ['.a:before, .b:after, .c:first-line, .d:first-letter', '.a, .b, .c, .d'],
  ['.a::cue(:is(.b, .c))', undefined],
  ['.a::selection', undefined],
  ['.a::-webkit-scrollbar', undefined],
  ['.a::highlight(x)', undefined],
  ['::view-transition-old(root)', undefined],
  ['.a::before-ish', undefined],
  ['.a::selection, .b::before', undefined],
  ['.a::marker', '.a'],
  ['.a::placeholder', '.a'],
  ['dialog::backdrop', 'dialog'],
  ['input::file-selector-button', 'input'],
  ['.a::first-line', '.a'],
  ['.a ::marker', '.a *'],
  ['.a > :hover + ::before', '.a > * + *'],
  ['x-card::part(title)', undefined],
  [':host(.on)', undefined],
  ['::slotted(p)', undefined],
  ['.c', undefined, ['@scope (.card)']],
  ['.c', undefined, ['@container (min-width: 500px)']],
  ['@page', undefined],
  // State the DOM fingerprint does not track cannot be attributed.
  ['.field:invalid', undefined],
  ['.a:valid', undefined],
  ['.a:user-invalid', undefined],
  ['input:indeterminate', undefined],
  ['.a:popover-open', undefined],
  ['details:open', undefined],
  ['dialog:modal', undefined],
  ['x-el:defined', undefined],
  ['input:autofill', undefined],
  ['.a:dir(rtl)', undefined],
  ['.a:state(x)', undefined],
  ['a:visited', undefined],
  ['.a:read-only', undefined],
  [':is(.a:invalid)', undefined],
  ['.a:has(:invalid)', undefined],
  [':nth-child(2 of .a:invalid)', undefined],
  ['.a, .b:invalid', undefined],
  // Chained pseudo-elements and anything after a pseudo-element are never read.
  ['.item::before::marker', undefined],
  ['.a:before::marker', undefined],
  ['.a::before:hover', undefined],
  ['.a::before .b', undefined],
  // Forced reads only capture ::before, ::after and ::placeholder.
  ['input:hover::file-selector-button', undefined],
  ['.a:focus::first-letter', undefined],
  ['.a:hover:first-line', undefined],
  ['dialog:focus-within::backdrop', undefined],
  ['li:hover::marker', undefined],
  ['.a:hover, input::file-selector-button', undefined],
  ['.a:hover::before', '.a'],
  ['input:focus::placeholder', 'input'],
  ['input:checked + label', 'input:checked + label'],
  ['.a:first-child:not(.b):is(.c)', '.a:first-child:not(.b):is(.c)'],
  ['a:any-link', 'a:any-link'],
  [':lang(en)', ':lang(en)'],
  ['input:placeholder-shown', 'input:placeholder-shown'],
  [':root', ':root'],
  ['li:nth-child(2n+1 of .x)', 'li:nth-child(2n+1 of .x)'],
]) {
  test(`comparedProbe attributes ${selector} within ${chain.join(' > ')}`, () => {
    assert.equal(reach.comparedProbe(selector, chain), expected);
  });
}

const matchedSheet = { styleSheetId: 'one', text: '.a { color: red; }', used: true };

test('tracked ledger marks every matched rule outside when the DOM changes during tracking', async () => {
  for (const [prints, same] of [
    [['before', 'after'], false],
    [['before', 'before'], true],
  ]) {
    const ledger = await trackedLedger(
      [
        { ...matchedSheet, text: '.a { color: red; } .b { color: blue; }' },
        { styleSheetId: 'idle', text: '.idle { color: green; }' },
      ],
      { prints },
    );
    assert.equal(ledger.scope, 'compared');
    for (const rule of ledger.rules.filter((r) => r.key !== '.idle')) {
      assert.equal(rule.used, same ? true : undefined, rule.key);
      assert.equal(rule.outside, same ? undefined : true, rule.key);
    }
    const idle = ledger.rules.find((r) => r.key === '.idle');
    assert.equal(idle.used, undefined);
    assert.equal(idle.outside, undefined);
  }
});

test('DOM changes during stylesheet reads cannot lend usage to a compared element', async () => {
  let fingerprint = 'before';
  const ledger = await trackedLedger([matchedSheet], {
    prints: { shift: () => fingerprint },
    onRead: () => {
      fingerprint = 'after';
    },
  });
  assert.equal(ledger.scope, 'compared');
  assert.equal(ledger.rules[0].used, undefined);
  assert.equal(ledger.rules[0].outside, true);
});

test('serialized DOM fingerprint detects selector state changes while allowing nonempty text updates', () => {
  const element = (tagName) => ({ tagName, attributes: [], childNodes: [], children: [] });
  class HTMLInputElement {
    constructor() {
      Object.assign(this, element('INPUT'), { checked: false, value: '' });
    }
  }
  class HTMLTextAreaElement {
    constructor() {
      Object.assign(this, element('TEXTAREA'), { value: '' });
    }
  }
  const input = new HTMLInputElement();
  const textarea = new HTMLTextAreaElement();
  const option = { ...element('OPTION'), selected: false };
  const attribute = { name: 'class', value: 'before' };
  input.attributes.push(attribute);
  const text = { nodeType: 3, nodeValue: '' };
  const root = { ...element('MAIN'), childNodes: [text], children: [input, textarea, option] };
  const location = { hash: '' };
  const fingerprint = () =>
    runInNewContext(`(${reach.comparedSnapshot.toString()})()`, {
      document: { documentElement: root },
      location,
      Node: { TEXT_NODE: 3 },
      HTMLInputElement,
      HTMLTextAreaElement,
    }).fingerprint;
  const before = fingerprint();
  for (const [target, property, value] of [
    [attribute, 'name', 'id'],
    [attribute, 'value', 'after'],
    [input, 'checked', true],
    [input, 'value', 'filled'],
    [textarea, 'value', 'filled'],
    [option, 'selected', true],
    [root, 'tagName', 'SECTION'],
    [root, 'children', [textarea, input, option]],
    [root, 'children', []],
    [text, 'nodeValue', 'tick'],
    [location, 'hash', '#target'],
  ]) {
    const saved = target[property];
    target[property] = value;
    assert.notEqual(fingerprint(), before, property);
    target[property] = saved;
    assert.equal(fingerprint(), before, `restored ${property}`);
  }
  text.nodeValue = 'tick';
  const nonempty = fingerprint();
  text.nodeValue = 'tock';
  assert.equal(fingerprint(), nonempty);
  text.nodeValue = ' ';
  assert.equal(fingerprint(), nonempty);
});

test('tracked ledger marks uncaptured pseudo-element and unfingerprinted state matches outside compared scope', async () => {
  for (const selector of [
    '.a::selection',
    '.a::-webkit-scrollbar',
    '.a::highlight(x)',
    '.a::cue(:is(.b, .c))',
    '.field:invalid',
    '.item::before::marker',
    'input:hover::file-selector-button',
  ]) {
    const ledger = await trackedLedger([{ ...matchedSheet, text: `${selector} { color: red; }` }]);
    assert.equal(ledger.scope, 'compared');
    assert.equal(ledger.rules[0].used, undefined, selector);
    assert.equal(ledger.rules[0].outside, true, selector);
  }
});

for (const [name, header, opts = {}] of [
  ['child iframe', { frameId: 'child' }],
  ['missing frame', { frameId: undefined }],
  ['shadow style', { ownerNode: 1, inDocument: false }],
  ['unresolved owner', { ownerNode: 1, resolveFails: true }],
  ['detached owner', { ownerNode: 1, callFails: true }],
  ['constructed sheet with a shadow root', { isConstructed: true }, { shadow: true }],
  [
    'constructed sheet with a closed author shadow root',
    { isConstructed: true },
    { document: { children: [{ shadowRoots: [{ shadowRootType: 'closed' }] }] } },
  ],
  [
    'constructed sheet with an author root nested in a user-agent root',
    { isConstructed: true },
    {
      document: {
        children: [
          {
            shadowRoots: [{ shadowRootType: 'user-agent', children: [{ shadowRoots: [{ shadowRootType: 'open' }] }] }],
          },
        ],
      },
    },
  ],
  ['imported sheet with a shadow root', {}, { shadow: true }],
  [
    'constructed sheet with a document owner and a shadow root',
    { isConstructed: true, ownerNode: 1 },
    { shadow: true },
  ],
  ['closed shadow root inside an iframe', {}, { document: { contentDocument: { children: [{ shadowRoots: [{}] }] } } }],
  ['ignored or volatile match', {}, { inScope: () => false }],
]) {
  test(`tracked ledger marks ${name} matches outside compared scope`, async () => {
    const ledger = await trackedLedger([{ ...matchedSheet, ...header }], opts);
    assert.equal(ledger.scope, 'compared');
    assert.equal(ledger.rules[0].used, undefined);
    assert.equal(ledger.rules[0].outside, true);
  });
}

test('tracked ledger keeps compared matches for document and unambiguous constructed sheets', async () => {
  for (const [header, opts] of [
    [{ ownerNode: 1 }, { shadow: true }],
    [{ isConstructed: true }, {}],
    [{ isConstructed: true }, { document: { children: [{ shadowRoots: [{ shadowRootType: 'user-agent' }] }] } }],
    [{}, { document: { children: [{ shadowRoots: [{ shadowRootType: 'user-agent' }] }] } }],
  ]) {
    const ledger = await trackedLedger([{ ...matchedSheet, ...header }], opts);
    assert.equal(ledger.scope, 'compared');
    assert.equal(ledger.rules[0].used, true);
    assert.equal(ledger.rules[0].outside, undefined);
  }
});

test('tracked ledger preserves the selector and chain separately when probing child combinators', async () => {
  const probes = [];
  const ledger = await trackedLedger(
    [{ ...matchedSheet, text: '@media (width > 1px) { .a > .b:hover { color: red; } }' }],
    {
      inScope: (probe) => {
        probes.push(probe);
        return true;
      },
    },
  );
  assert.deepEqual(probes, ['.a > .b']);
  assert.equal(ledger.rules[0].used, true);
});

const snapshotElement = () => ({ tagName: 'HTML', attributes: [], childNodes: [], children: [], closest: () => null });
const evaluateSnapshot = (fn, input, context) =>
  runInNewContext(`(${fn.toString()})(input)`, {
    input,
    location: { hash: '' },
    Node: { TEXT_NODE: 3 },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    ...context,
  });

test('in-page attribution uses only compared capture elements and rejects invalid selectors', async () => {
  const html = snapshotElement(),
    body = snapshotElement(),
    compared = snapshotElement(),
    ignored = snapshotElement(),
    head = snapshotElement();
  const paths = new Map([
    [html, 'html'],
    [body, 'body'],
    [compared, 'measured'],
    [ignored, 'ignored'],
    [head, 'measured'],
  ]);
  const document = {
    documentElement: html,
    body,
    querySelectorAll: (selector) => {
      if (selector === 'body *') return [compared, ignored];
      if (selector === '.invalid') throw new Error('invalid selector');
      return { '.shared': [ignored, compared], '.ignored': [ignored], '.head': [head] }[selector] ?? [];
    },
  };
  const ledger = await trackedLedger(
    [
      {
        ...matchedSheet,
        text: '.shared { color: red; } .ignored { color: red; } .head { color: red; } .invalid { color: red; }',
      },
    ],
    {
      compared: ['html', 'body', 'measured'],
      evaluate: (fn, input) =>
        evaluateSnapshot(fn, input, {
          document,
          window: { __spPathOf: (el) => paths.get(el) },
        }),
    },
  );
  assert.deepEqual(
    ledger.rules.map((r) => [r.key, r.used, r.outside]),
    [
      ['.shared', true, undefined],
      ['.ignored', undefined, true],
      ['.head', undefined, true],
      ['.invalid', undefined, true],
    ],
  );
});

test('in-page attribution fails when path identity is unavailable', async () => {
  await assert.rejects(
    trackedLedger([matchedSheet], {
      evaluate: (fn, input) =>
        evaluateSnapshot(fn, input, { document: { documentElement: snapshotElement() }, window: {} }),
    }),
    /path|__spPathOf/i,
  );
});

test('relaxed state probes cannot borrow usage from excluded elements or negative selector branches', async () => {
  const html = snapshotElement(),
    body = snapshotElement(),
    compared = snapshotElement(),
    ignored = snapshotElement();
  for (const [selector, candidates, reached] of [
    ['.a:hover', [compared, ignored], false],
    ['.a:hover', [compared], true],
    ['.a::before', [compared, ignored], false],
    ['.a:not(:hover), .b:hover', [compared], false],
  ]) {
    const ledger = await trackedLedger([{ ...matchedSheet, text: `${selector} { color: red; }` }], {
      compared: ['measured'],
      evaluate: (fn, input) =>
        evaluateSnapshot(fn, input, {
          window: { __spPathOf: (el) => (el === compared ? 'measured' : 'excluded') },
          document: {
            documentElement: html,
            body,
            querySelectorAll: (probe) => (probe === 'body *' ? [compared, ignored] : candidates),
          },
        }),
    });
    assert.equal(ledger.rules[0].used, reached ? true : undefined, selector);
    assert.equal(ledger.rules[0].outside, reached ? undefined : true, selector);
  }
});

test('relaxed global probes skip permanently ignored candidates but retain eligible outside matches', () => {
  const element = (tagName, ignored = false) => ({
    tagName,
    attributes: [],
    childNodes: [],
    children: [],
    closest: () => (ignored ? {} : null),
  });
  const html = element('HTML');
  const body = element('BODY');
  const div = element('DIV');
  const ignored = ['HEAD', 'TITLE', 'SCRIPT', 'TEMPLATE', 'DIV'].map((tag) => element(tag, true));
  const outside = element('DIV');
  let candidates = [html, body, div, ...ignored];
  const snapshot = () =>
    runInNewContext(`(${reach.comparedSnapshot.toString()})(input)`, {
      input: { probes: ['*', 'div'], exclusive: [true, true], compared: ['HTML', 'BODY', 'DIV'] },
      document: { documentElement: html, body, querySelectorAll: () => candidates },
      window: { __spPathOf: (el) => (el === outside ? 'outside' : el.tagName) },
      location: { hash: '' },
      Node: { TEXT_NODE: 3 },
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
    });
  assert.deepEqual(Array.from(snapshot().matched), [true, true]);
  candidates = [...candidates, outside];
  assert.deepEqual(Array.from(snapshot().matched), [false, false]);
});

test('font variables union aliases, fallbacks, registrations and cycles', () => {
  const rules = servedRulesOf(
    `
    :root { --brand: "Brand Sans", serif; --alias: var(--brand); --a: var(--b); --b: var(--a), "Cycle Face"; }
    .t { font-family: var(--alias); }
    .h { font: 700 15px var(--missing, "Fallback Face"); }
    @property --reg { syntax: '*'; inherits: true; initial-value: "Init Face"; }
    .r { font-family: var(--reg); }
    .c { font-family: var(--a); }
    .missing { font-family: var(--undeclared); }
  `,
    [],
  );
  for (const [key, name] of [
    ['.t', 'Brand Sans'],
    ['.h', 'Fallback Face'],
    ['.r', 'Init Face'],
    ['.c', 'Cycle Face'],
  ]) {
    assert.ok(rules.find((r) => r.key === key).refs.includes(name));
  }
  assert.ok(!rules.find((r) => r.key === '.missing').refs?.includes('Brand Sans'));
});

test('font variables resolve across sheets in either discovery order as a pure union', async () => {
  const sheets = [
    {
      styleSheetId: 'one',
      text: ':root { --brand: "Brand Sans"; --alias: var(--brand); } .other { --brand: "Other Face"; }',
    },
    { styleSheetId: 'two', text: '.t { font-family: var(--alias); }', used: true },
  ];
  const first = await trackedLedger(sheets);
  assert.deepEqual(first, await trackedLedger([...sheets].reverse()));
  const refs = first.rules.find((r) => r.key === '.t').refs;
  assert.ok(refs.includes('Brand Sans'));
  assert.ok(refs.includes('Other Face'));
});

test('font variables include JS registration initial values', async () => {
  const ledger = await trackedLedger([{ styleSheetId: 'one', text: '.j { font-family: var(--reg2); }' }], {
    document: { children: [{ nodeName: 'HTML', nodeId: 2 }] },
    registrations: [{ propertyName: '--reg2', initialValue: { text: '"JS Face"' } }],
  });
  assert.ok(ledger.rules[0].refs.includes('JS Face'));
});

test('font variable sources that cannot be enumerated fail closed', async () => {
  const sheets = [{ styleSheetId: 'one', text: ':root { --alias: var(--brand); } .t { font-family: var(--alias); }' }];
  for (const opts of [{ registrationFails: true }])
    await assert.rejects(trackedLedger(sheets, opts), /served CSS reach is unknown/);
  await assert.rejects(trackedLedger(sheets.map((s) => ({ ...s, frameId: 'child' }))), /served CSS reach is unknown/);
  for (const value of ['env(x)', 'attr(x)', 'inherit(--x)', 'ident("X")', '--name()', String.raw`Brand\ Sans`]) {
    assert.throws(
      () => servedRulesOf(`:root { --x: ${value}; } .t { font-family: var(--x); }`, []),
      /served CSS reach is unknown/,
    );
  }
});

for (const value of [
  'Brand var(--suffix)',
  'var(--a) Sans',
  'var(--a)var(--b)',
  '"Brand" var(--x)',
  'Brand var(--e) Sans',
  'var(--a, var(--b) Sans)',
  'italic var(--x)',
  '15px/var(--lh) Inter',
  'Brand/**/var(--x)',
  '700 var(--size) var(--fam)',
]) {
  test(`font substitution adjacency fails closed: ${value}`, () => {
    assert.throws(
      () => servedRulesOf(`:root { --e:; } .t { font-family: ${value}; }`, []),
      /served CSS reach is unknown/,
    );
  });
}
test('font substitution adjacency in closure values fails closed', () => {
  assert.throws(
    () => servedRulesOf(':root { --f: Brand var(--s); } .t { font: var(--f); }', []),
    /served CSS reach is unknown/,
  );
});
for (const value of [
  '700 15px var(--fam)',
  'var(--a), Serif',
  'var(--a, Brand)',
  'var(--a, var(--b))',
  'calc(var(--w)) 15px Brand',
  'var(--f)',
]) {
  test(`separated font substitutions resolve: ${value}`, () => {
    const refs = servedRulesOf(
      `:root { --a: Brand Sans, Mono; --fam: Brand; --f: 700 15px Brand; } .t { font: ${value}; }`,
      [],
    ).find((r) => r.key === '.t').refs;
    for (const name of value.includes('--a')
      ? ['Brand Sans', ...(value.includes('Serif') ? ['Serif'] : []), ...(value.includes(', Brand') ? ['Brand'] : [])]
      : ['Brand'])
      assert.ok(refs.includes(name), name);
  });
}
test('property initial font values accept uppercase at-rules and reject escaped names', () => {
  const rules = servedRulesOf(
    '@PROPERTY --f { syntax:"*"; inherits:true; initial-value: Brand } p { font-family: var(--f) }',
    [],
  );
  assert.ok(rules.find((r) => r.key === 'p').refs.includes('Brand'));
});
test('escaped property registration names fail closed', () => {
  assert.throws(
    () =>
      servedRulesOf(
        String.raw`@property --\66 { syntax:"*"; inherits:true; initial-value: Brand } p { font-family: var(--f) }`,
        [],
      ),
    /reach is unknown/,
  );
});
test('nested and keyframe custom values join the font union', () => {
  const rules = servedRulesOf(
    '@layer theme { @media all { :root { --f: Layer; } } } @keyframes pulse { to { --f: Frame; } } p { font-family: var(--f); }',
    [],
  );
  const refs = rules.find((r) => r.key === 'p').refs;
  assert.ok(refs.includes('Layer'));
  assert.ok(refs.includes('Frame'));
});
test('CDP property rules also supply initial font values', async () => {
  const ledger = await trackedLedger([{ styleSheetId: 'app', text: 'p { font-family: var(--f); }' }], {
    propertyRules: [
      { propertyName: { text: '--f' }, style: { cssProperties: [{ name: 'initial-value', value: 'Brand' }] } },
    ],
  });
  assert.ok(ledger.rules[0].refs.includes('Brand'));
});

for (const [value, declarations, names] of [
  ['15px/var(--lh) Inter', '--lh:1.5', ['Inter']],
  ['15px/var(--lh) Inter', '--lh:normal', ['Inter']],
  ['15px/var(--lh) Inter', '--lh:var(--b);--b:1.4', ['Inter']],
  ['italic var(--x)', '--x:15px Brand', ['Brand']],
  ['italic var(--x)', '--x:Sans', ['Sans']],
  ['var(--w) 15px Brand Sans', '--w:bold', ['Brand Sans']],
  ['var(--w) 15px Brand Sans', '--w:600', ['Brand Sans']],
  ['Brand var(--x)', '--x:15px Sans', ['Sans']],
  ['var(--a) var(--b)', '--a:italic;--b:15px Brand', ['Brand']],
  ['var(--a) var(--b)', '--a:15px;--b:Brand', ['Brand']],
  ['700 var(--fs) Inter', '--fs:15px', ['Inter']],
  ['600 var(--fs) var(--ff)', '--fs:15px;--ff:Inter', ['Inter']],
  ['var(--fs)/var(--lh) var(--ff)', '--fs:15px;--lh:normal;--ff:Inter', ['Inter']],
])
  test(`shorthand slots resolve ${value} with ${declarations}`, () => {
    const refs = servedRulesOf(`:root{${declarations}} .t{font:${value}}`, []).find((r) => r.key === '.t').refs;
    for (const name of names) assert.ok(refs.includes(name), name);
  });
for (const [value, declarations] of [
  ['15px/var(--lh) Inter', '--lh:1 Brand'],
  ['15px/var(--lh) Inter', '--lh:var(--a);--a:1 Brand'],
  ['italic var(--x) Sans', '--x:15px Brand'],
  ['italic var(--x) Sans', '--x:bold;--x:15px Brand'],
  ['15px/var(--lh) Brand var(--x)', '--lh:normal;--x:Sans'],
  ['15px Brand var(--x)', '--x:Sans'],
  ['var(--a) var(--b)', '--a:15px Foo;--b:Bar'],
  ['15px Brand var(--e) Sans', '--e:'],
  ['700 Brand var(--x)', '--x:Sans'],
  ['15px/var(--lh) Inter', '--lh:if(x)'],
  ['var(--font)', '--font:italic var(--x) Sans'],
])
  test(`shorthand family joins remain unknown ${value} with ${declarations}`, () => {
    assert.throws(() => servedRulesOf(`:root{${declarations}} .t{font:${value}}`, []), /reach is unknown/);
  });
test('shorthand exemptions inspect JS registrations', async () => {
  await assert.rejects(
    trackedLedger([{ styleSheetId: 'app', text: '.t{font:italic var(--x) Sans}' }], {
      registrations: [{ propertyName: '--x', initialValue: { text: '15px Brand' } }],
    }),
    /reach is unknown/,
  );
});

const ambiguousFontURL = '.a{background:url(/*)}:root{--f:Other}.z{c:*/)}';
for (const text of [
  String.raw`.i:before{content:"\e900"}.b{background:url(x.png)}`,
  String.raw`.md\:bg-hero{background-image:url(/hero.png)}`,
]) {
  test(`unrelated stylesheet escapes capture: ${text}`, async () => {
    assert.ok(servedRulesOf(text, []).length);
    assert.ok((await trackedLedger([{ styleSheetId: 'app', text }])).rules.length);
  });
}
for (const name of [
  String.raw`u\72l`,
  String.raw`\75rl`,
  String.raw`ur\l`,
  String.raw`\55 rl`,
  String.raw`\000075\000072\00006c `,
]) {
  test(`escaped URL name remains guarded: ${name}`, async () => {
    const text = `.b{background:${name}(x.png)}`;
    assert.throws(() => servedRulesOf(text, []), /reach is unknown/);
    await assert.rejects(trackedLedger([{ styleSheetId: 'app', text }]), /reach is unknown/);
  });
}
test('ambiguous literal URL after an escaped string remains guarded', async () => {
  const text = String.raw`.i:before{content:"\e900"}.b{background:url(a(b);font-family:Other;c:x)}`;
  assert.throws(() => servedRulesOf(text, []), /reach is unknown/);
  await assert.rejects(trackedLedger([{ styleSheetId: 'app', text }]), /reach is unknown/);
});
const urlGuardSource = readFileSync(new URL('../dist/capture/reach.js', import.meta.url), 'utf8').match(
  /function guardAmbiguousURLs\(text\) \{[\s\S]*?\n\}/,
)[0];
const urlGuard = runInNewContext(`(${urlGuardSource})`, {
  unknown: (message) => {
    throw new Error(message);
  },
});
for (const [name, text] of [
  [
    '5 MB mixed sheet',
    Array.from(
      { length: 50000 },
      (_, i) => `.t${i}{background:url(a.png);mask:url(data:image/png;base64,${'a'.repeat(50)})}`,
    ).join(''),
  ],
  ['unterminated million-character URL', 'url(' + 'a'.repeat(1000000)],
  ['million-character ident', 'a'.repeat(1000000)],
]) {
  test(`URL guard stays linear: ${name}`, () => {
    urlGuard(text);
    const start = performance.now();
    urlGuard(text);
    assert.ok(performance.now() - start < 250, `${name} exceeded 250 ms`);
  });
}

for (const [value, hash] of [
  ['url(a.png)', '8247683fb51f31cc'],
  ['URL(a.png)', 'f6d888e9e660e567'],
  ['url( "x.png")', '4130dd3bfb66a3ec'],
  ["url(\n'x.png')", 'dca1cbc0818f0653'],
  [String.raw`url(a\ b.png)`, '27003efe70f0906b'],
  [String.raw`url(a\(b.png)`, '3d6be189f5e9ed8e'],
  [String.raw`url(a\'b)`, '4d41ac1db06c6276'],
  ['url("data:image/svg+xml,<svg fill=\'rgb(0,0,0)\'/>")', '063d409fc8458cbb'],
  ['url(data:image/png;base64,YQ==)', 'a2e2129ea7616411'],
]) {
  test(`benign URL preserves key and hash: ${value}`, async () => {
    const text = `.t{background:${value};font-family:Other}`;
    const expected = servedRulesOf(text, []);
    assert.equal(expected[0].key, '.t');
    assert.equal(expected[0].hash, hash);
    const ledger = await trackedLedger([{ styleSheetId: 'app', text }]);
    assert.equal(ledger.rules[0].hash, expected[0].hash);
    assert.equal(ledger.rules[0].key, expected[0].key);
  });
}
test('quoted URL comments and imports capture', () => {
  assert.equal(servedRulesOf('/* url(\'x.png\') */ @import url("{;}.css"); .t{color:red}', [])[0].key, '.t');
});
test('ambiguous sheet URLs fail closed when font variables resolve', async () => {
  const text = ambiguousFontURL + ' .t{font-family:var(--f)}';
  assert.throws(() => servedRulesOf(text, []), /reach is unknown/);
  await assert.rejects(trackedLedger([{ styleSheetId: 'app', text }]), /reach is unknown/);
});
test('ambiguous sheet URLs without font variable readers fail closed', async () => {
  assert.throws(() => servedRulesOf(ambiguousFontURL, []), /reach is unknown/);
  await assert.rejects(trackedLedger([{ styleSheetId: 'app', text: ambiguousFontURL }]), /reach is unknown/);
});

for (const text of [
  '.t{background:url(a(b);font-family:Other;c:x)}',
  '.t{background:url(/*);font-family:Other;c:*/)}',
  '.t{--f:Other;background:url(a(b);font-family:var(--f);c:x)}',
  ...[
    String.raw`u\72l(a.png)`,
    String.raw`\75rl(x)`,
    String.raw`U\52L(x)`,
    String.raw`ur\l(x)`,
    String.raw`\55 rl(x)`,
    "url(a'b)",
    'url(a"b)',
    'url(a b(c);x)',
    String.raw`url(a\)(b)`,
    "url(\u00a0'x')",
    'url(\v"x")',
  ].map((url) => `.t{background:${url}}`),
  "/* url(it's) */ .t{color:red}",
]) {
  test(`ambiguous stylesheet URL fails closed: ${JSON.stringify(text)}`, async () => {
    assert.throws(() => servedRulesOf(text, []), /reach is unknown/);
    await assert.rejects(trackedLedger([{ styleSheetId: 'app', text }]), /reach is unknown/);
  });
}

test('quoted stylesheet URL after whitespace resolves beside a font variable reader', () => {
  const rules = servedRulesOf(':root{--f:Brand} .t{font-family:var(--f);background:url( "x.png")}', []);
  assert.ok(rules.find((r) => r.key === '.t').refs.includes('Brand'));
});

const inlineDocument = {
  backendNodeId: 100,
  nodeName: '#document',
  children: [{ attributes: ['style', ''], backendNodeId: 101 }],
};
const inlineSheet = [{ styleSheetId: 'app', text: ':root{--brand:Brand}.t{font-family:var(--brand)}' }];
for (const [names, reader, rejects] of [
  [[], true, true],
  [['--brand'], false, true],
  [['--brand-extra'], false, false],
]) {
  test(`parsed inline dependency names=${names} reader=${reader}`, async () => {
    const result = trackedLedger(inlineSheet, {
      document: inlineDocument,
      inlineRoots: [100],
      inlineResponse: { result: { value: { names, reader, count: 1 } } },
    });
    if (rejects) await assert.rejects(result, /reach is unknown/);
    else await result;
  });
}
for (const opts of [
  { inlineResolveFails: true },
  { inlineCallFails: true },
  { inlineMissingObject: true },
  {
    inlineResponse: { exceptionDetails: { text: 'failed' }, result: { value: { names: [], reader: false, count: 1 } } },
  },
  { inlineResponse: { result: { objectId: 'not-by-value' } } },
  { inlineResponse: { result: { value: { names: [], reader: false, count: 2 } } } },
])
  test(`parsed inline CDP failures fail closed ${JSON.stringify(opts)}`, async () => {
    await assert.rejects(
      trackedLedger(inlineSheet, { document: inlineDocument, inlineRoots: [100], ...opts }),
      /reach is unknown/,
    );
  });
test('parsed inline styles read closed shadow and iframe roots separately', async () => {
  const calls = [];
  const document = {
    backendNodeId: 100,
    children: [
      { shadowRoots: [{ backendNodeId: 200, shadowRootType: 'closed', children: [{ attributes: ['style', ''] }] }] },
      { contentDocument: { backendNodeId: 300, children: [{ attributes: ['style', ''] }] } },
    ],
  };
  await trackedLedger(inlineSheet, { document, inlineRoots: [200, 300], onInlineResolve: (id) => calls.push(id) });
  assert.deepEqual(calls, [200, 300]);
});
test('no styled nodes require no inline CDP calls', async () => {
  const calls = [];
  await trackedLedger(inlineSheet, {
    document: { backendNodeId: 100, children: [] },
    inlineRoots: [100],
    onInlineResolve: (id) => calls.push(id),
  });
  assert.deepEqual(calls, []);
});

test('non-ASCII escaped URL names preserve identifier boundaries', () => {
  for (const value of [String.raw`é \75rl(x.png)`, String.raw`\e9  \75rl(x.png)`]) {
    const css = `.t{list-style:${value}}`;
    assert.throws(() => urlGuard(css), /^Error: ambiguous unquoted URL dependency$/);
    assert.throws(() => servedRulesOf(css, []), /reach is unknown: ambiguous unquoted URL dependency$/);
  }
  for (const value of [
    String.raw`é\75rl(`,
    String.raw`\e9 \75rl(`,
    String.raw`\75rl\e9(`,
    String.raw`\ff55\ff52\ff4c(`,
    '\u00a0\\75rl(',
  ]) {
    assert.doesNotThrow(() => urlGuard(`.t{list-style:${value}}`));
  }
  assert.throws(
    () => servedRulesOf('.t{list-style:\u00a0\\75rl(x.png)}', []),
    /reach is unknown: unsupported var\(\) reference$/,
  );
});
