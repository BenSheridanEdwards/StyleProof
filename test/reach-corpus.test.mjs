// Runs bench/reach-corpus.mjs with browser/fs/git stubs; the real classifier decides CSS results.
// Only the child process needs --experimental-vm-modules.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function corpusProbe(mode, rootUrl) {
  const { readFileSync } = await import('node:fs');
  const { SourceTextModule, SyntheticModule } = await import('node:vm');
  const { pathToFileURL } = await import('node:url');
  const joins = await import(new URL('bench/reach-joins.mjs', rootUrl));
  const findingMatch = await import(new URL('bench/finding-match.mjs', rootUrl));
  const classifier = await import(new URL('dist/rule-reach.js', rootUrl));
  const classClassifier = await import(new URL('dist/class-join.js', rootUrl));
  const scriptClassifier = await import(new URL('dist/script-join.js', rootUrl));
  const sourceRanges = await import(new URL('dist/script-join-git.js', rootUrl));
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
  if (mode.startsWith('base-j3')) {
    corpus.cases[0].unit.js = '{}';
    corpus.cases[0].expect = Object.fromEntries(
      ['declared', 'complete'].map((side) => [
        side,
        {
          reach: 'unknown',
          classCount: 1,
          baseClassCount: 1,
          joins: { J2: 'ran', J3: 'unknown' },
          baseJ3: 'unknown',
        },
      ]),
    );
  }

  let captures = 0;
  let receipt;
  const stdout = [];
  const stderr = [];
  const options = [];
  const gitSetups = [];

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
          stopJSCoverage: async () => [{ url: pathToFileURL('/capture/app.js').href }],
        },
      };

      return page;
    },
  };

  const capture = {
    trackScriptReach: async () => ({ dispose: async () => {} }),
    trackServedRules: async () => ({ dispose: async () => {} }),
    captureStyleMap: async (page, settings) => {
      options.push(settings?.captureReach === true && Boolean(settings.servedRules));
      captures++;

      const reach = {
        version: 2,
        scope: 'compared',
        sheets: ['/app.css'],
        rules: [{ sheet: 0, key: '.probe', hash: page.side, used: true }],
        ...(mode === 'partial' ? { unreadable: 1 } : {}),
      };

      if (mode === 'drift' && captures === 2) reach.rules[0].hash = 'drift';

      return {
        elements: {},
        scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts: [] },
        ...(mode === 'missing-preflight' || (mode === 'missing-scenario' && captures > 2) ? {} : { reach }),
      };
    },
  };

  const fakeFs = {
    realpathSync: (file) => file,
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
    'node:child_process': {
      execFileSync: (command, args, settings) => gitSetups.push({ command, args, cwd: settings.cwd }),
    },
    '../dist/capture.js': capture,
    '../dist/rule-reach.js': classifier,
    '../dist/script-join.js': scriptClassifier,
    '../dist/class-join.js': classClassifier,
    '../dist/script-join-git.js': sourceRanges,
    '../dist/diff.js': { diffStyleMaps: () => [] },
    './reach-joins.mjs': { ...joins, diffHunks: () => [], lineExecution: () => new Map() },
    './finding-match.mjs': findingMatch,
  };
  let probeGaps = [];
  if (mode.startsWith('base-j3')) {
    const units = ['base', 'head'].map((side) => ({
      sourceKey: 'app.jsx',
      side,
      range: { start: { line: 1, column: 0 }, end: { line: 1, column: 2 } },
      token: 'probe',
      status: side === 'base' && mode === 'base-j3-wrong' ? 'never-rendered' : 'unknown',
      why: 'probe',
      level: 'warn',
      execution: 'ran',
    }));
    mocks['./reach-joins.mjs'].diffHunks = () => [{ base: [1], head: [1] }];
    mocks['../dist/script-join.js'] = { ...scriptClassifier, classifyScriptReach: () => ({ units, gaps: probeGaps }) };
    mocks['../dist/class-join.js'] = { ...classClassifier, classifyClassReach: () => ({ units, gaps: probeGaps }) };
  }

  if (mode === 'unmocked-import') delete mocks['./finding-match.mjs'];
  const sentinel = new Error('corpus exit');
  let exitCode = 0;

  const context = (await import('node:vm')).createContext({
    console: { log: (text) => stdout.push(text), error: (text) => stderr.push(text) },
    process: {
      argv: mode === 'complete' || mode === 'base-j3' ? [] : ['--check'],
      exit: (code) => {
        exitCode = code;
        throw sentinel;
      },
    },
  });

  probeGaps = (await import('node:vm')).runInContext('[]', context);

  const module = new SourceTextModule(readFileSync(source, 'utf8'), {
    context,
    identifier: source.href,
    initializeImportMeta: (meta) => {
      meta.url = source.href;
    },
  });

  await module.link(async (specifier) => {
    if (!(specifier in mocks) && !specifier.startsWith('node:'))
      throw new Error(`corpus probe: unmocked import ${specifier}`);
    const exports = mocks[specifier] ?? (await import(specifier));

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

  console.log(JSON.stringify({ exitCode, stdout, stderr, receipt, options, gitSetups }));
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

test('reach corpus retains and verifies base-side J3 removals on replacement lines', () => {
  const good = runCorpusProbe('base-j3');
  assert.equal(good.exitCode, 0, good.stderr.join('\n'));
  const result = good.receipt.cases[0].scenarios.declared;
  assert.equal(result.baseClassUnits.length, 1);
  assert.equal(result.baseClassUnits[0].side, 'base');
  const wrong = runCorpusProbe('base-j3-wrong');
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stderr.join('\n'), /base.*J3|J3.*base/);
});

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
  for (const [mode, diagnostic] of [
    ['missing-preflight', /reach ledger missing/],
    ['drift', /reach ledger drifted/],
  ]) {
    await t.test(mode, () => {
      const result = runCorpusProbe(mode);
      assert.equal(result.exitCode, 2, mode);
      assert.match(result.stderr.join('\n'), diagnostic);
    });
  }
});

test('reach corpus scores CSS with source classifier keys and explanations', () => {
  const result = runCorpusProbe('complete');
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.ok(result.options.every(Boolean), 'every capture records the served-rule ledger');
  assert.deepEqual(result.gitSetups, [{ command: 'git', args: ['init', '--quiet'], cwd: '/capture' }]);
  assert.deepEqual(result.receipt.cases[0].scenarios.declared.units, ['.probe: reached (matched in a captured state)']);
});

test('J3 class vocabulary reads ledger keys', async () => {
  const { classVocabulary } = await import('../bench/reach-joins.mjs');
  assert.deepEqual([...classVocabulary(['.panel > .cell', '@media (width > 600px) > .panel #2'])], ['panel', 'cell']);
});

test('reach corpus probe rejects unmocked imports', () => {
  assert.throws(() => runCorpusProbe('unmocked-import'), /corpus probe: unmocked import \.\/finding-match\.mjs/);
});
