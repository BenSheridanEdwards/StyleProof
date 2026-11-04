import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { MAX_MAP_BYTES } from '../dist/script-reach-limits.js';
import { sourceIdentities, storedScriptUrl } from '../dist/script-reach-identity.js';
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

function projectFixture(t, files = { 'src/app.ts': 'x', 'src/ok.ts': 'x' }, layout = 'project') {
  const workspace = mkdtempSync(path.join(tmpdir(), 'reach-local-proof-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const projectRoot = path.join(realpathSync(workspace), layout);
  mkdirSync(projectRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(projectRoot, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }
  return projectRoot;
}

for (const [source, mapUrl] of [
  ['../src/app.ts', 'https://app.test/app.js.map'],
  ['../../src/app.ts', 'https://app.test/assets/app.js.map'],
]) {
  test(`relative above-root source with embedded content maps: ${source}`, async (t) => {
    const script = await capture([source], ['x'], mapUrl, { projectRoot: projectFixture(t) });
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

test('clipped source keys still collide within a map', async (t) => {
  const script = await capture(['../src/app.ts', '../../src/app.ts'], ['x', 'x'], undefined, {
    projectRoot: projectFixture(t),
  });
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
  ['web\tpack:///', '../src/app.ts'],
  [' webpack:///', '../src/app.ts'],
  [String.fromCharCode(0) + 'webpack:///', '../src/app.ts'],
]) {
  test(`scheme sourceRoot cannot permit relative traversal: ${JSON.stringify(sourceRoot)}`, async (t) => {
    const projectRoot = projectFixture(t, { [source.slice(3)]: 'x' });
    const script = await capture([source], ['x'], undefined, { sourceRoot, projectRoot });
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

test('a relative sourceRoot may resolve in-root while its source clips', async (t) => {
  const script = await capture(['../../src/app.ts'], ['x'], undefined, {
    sourceRoot: 'assets/',
    projectRoot: projectFixture(t),
  });
  assert.equal(script.status, 'mapped');
  assert.equal(script.files[0].sourceKey, 'src/app.ts');
});

test('sourceRoot itself cannot climb above the URL root even with content', async () => {
  const script = await capture(['src/app.ts'], ['x'], undefined, { sourceRoot: '../' });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('embedded content on another index cannot authorize above-root clipping', async (t) => {
  const script = await capture(['src/ok.ts', '../src/app.ts'], ['x', null], undefined, {
    source: 'xx',
    projectRoot: projectFixture(t),
    mappings: 'AAAA,CCAA',
  });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('only the content-backed source index receives a hash', async (t) => {
  const script = await capture(['../src/app.ts', 'src/ok.ts'], ['x', null], undefined, {
    source: 'xx',
    projectRoot: projectFixture(t),
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

for (const layout of ['workspaces/proj', '__w/r/r', 'usr/src/app', 'build', 'vercel/path0', 'builds/g/p']) {
  test(`clipped ${layout} layouts require real project files for both candidates`, async (t) => {
    const projectRoot = projectFixture(t, { 'src/app.ts': 'x' }, layout);
    const misleading = await capture(['../../' + layout + '/src/app.ts'], ['x'], undefined, { projectRoot });
    assert.equal(misleading.status, 'unknown');
    assert.match(misleading.reason, /source path escapes URL root/);
    const absoluteSource = '../../' + path.join(projectRoot, 'src/app.ts').replaceAll('\\', '/').replace(/^\//, '');
    const verified = await capture([absoluteSource], ['x'], undefined, { projectRoot });
    assert.equal(verified.status, 'mapped');
    assert.equal(verified.files[0].sourceKey, 'src/app.ts');
    assert.equal(verified.files[0].contentHash, createHash('sha256').update('x').digest('hex'));
  });
}

for (const source of [
  '../srv/other/x.ts',
  '../mnt/c/Users/x/lib/x.ts',
  '../users/x/lib/x.ts',
  '../x/proj/src/x.ts',
  '../C:/not-a-project/src/x.ts',
]) {
  test(`unverified machine paths are never accepted by their spelling: ${source}`, async (t) => {
    const script = await capture([source], ['x'], undefined, { projectRoot: projectFixture(t) });
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

test('a fake absolute projectRoot without local files cannot verify a clipped key', async (t) => {
  const projectRoot = path.join(projectFixture(t, {}), 'workspaces', 'proj');
  const script = await capture(['../../workspaces/proj/src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
});

test('a monorepo source outside packages/web cannot become a local shared key', async (t) => {
  const projectRoot = projectFixture(t, {}, 'packages/web');
  const shared = path.join(projectRoot, '..', '..', 'shared', 'src/util.ts');
  mkdirSync(path.dirname(shared), { recursive: true });
  writeFileSync(shared, 'x');
  const script = await capture(['../../shared/src/util.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('a same-length local file whose hash differs from sourcesContent stays unknown', async (t) => {
  const projectRoot = projectFixture(t, { 'src/app.ts': 'y' });
  const script = await capture(['../src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
  assert.match(script.reason, /source path escapes URL root/);
});

test('a symlink escaping projectRoot is rejected before reading its bytes', async (t) => {
  const projectRoot = projectFixture(t, {});
  const outside = path.join(projectRoot, '..', 'outside.ts');
  writeFileSync(outside, 'x');
  mkdirSync(path.join(projectRoot, 'src'));
  symlinkSync(outside, path.join(projectRoot, 'src/app.ts'));
  const read = t.mock.method(fs, 'readSync', () => {
    throw new Error('outside source was read');
  });
  const script = await capture(['../src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
  assert.equal(read.mock.callCount(), 0);
});

test('a directory symlink escaping projectRoot cannot supply proof', async (t) => {
  const projectRoot = projectFixture(t, {});
  const outside = path.join(projectRoot, '..', 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'app.ts'), 'x');
  symlinkSync(outside, path.join(projectRoot, 'src'), 'junction');
  const script = await capture(['../src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
});

test('clipped proof rejects non-regular and oversized project entries', async (t) => {
  const projectRoot = projectFixture(t);
  const filename = path.join(projectRoot, 'src/app.ts');
  truncateSync(filename, MAX_MAP_BYTES + 1);
  const read = t.mock.method(fs, 'readSync', () => {
    throw new Error('oversized source was read');
  });
  const oversized = await capture(['../src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(oversized.status, 'unknown');
  const directory = await capture(['../src'], ['x'], undefined, { projectRoot });
  assert.equal(directory.status, 'unknown');
  assert.equal(read.mock.callCount(), 0);
});

for (const control of ['\t', '\n', '\r']) {
  test(`URL-ignored controls cannot hide traversal without content: ${JSON.stringify(control)}`, async () => {
    const source =
      Array(3)
        .fill('.' + control + '.')
        .join('/') + '/workspaces/x/y.ts';
    const script = await capture([source], undefined, 'https://app.test/assets/a.map');
    assert.equal(script.status, 'unknown');
    assert.match(script.reason, /source path escapes URL root/);
  });
}

for (const directory of ['private', 'opt', 'var', 'Volumes']) {
  test(`non-clipped ${directory} HTTP paths keep main identity and stored URL`, (t) => {
    const read = t.mock.method(fs, 'readSync', () => {
      throw new Error('non-clipped source was read');
    });
    const address = 'https://app.test/' + directory + '/x.ts';
    assert.deepEqual(
      sourceIdentities(
        { version: 3, sources: [address], sourcesContent: ['x'], mappings: 'AAAA' },
        'https://app.test/app.map',
      ),
      [directory + '/x.ts'],
    );
    assert.equal(storedScriptUrl(address), address);
    assert.equal(read.mock.callCount(), 0);
  });
}

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

test('drive forms cannot be reinterpreted as relative colon directories', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not allow colon-named project directories');
    return;
  }
  const projectRoot = projectFixture(t, { 'C:/not-a-project/src/x.ts': 'x' });
  const script = await capture(['../C:/not-a-project/src/x.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
});

test('an absolute alias cannot prove a different returned project key', async (t) => {
  const projectRoot = projectFixture(t, { 'src/other.ts': 'x' });
  const alias = '/@fs' + path.join(projectRoot, 'src/app.ts').replaceAll('\\', '/');
  const original = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (filename, ...args) =>
    filename === alias ? path.join(projectRoot, 'src/other.ts') : original(filename, ...args),
  );
  const script = await capture(['../../' + alias.slice(1)], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
});

test('case-insensitive filesystem aliases cannot create alternate source keys', async (t) => {
  const projectRoot = projectFixture(t);
  if (!fs.existsSync(path.join(projectRoot, 'SRC/App.ts'))) {
    t.skip('host filesystem is case-sensitive');
    return;
  }
  const alias = await capture(['../SRC/App.ts'], ['x'], undefined, { projectRoot });
  assert.equal(alias.status, 'unknown');
  const duplicate = await capture(['../src/app.ts', '../SRC/APP.ts'], ['x', 'x'], undefined, {
    projectRoot,
    source: 'xx',
    mappings: 'AAAA,CCAA',
  });
  assert.equal(duplicate.status, 'unknown');
  assert.equal(duplicate.files, undefined);
});

test('a post-read realpath change invalidates the source proof', async (t) => {
  const projectRoot = projectFixture(t);
  const keyPath = path.join(projectRoot, 'src/app.ts');
  const original = fs.realpathSync.native;
  let calls = 0;
  t.mock.method(fs.realpathSync, 'native', (filename, ...args) => {
    if (filename === keyPath && ++calls === 2) return path.join(projectRoot, 'changed.ts');
    return original(filename, ...args);
  });
  const read = t.mock.method(fs, 'readSync');
  const script = await capture(['../src/app.ts'], ['x'], undefined, { projectRoot });
  assert.equal(script.status, 'unknown');
  assert.equal(calls, 2);
  assert.ok(read.mock.callCount() > 0);
});
