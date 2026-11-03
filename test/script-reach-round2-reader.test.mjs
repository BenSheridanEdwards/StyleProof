import test from 'node:test';
import assert from 'node:assert/strict';
import { trackScriptReach } from '../dist/capture/script-reach.js';

import { scriptReachFixture as fixture } from './script-reach-fixture.mjs';

async function capture(options) {
  const f = fixture(options);
  const t = await trackScriptReach(f.page);
  f.navigate();
  return { ...f, evidence: await t.stop() };
}

test('B1 cache is disabled on the owned session for the tracked window', async () => {
  const { calls } = await capture();
  assert.ok(calls.some(([name, args]) => name === 'Network.setCacheDisabled' && args.cacheDisabled === true));
  assert.ok(calls.some(([name, args]) => name === 'Network.setCacheDisabled' && args.cacheDisabled === false));
});

test('B1 best-effort functions affect only their script and have a distinct reason', async () => {
  const entries = [0, 1].map((i) => ({
    scriptId: String(i),
    url: `https://app.test/${i}.js`,
    functions: [{ isBlockCoverage: i === 1, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
  }));
  const { evidence } = await capture({ entries });
  assert.equal(evidence.status, 'measured');
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.equal(evidence.scripts[0].reason, 'best-effort coverage');
  assert.equal(evidence.scripts[1].status, 'mapped');
});

test('B4 HTTP scripts cannot make the capture read a local map file', async () => {
  const local = new URL('./fixtures/script-reach/bundle.js.map', import.meta.url).href;
  const { evidence } = await capture({ mapUrl: local });
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.equal(evidence.scripts[0].reason, 'file source map refused for non-file script');
});

test('N6 stored script URLs discard queries and fragments', async () => {
  const entries = [
    {
      scriptId: '0',
      url: 'https://app.test/0.js?signature=fixture#secret',
      functions: [{ isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    },
  ];
  const { evidence } = await capture({ entries });
  assert.equal(evidence.scripts[0].url, 'https://app.test/0.js');
});

test('N8 CDP fallback is refused while routing or HAR replay is active', async () => {
  const { evidence, calls } = await capture({ blocked: true, routes: true });
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.match(evidence.scripts[0].reason, /routing or HAR/);
  assert.equal(
    calls.some(([name]) => name === 'Network.loadNetworkResource'),
    false,
  );
});

test('N5 active page.coverage and an external CDP controller have distinct reasons', async () => {
  const a = fixture();
  a.state._enabled = true;
  const ta = await trackScriptReach(a.page);
  const ar = await ta.stop();
  const b = fixture();
  b.page._connection._objects.set('external', { _type: 'CDPSession', _parent: b.context });
  const tb = await trackScriptReach(b.page);
  const br = await tb.stop();
  assert.match(ar.reason, /page\.coverage/);
  assert.match(br.reason, /CDP session/);
  assert.notEqual(ar.reason, br.reason);
});

test('N2 the size cap is per script and a valid sibling remains measured', async () => {
  const entries = [0, 1].map((i) => ({
    scriptId: String(i),
    url: `https://app.test/${i}.js`,
    functions: [{ isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
  }));
  const maps = [
    { version: 3, sources: ['x'.repeat(600_000)], sourcesContent: ['x'], mappings: 'AAAA' },
    { version: 3, sources: ['src/good.js'], sourcesContent: ['x'], mappings: 'AAAA' },
  ];
  const { evidence } = await capture({ entries, maps });
  assert.equal(evidence.status, 'measured');
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.equal(evidence.scripts[0].reason, 'script evidence exceeds 1 MiB');
  assert.equal(evidence.scripts[1].status, 'mapped');
});

// The local-file reader must accept aborts before starting I/O.
test('B4 the local map reader honours AbortSignal', async () => {
  const { readFileSourceMap } = await import('../dist/capture/script-map-resources.js');
  const controller = new AbortController();
  controller.abort();
  const url = new URL('./fixtures/script-reach/bundle.js.map', import.meta.url).href;
  await assert.rejects(readFileSourceMap(url, url, controller.signal), { name: 'AbortError' });
});

test('B2 the tracker does not enable Debugger until stop', async () => {
  const f = fixture();
  const tracker = await trackScriptReach(f.page);
  assert.equal(
    f.calls.some(([name]) => name === 'Debugger.enable'),
    false,
  );
  await tracker.dispose();
});

test('B4 local maps must be regular files under the input cap', async () => {
  const { readFileSourceMap } = await import('../dist/capture/script-map-resources.js');
  const url = new URL('./fixtures/script-reach/', import.meta.url).href;
  await assert.rejects(readFileSourceMap(url, url, AbortSignal.timeout(1000)), /regular file/);
});

test('N8 HAR replay also refuses the CDP fallback', async () => {
  const { evidence, calls } = await capture({ blocked: true, har: true });
  assert.match(evidence.scripts[0].reason, /routing or HAR/);
  assert.equal(
    calls.some(([name]) => name === 'Network.loadNetworkResource'),
    false,
  );
});

test('B4 oversized regular local maps are refused before reading', async () => {
  const { mkdtemp, writeFile, unlink, rmdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { readFileSourceMap } = await import('../dist/capture/script-map-resources.js');
  const directory = await mkdtemp(join(tmpdir(), 'script-map-test-'));
  const file = join(directory, 'large.map');
  try {
    await writeFile(file, ' '.repeat(8 * 1024 * 1024 + 1));
    const url = pathToFileURL(file).href;
    await assert.rejects(readFileSourceMap(url, url, AbortSignal.timeout(1000)), /input size limit/);
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});
