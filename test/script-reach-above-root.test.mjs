import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { storedScriptUrl } from '../dist/script-reach-identity.js';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { scriptReachFixture } from './script-reach-fixture.mjs';

async function capture(sources, sourcesContent, mapUrl = 'https://app.test/app.js.map', options = {}) {
  const fixture = scriptReachFixture({
    maps: [
      { version: 3, sources, sourcesContent, sourceRoot: options.sourceRoot, mappings: options.mappings ?? 'AAAA' },
    ],
    source: options.source ?? 'x',
    mapUrl,
  });
  const tracker = await trackScriptReach(fixture.page, { projectRoot: options.projectRoot });
  try {
    fixture.navigate();
    return (await tracker.stop()).scripts[0];
  } finally {
    await tracker.dispose();
  }
}

for (const [source, mapUrl] of [
  ['../src/app.ts', 'https://app.test/app.js.map'],
  ['../../src/app.ts', 'https://app.test/assets/app.js.map'],
]) {
  test(`relative above-root source with embedded content maps: ${source}`, async () => {
    const script = await capture([source], ['x'], mapUrl);
    assert.equal(script.status, 'mapped');
    assert.equal(script.files[0].sourceKey, 'src/app.ts');
    assert.equal(script.files[0].contentHash, createHash('sha256').update('x').digest('hex'));
    assert.ok(script.files[0].executed.length > 0);
  });
}

for (const content of [undefined, [null], []]) {
  test(`relative above-root source without its own content stays unknown: ${JSON.stringify(content)}`, async () => {
    const script = await capture(['../src/app.ts'], content);
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

test('clipped source keys still collide within a map', async () => {
  const script = await capture(['../src/app.ts', '../../src/app.ts'], ['x', 'x']);
  assert.equal(script.status, 'unknown');
  assert.equal(script.reason, 'source key collision');
});

for (const source of ['webpack://_N_E/../shared/x.ts', 'webpack:///../home/Home.tsx', 'custom:///../src/app.ts']) {
  test(`scheme-prefixed traversal with embedded content stays unknown: ${source}`, async () => {
    const script = await capture([source], ['x']);
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

for (const [sourceRoot, source] of [
  ['webpack://_N_E/', '../shared/x.ts'],
  ['webpack:///', '../home/Home.tsx'],
  ['https://cdn.test/', '../src/app.ts'],
  ['vite:', '../src/app.ts'],
]) {
  test(`scheme sourceRoot cannot permit relative traversal: ${sourceRoot}`, async () => {
    const script = await capture([source], ['x'], undefined, { sourceRoot });
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

test('a relative sourceRoot may resolve in-root while its source clips', async () => {
  const script = await capture(['../../src/app.ts'], ['x'], undefined, { sourceRoot: 'assets/' });
  assert.equal(script.status, 'mapped');
  assert.equal(script.files[0].sourceKey, 'src/app.ts');
});

test('sourceRoot itself cannot climb above the URL root even with content', async () => {
  const script = await capture(['src/app.ts'], ['x'], undefined, { sourceRoot: '../' });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('embedded content on another index cannot authorize above-root clipping', async () => {
  const script = await capture(['src/ok.ts', '../src/app.ts'], ['x', null], undefined, {
    source: 'xx',
    mappings: 'AAAA,CCAA',
  });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('only the content-backed source index receives a hash', async () => {
  const script = await capture(['../src/app.ts', 'src/ok.ts'], ['x', null], undefined, {
    source: 'xx',
    mappings: 'AAAA,CCAA',
  });
  assert.equal(script.status, 'mapped');
  assert.deepEqual(
    script.files.map((file) => [file.sourceKey, file.contentHash]),
    [
      ['src/app.ts', createHash('sha256').update('x').digest('hex')],
      ['src/ok.ts', undefined],
    ],
  );
});

for (const directory of ['var', 'private', 'Volumes', 'opt', 'Users', 'home', 'root', 'tmp']) {
  test(`clipped ${directory} machine paths are validated against the project root`, async () => {
    const projectRoot = path.join(path.parse(tmpdir()).root, directory, 'capture', 'project');
    const reference = '../../../' + path.join(projectRoot, 'src/app.ts').replaceAll('\\', '/').replace(/^\//, '');
    const script = await capture([reference], ['x'], undefined, { projectRoot });
    assert.equal(script.status, 'mapped');
    assert.equal(script.files[0].sourceKey, 'src/app.ts');
    const outside = await capture([reference], ['x'], undefined, { projectRoot: path.join(projectRoot, 'other') });
    assert.equal(outside.status, 'unknown');
    assert.equal(outside.reason, 'source outside project root');
    assert.ok(!JSON.stringify(outside).includes('capture/project'));
    assert.equal(
      storedScriptUrl('https://app.test/' + directory + '/capture/project/app.js', projectRoot),
      'https://app.test/app.js',
    );
  });
}

test('clipped drive-letter paths are validated against the project root', async () => {
  const projectRoot = 'C:' + String.raw`\capture\project`;
  const script = await capture(['../../../C:/capture/project/src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'mapped');
  assert.equal(script.files[0].sourceKey, 'src/app.ts');
  const outside = await capture(['../../../C:/other/src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(outside.status, 'unknown');
  assert.equal(outside.reason, 'source outside project root');
});

test('an esbuild outfile outside the project cannot leak a machine path', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'reach-outfile-'));
  try {
    const projectRoot = realpathSync(workspace);
    mkdirSync(path.join(projectRoot, 'src'));
    const content = 'globalThis.ready = true;';
    writeFileSync(path.join(projectRoot, 'src/app.ts'), content);
    const built = await build({
      absWorkingDir: projectRoot,
      entryPoints: ['src/app.ts'],
      outfile: path.join(path.parse(projectRoot).root, 'styleproof-out', 'public', 'app.js'),
      bundle: true,
      sourcemap: true,
      write: false,
    });
    const generated = built.outputFiles.find((file) => file.path.endsWith('.js')).text;
    const map = JSON.parse(built.outputFiles.find((file) => file.path.endsWith('.map')).text);
    assert.ok(map.sources[0].startsWith('../'));
    const entry = { functions: [{ ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }] }] };
    const files = mapScriptCoverage(entry, generated, map, 'https://app.test/app.js.map', { projectRoot });
    assert.equal(files[0].sourceKey, 'src/app.ts');
    assert.equal(files[0].contentHash, createHash('sha256').update(content).digest('hex'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
