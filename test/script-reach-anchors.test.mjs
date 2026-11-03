import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { sourceIdentities } from '../dist/script-reach-identity.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { findPrivacyFindings } from '../scripts/privacy-check.mjs';
const coverage = (text, ranges = []) => ({
  functions: [{ ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }, ...ranges] }],
});
const map = (mappings, sources = ['src/app.js'], sourcesContent) => ({
  version: 3,
  sources,
  mappings,
  ...(sourcesContent ? { sourcesContent } : {}),
});
const span = (line, column) => ({ start: { line, column }, end: { line, column } });
const root = path.join(tmpdir(), 'reach-project');

test('nonmonotonic mappings can never interpolate executed extents', () => {
  const text = 'ok(); if (f) bad(); tail();';
  const [file] = mapScriptCoverage(
    coverage(text, [{ startOffset: 13, endOffset: 19, count: 0 }]),
    text,
    map('AAAA,aAAa,MAAb,CAAa,KAAM', undefined, [text]),
    'https://app.test/a.map',
  );
  assert.deepEqual(file.executed, [span(1, 0), span(1, 19)]);
  assert.ok(file.mixed.some((r) => r.start.column === 13));
});

test('minifier-removed DEBUG branch has no executed extent', async () => {
  const original = 'ok(); if (DEBUG) { boom(); } tail();';
  const built = await transform(original, {
    sourcemap: 'external',
    sourcefile: 'src/app.js',
    minify: true,
    define: { DEBUG: 'false' },
  });
  const [file] = mapScriptCoverage(coverage(built.code), built.code, JSON.parse(built.map), 'https://app.test/a.map');
  assert.ok(file.executed.length > 0);
  assert.ok(file.executed.every((r) => r.start.column === r.end.column));
  assert.ok(
    file.executed.every((r) => r.start.column < original.indexOf('if') || r.start.column >= original.indexOf('tail')),
  );
});

for (const mappings of ['AAAA,KAAA', 'AAAA,KAAK,KAAL', 'AAAA,KAAK,KAAL,KAAM'])
  test(`repeated original starts aggregate states: ${mappings}`, () => {
    const text = 'x'.repeat(20);
    const [file] = mapScriptCoverage(
      coverage(text, [
        { startOffset: 10, endOffset: 15, count: 0 },
        { startOffset: 5, endOffset: 10, count: mappings === 'AAAA,KAAA' ? 0 : 1 },
      ]),
      text,
      map(mappings, undefined, [text]),
      'https://app.test/a.map',
    );
    assert.ok(file.executed.every((r) => r.start.column === r.end.column));
    if (mappings !== 'AAAA,KAAK,KAAL,KAAM') assert.ok(file.mixed.some((r) => r.start.column === 0));
  });

test('compact storage preserves three distinct same-kind anchors', () => {
  const script = {
    url: 'https://app.test/a.js',
    status: 'mapped',
    files: [
      { source: 'src/a.js', executed: [span(1, 5)], mixed: [], unexecuted: [span(1, 0), span(1, 10), span(1, 15)] },
    ],
  };
  assert.deepEqual(compactScriptEvidence(script).files[0].unexecuted, [
    [1, 0, 0],
    [1, 10, 10],
    [1, 15, 15],
  ]);
});

test('monorepo and nested src keys retain their complete project paths', () => {
  const sources = [
    'webpack://fixture/packages/ui/src/Button.tsx',
    'webpack://fixture/packages/app/src/Button.tsx',
    'webpack://fixture/src/tools/src/parser.ts',
    'webpack://fixture/components/index.js',
    'webpack://fixture/widgets/index.js',
  ];
  assert.deepEqual(sourceIdentities(map('', sources), 'https://app.test/dist/a.map', root), [
    'packages/ui/src/Button.tsx',
    'packages/app/src/Button.tsx',
    'src/tools/src/parser.ts',
    'components/index.js',
    'widgets/index.js',
  ]);
});

test('file sources and sourceRoot resolve relative to each capture project root', () => {
  const keys = (checkout) => {
    const project = path.join(tmpdir(), 'work', checkout);
    return sourceIdentities(
      { ...map('', ['Button.tsx']), sourceRoot: '../packages/ui/src/' },
      pathToFileURL(path.join(project, 'dist/a.map')).href,
      project,
    );
  };
  assert.deepEqual(keys('first'), ['packages/ui/src/Button.tsx']);
  assert.deepEqual(keys('first'), keys('second'));
  const absolute = path.join(root, 'components/index.js');
  assert.deepEqual(sourceIdentities(map('', [absolute]), 'https://app.test/a.map', root), ['components/index.js']);
});

test('relative HTTP sources retain the resolved pathname', () => {
  assert.deepEqual(
    sourceIdentities(
      { ...map('', ['index.js']), sourceRoot: '../components/' },
      'https://app.test/assets/maps/a.map',
      root,
    ),
    ['assets/components/index.js'],
  );
});

test('sources outside the capture project are refused', () => {
  assert.throws(
    () =>
      sourceIdentities(
        map('', [pathToFileURL(path.join(tmpdir(), 'outside/app.js')).href]),
        'https://app.test/a.map',
        root,
      ),
    /source outside project root/,
  );
});

test('colliding source identities are refused rather than merged', () => {
  assert.throws(
    () =>
      sourceIdentities(
        map('', ['webpack://first/components/index.js', 'webpack://second/components/index.js']),
        'https://app.test/a.map',
        root,
      ),
    /source key collision/,
  );
});

test('the file-spoof regression is privacy-clean once tracked', () => {
  const text = readFileSync(new URL('./script-reach-lifecycle.e2e.spec.ts', import.meta.url), 'utf8');
  assert.deepEqual(findPrivacyFindings([{ file: 'test/script-reach-lifecycle.e2e.spec.ts', text }]), []);
});

test('vendor mappings do not consume the app segment cap', () => {
  const count = 110_000,
    text = 'x'.repeat(count + 1);
  const files = mapScriptCoverage(
    coverage(text),
    text,
    map('AAAA,' + 'CAAC,'.repeat(count - 1) + 'CCAA', ['node_modules/vendor.js', 'src/app.js']),
    'https://app.test/a.map',
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].sourceKey, 'src/app.js');
});

for (const separator of ['\r\n', '\u2028', '\u2029', '\r'])
  test(`generated line separator ${JSON.stringify(separator)} preserves V8 offsets`, () => {
    const text = 'a();' + separator + 'b();';
    const [file] = mapScriptCoverage(
      coverage(text, [{ startOffset: 4 + separator.length, endOffset: text.length, count: 0 }]),
      text,
      map('AAAA;AACA', undefined, ['a();\nb();']),
      'https://app.test/a.map',
    );
    assert.deepEqual(file.executed, [span(1, 0)]);
    assert.deepEqual(file.unexecuted, [span(2, 0)]);
  });

test('collision detection precedes per-script compaction limits', async () => {
  const { storedScriptEvidence } = await import('../dist/script-reach-storage.js');
  const file = {
    source: 'src/shared.js',
    sourceKey: 'src/shared.js',
    mixed: [],
    unexecuted: [],
    executed: Array.from({ length: 85_000 }, (_, column) => [1, column, column]),
  };
  const result = storedScriptEvidence([
    { url: 'https://app.test/first.js', status: 'mapped', files: [file] },
    { url: 'https://app.test/second.js', status: 'mapped', files: [{ ...file, executed: [[1, 0, 0]] }] },
  ]);
  assert.ok(result.scripts.every((script) => script.status === 'unknown' && script.reason === 'source key collision'));
});

test('bundler URLs contribute paths without query or fragment', () => {
  for (const scheme of ['webpack://fixture/', 'vite:'])
    assert.deepEqual(
      sourceIdentities(
        map('', [scheme + 'packages/ui/src/Button.tsx?cache=fixture#fragment']),
        'https://app.test/a.map',
        root,
      ),
      ['packages/ui/src/Button.tsx'],
    );
  assert.throws(
    () =>
      sourceIdentities(
        map('', ['webpack://one/src/app.js?cache=one', 'webpack://two/src/app.js?cache=two']),
        'https://app.test/a.map',
        root,
      ),
    /source key collision/,
  );
});

test('URL paths decode once and agree with filesystem source keys', () => {
  const filename = path.join(root, 'src/a%20b.ts');
  assert.deepEqual(
    sourceIdentities(map('', ['https://app.test/src/a%2520b.ts']), 'https://app.test/a.map', root),
    sourceIdentities(map('', [pathToFileURL(filename).href]), 'https://app.test/a.map', root),
  );
});

test('sourceRoot and relative sources resolve together before extracting URI paths', () => {
  for (const sourceRoot of ['webpack://fixture/packages/', 'vite:packages/'])
    assert.deepEqual(
      sourceIdentities(
        { ...map('', ['ui/src/Button.tsx?cache=fixture#fragment']), sourceRoot },
        'https://app.test/a.map',
        root,
      ),
      ['packages/ui/src/Button.tsx'],
    );
});

test('fragment-only source references resolve against the map URL itself', () => {
  assert.deepEqual(sourceIdentities(map('', ['#original']), 'https://app.test/assets/app.map', root), [
    'assets/app.map',
  ]);
});

test('rooted Windows paths cannot become relative HTTP source keys', () => {
  assert.throws(
    () => sourceIdentities(map('', ['\\outside\\app.js']), 'https://app.test/a.map', 'C:\\project'),
    /source outside project root/,
  );
});

for (const prefix of ['http://dev.test/@fs', 'http://dev.test'])
  test(`filesystem URL sources validate the capture root: ${prefix}`, () => {
    const outside = path.join(path.parse(root).root, 'Users', 'other', 'outside.js');
    assert.throws(
      () => sourceIdentities(map('AAAA', [prefix + outside]), 'http://dev.test/a.map', root),
      /outside project root/,
    );
  });

test('Vite filesystem sources have the same keys in two checkouts', () => {
  const roots = ['first', 'second'].map((name) => path.join(root, name));
  const keys = roots.map((projectRoot) =>
    sourceIdentities(
      map('AAAA', ['http://dev.test/@fs' + path.join(projectRoot, 'packages/ui/src/Button.tsx')]),
      'http://dev.test/a.map',
      projectRoot,
    ),
  );
  assert.deepEqual(keys, [['packages/ui/src/Button.tsx'], ['packages/ui/src/Button.tsx']]);
});

test('webpack ignored module sources are non-app', () => {
  assert.deepEqual(
    sourceIdentities(map('AAAA', ['webpack://_N_E/?3c5f', 'webpack://_N_E/']), 'https://app.test/a.map', root),
    [undefined, undefined],
  );
});

test('compaction preserves distinct point anchors even inside another range', () => {
  const file = {
    source: 'src/a.js',
    executed: [
      [1, 0, 20],
      [1, 4, 4],
      [1, 10, 10],
      [1, 18, 18],
    ],
    mixed: [],
    unexecuted: [],
  };
  assert.deepEqual(
    compactScriptEvidence({ url: 'https://app.test/a.js', status: 'mapped', files: [file] }).files[0].executed,
    file.executed,
  );
});
