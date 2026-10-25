import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

// Execute the actual corpus module with I/O substitutes: no browser, git or files.
// The production classifier and join helpers still decide the CSS results.
async function corpusProbe(mode, rootUrl) {
  const { readFileSync } = await import('node:fs');
  const { SourceTextModule, SyntheticModule } = await import('node:vm');
  const { pathToFileURL } = await import('node:url');
  const joins = await import(new URL('bench/reach-joins.mjs', rootUrl));
  const classifier = await import(new URL('dist/rule-reach.js', rootUrl));
  const source = new URL('bench/reach-corpus.mjs', rootUrl);
  const corpus = {
    fixture: 'fixture',
    surfaces: { home: { width: 800, query: '', colorScheme: 'light' } },
    scenarios: { declared: ['home'], complete: ['home'] },
    cases: [
      {
        id: 'probe',
        category: 'css',
        desc: 'a changed rendered rule',
        edit: [],
        sel: '.probe',
        props: ['color'],
        unit: { css: '^\\.probe$' },
        expect: { declared: { reach: 'reached' }, complete: { reach: 'reached' } },
      },
    ],
  };
  let captures = 0;
  let receipt;
  const stdout = [];
  const stderr = [];
  const options = [];
  const browser = {
    version: () => 'unit-fixture',
    close: async () => {},
    newPage: async () => {
      const page = {
        goto: async (url) => {
          page.side = url.includes('/head/') ? 'head' : 'base';
        },
        close: async () => {},
        coverage: {
          startJSCoverage: async () => {},
          startCSSCoverage: async () => {},
          stopJSCoverage: async () => [{ url: pathToFileURL('/capture/app.js').href }],
          stopCSSCoverage: async () => [
            {
              url: pathToFileURL(`/capture/${page.side}/app.css`).href,
              text: `.probe { color: ${page.side === 'head' ? 'blue' : 'red'}; }`,
              ranges: [{ start: 0, end: 40 }],
            },
          ],
        },
      };
      return page;
    },
  };
  const capture = {
    trackServedRules: async () => ({ dispose: async () => {} }),
    captureStyleMap: async (page, settings) => {
      options.push(settings?.captureReach === true && Boolean(settings.servedRules));
      captures++;
      const reach = {
        sheets: ['/app.css'],
        rules: [{ sheet: 0, key: '.probe', hash: page.side, used: true }],
        ...(mode === 'partial' ? { unreadable: 1 } : {}),
      };
      if (mode === 'drift' && captures === 2) reach.rules[0].hash = 'drift';
      return {
        elements: {},
        ...(mode === 'missing-preflight' || (mode === 'missing-scenario' && captures > 2) ? {} : { reach }),
      };
    },
  };
  const fakeFs = {
    mkdtempSync: () => '/capture',
    cpSync: () => {},
    rmSync: () => {},
    readFileSync: (file) => (String(file).endsWith('reach-corpus.json') ? JSON.stringify(corpus) : '{}'),
    writeFileSync: (file, text) => {
      if (String(file).endsWith('reach-corpus.results.json')) receipt = JSON.parse(text);
    },
  };
  const mocks = {
    '@playwright/test': { chromium: { launch: async () => browser } },
    esbuild: { default: { build: async () => {} } },
    'node:fs': { default: fakeFs },
    '../dist/capture.js': capture,
    '../dist/rule-reach.js': classifier,
    '../dist/diff.js': { diffStyleMaps: () => [] },
    './reach-joins.mjs': { ...joins, diffHunks: () => [], lineExecution: () => new Map() },
  };
  const sentinel = new Error('corpus exit');
  let exitCode = 0;
  const context = (await import('node:vm')).createContext({
    console: { log: (text) => stdout.push(text), error: (text) => stderr.push(text) },
    process: {
      argv: mode === 'complete' ? [] : ['--check'],
      exit: (code) => {
        exitCode = code;
        throw sentinel;
      },
    },
  });
  const module = new SourceTextModule(readFileSync(source, 'utf8'), {
    context,
    identifier: source.href,
    initializeImportMeta: (meta) => {
      meta.url = source.href;
    },
  });
  await module.link(async (specifier) => {
    const exports = mocks[specifier] ?? (await import(new URL(specifier, source).href));
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context },
    );
  });
  try {
    await module.evaluate();
  } catch (error) {
    if (error !== sentinel) throw error;
  }
  console.log(JSON.stringify({ exitCode, stdout, stderr, receipt, options }));
}

function runCorpusProbe(mode) {
  const rootUrl = new URL('../', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--input-type=module',
      '-e',
      `(${corpusProbe})(${JSON.stringify(mode)}, ${JSON.stringify(rootUrl)})`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('reach corpus rejects incomplete ledgers even when CSS expectations match', async (t) => {
  for (const [mode, ledger, unreadable] of [
    ['partial', 'partial', 2],
    ['missing-scenario', 'missing', 0],
  ]) {
    await t.test(mode, () => {
      const result = runCorpusProbe(mode);
      assert.equal(result.exitCode, 1, mode);
      assert.match(
        result.stderr.join('\n'),
        new RegExp(`J1 ledger ${ledger} \\(${unreadable} unreadable\\) — CSS reach is unknown`),
      );
    });
  }
});

test('reach corpus rejects missing or drifting ledgers before scoring cases', async (t) => {
  for (const mode of ['missing-preflight', 'drift']) {
    await t.test(mode, () => {
      const result = runCorpusProbe(mode);
      assert.equal(result.exitCode, 2, mode);
      assert.match(result.stderr.join('\n'), /reach ledger drifted/);
    });
  }
});

test('reach corpus scores CSS with source classifier keys and explanations', () => {
  const result = runCorpusProbe('complete');
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.ok(result.options.every(Boolean), 'every capture records the served-rule ledger');
  assert.deepEqual(result.receipt.cases[0].scenarios.declared.units, ['.probe: reached (matched in a captured state)']);
});

test('J3 class vocabulary reads ledger keys', async () => {
  const { classVocabulary } = await import('../bench/reach-joins.mjs');
  assert.deepEqual([...classVocabulary(['.panel > .cell', '@media (width > 600px) > .panel #2'])], ['panel', 'cell']);
});
