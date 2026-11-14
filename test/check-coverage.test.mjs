import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  COVERAGE_LINE_FLOOR,
  COVERAGE_MIN_NODE,
  COVERAGE_TEST_TIMEOUT_MS,
  lineHitsFromV8,
  coverageArgs,
  coverageToolSupported,
} from '../scripts/check-coverage.mjs';
import { NODE_TEST_TIMEOUT_MS } from '../scripts/run-node-test.mjs';

test('coverage floor is the measured dist/ baseline minus small slack', () => {
  // Baseline measured on tip 6155b54 with Node 22.20 + dist include: 41.49% lines.
  assert.equal(COVERAGE_LINE_FLOOR, 40);
  assert.equal(COVERAGE_INCLUDE, 'dist/**');
  assert.equal(COVERAGE_EXCLUDE, '**/node_modules/**');
  assert.equal(COVERAGE_TEST_TIMEOUT_MS, NODE_TEST_TIMEOUT_MS * 2);
  assert.deepEqual(COVERAGE_MIN_NODE, { major: 22, minor: 8 });
});

test('coverageToolSupported requires Node 22.8+ (threshold + include flags)', () => {
  assert.equal(coverageToolSupported(18, 20), false);
  assert.equal(coverageToolSupported(20, 19), false);
  assert.equal(coverageToolSupported(22, 7), false);
  assert.equal(coverageToolSupported(22, 8), true);
  assert.equal(coverageToolSupported(22, 20), true);
  assert.equal(coverageToolSupported(24, 0), true);
});

test('coverageArgs emits built-in include + line floor on supported Node', () => {
  assert.equal(coverageArgs({ nodeMajor: 20, nodeMinor: 19 }), null);
  assert.deepEqual(coverageArgs({ nodeMajor: 22, nodeMinor: 20 }), [
    '--experimental-test-coverage',
    '--test-coverage-include=dist/**',
    '--test-coverage-exclude=**/node_modules/**',
    '--test-coverage-lines=40',
  ]);
  assert.deepEqual(
    coverageArgs({ nodeMajor: 22, nodeMinor: 20, floor: 99, include: 'src/**', exclude: '**/vendor/**' }),
    [
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-coverage-exclude=**/vendor/**',
      '--test-coverage-lines=99',
    ],
  );
});

test('check-coverage exits non-zero when the line floor is impossible', () => {
  if (!coverageToolSupported()) {
    const unsupported = spawnSync(process.execPath, ['scripts/check-coverage.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, STYLEPROOF_PRODUCT_STATE: '' },
    });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /needs Node 22\.8\+/);
    return;
  }

  // Coverage reports real paths, and on macOS os.tmpdir() is a symlink, so an
  // unresolved include matched nothing and every floor passed.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cov-floor-')));
  try {
    const covered = path.join(dir, 'lib.js');
    const testFile = path.join(dir, 'lib.test.mjs');
    // Multi-line unused bodies so V8 line coverage stays well below 100%.
    fs.writeFileSync(
      covered,
      [
        'export function used() {',
        '  return 1;',
        '}',
        'export function unusedA() {',
        '  const a = 2;',
        '  const b = 3;',
        '  return a + b;',
        '}',
        'export function unusedB() {',
        '  const a = 4;',
        '  const b = 5;',
        '  return a + b;',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { used } from ${JSON.stringify(covered)};\ntest('hits one export', () => assert.equal(used(), 1));\n`,
    );

    const env = { ...process.env, STYLEPROOF_PRODUCT_STATE: '' };
    for (const key of Object.keys(env)) {
      if (/^(NODE_TEST|TEST_WORKER|TAP_)/i.test(key)) delete env[key];
    }

    const impossible = spawnSync(
      process.execPath,
      [
        '--experimental-test-coverage',
        `--test-coverage-include=${covered.replaceAll('\\', '/')}`,
        '--test-coverage-lines=100',
        '--test',
        testFile,
      ],
      { encoding: 'utf8', env },
    );
    assert.notEqual(impossible.status, 0, impossible.stdout + impossible.stderr);
    assert.match(`${impossible.stdout}\n${impossible.stderr}`, /coverage|threshold|100/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loader-transformed copy cannot add or erase hits', () => {
  const url = new URL('../dist/m.js', import.meta.url).href;
  const entry = (endOffset, count) => ({ url, functions: [{ ranges: [{ startOffset: 0, endOffset, count }] }] });
  const real = { result: [entry(4, 1)] };
  const transformed = { result: [entry(4, 0)], 'source-map-cache': { [url]: {} } };
  const expected = lineHitsFromV8([real], () => 'a();');
  assert.deepEqual(
    lineHitsFromV8([transformed], () => 'a();'),
    new Map(),
  );
  assert.deepEqual(
    lineHitsFromV8([real, transformed], () => 'a();'),
    expected,
  );
  assert.deepEqual(
    lineHitsFromV8([transformed, real], () => 'a();'),
    expected,
  );
  assert.deepEqual(
    lineHitsFromV8([{ result: [entry(400, 1)] }], () => 'a();'),
    new Map(),
  );
});

test('coverage scope ignores dependencies and foreign URLs', () => {
  const result = [
    'node:fs',
    'https://example.com/dist/m.js',
    pathToFileURL('/other/m.js').href,
    new URL('../dist/node_modules/m.js', import.meta.url).href,
    pathToFileURL(path.resolve('scripts/merge-coverage.mjs')).href,
  ].map((url) => ({ url }));
  assert.deepEqual(
    lineHitsFromV8([{ result }], () => {
      throw new Error('outside scope');
    }),
    new Map(),
  );
});

test('shard coverage keeps only the spec reporter', () => {
  const args = coverageArgs({ nodeMajor: 22, nodeMinor: 20, shard: '1/3', lcov: 'coverage.info' });
  assert.ok(args.includes('--test-reporter=spec'));
  assert.ok(!args.includes('--test-reporter=lcov'));
});

test('per-process V8 coverage unions line hits within a shard', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-process-union-')));
  try {
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const file = path.join(dir, 'dist/m.js');
    const source =
      'export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\nexport function c() {\n  return 3;\n}\n';
    fs.writeFileSync(file, source);
    const url = pathToFileURL(file).href;
    const hook = path.join(dir, 'hook.mjs');
    fs.writeFileSync(
      hook,
      `export async function load(url, context, next) {
      const result = await next(url, context);
      if (url === ${JSON.stringify(url)}) result.source = '//'.padEnd(1000, ' ') + '\\n' + result.source + '\\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({version:3,sources:[url],names:[],mappings:''})).toString('base64');
      return result;
    }`.replaceAll("'\n'", "'\\n'"),
    );
    const processes = [];
    for (const call of ['a', 'b', null]) {
      const coverage = fs.mkdtempSync(path.join(dir, 'raw-'));
      const code = call
        ? `import {${call}} from ${JSON.stringify(url)}; ${call}();`
        : `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)}); await import(${JSON.stringify(url)});`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, NODE_V8_COVERAGE: coverage },
        encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      processes.push(
        fs
          .readdirSync(coverage)
          .filter((name) => name.endsWith('.json'))
          .map((name) => JSON.parse(fs.readFileSync(path.join(coverage, name), 'utf8')))
          .find((entry) => entry.result.some((script) => script.url === url)),
      );
    }
    const read = (name) => fs.readFileSync(name, 'utf8');
    // The fixture is outside the repository: use its root for scope resolution.
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const [a, b, transformed] = processes;
      const script = transformed.result.find((entry) => entry.url === url);
      assert.ok(
        Object.hasOwn(transformed['source-map-cache'] ?? {}, url) ||
          script.functions[0].ranges[0].endOffset !== source.length,
      );
      assert.equal(lineHitsFromV8([transformed], read).size, 0);
      const expected = lineHitsFromV8([a, b], read);
      assert.equal([...expected.values()][0].get(2), 1);
      assert.equal([...expected.values()][0].get(5), 1);
      assert.equal([...expected.values()][0].get(8), 0);
      for (const order of [
        [a, b, transformed],
        [a, transformed, b],
        [b, a, transformed],
        [b, transformed, a],
        [transformed, a, b],
        [transformed, b, a],
      ])
        assert.deepEqual(lineHitsFromV8(order, read), expected);
    } finally {
      process.chdir(previous);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uncalled function closing brace excludes the line ending', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = ['function unused() {', '  return 1;', '}', ''].join(newline);
    const url = new URL('../dist/unused.js', import.meta.url).href;
    const result = [
      {
        url,
        functions: [
          { ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
          { ranges: [{ startOffset: 0, endOffset: source.length - newline.length, count: 0 }] },
        ],
      },
    ];
    assert.equal(
      lineHitsFromV8([{ result }], () => source)
        .get('dist/unused.js')
        .get(3),
      0,
    );
  }
});
