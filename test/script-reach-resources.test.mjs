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

test('cache is disabled on the owned session for the tracked window', async () => {
  const { calls } = await capture();
  assert.ok(calls.some(([name, args]) => name === 'Network.setCacheDisabled' && args.cacheDisabled === true));
  assert.ok(calls.some(([name, args]) => name === 'Network.setCacheDisabled' && args.cacheDisabled === false));
});

test('best-effort functions affect only their script and have a distinct reason', async () => {
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

test('HTTP scripts cannot make the capture read a local map file', async () => {
  const local = new URL('./fixtures/script-reach/bundle.js.map', import.meta.url).href;
  const { evidence } = await capture({ mapUrl: local });
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.equal(evidence.scripts[0].reason, 'file source map refused for non-file script');
});

test('stored script URLs discard queries and fragments', async () => {
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

test('CDP fallback is refused while routing or HAR replay is active', async () => {
  const { evidence, calls } = await capture({ blocked: true, routes: true });
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.match(evidence.scripts[0].reason, /routing or HAR/);
  assert.equal(
    calls.some(([name]) => name === 'Network.loadNetworkResource'),
    false,
  );
});

test('active page.coverage and an external CDP controller have distinct reasons', async () => {
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

test('the size cap is per script and a valid sibling remains measured', async () => {
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
test('the local map reader honours AbortSignal', async () => {
  const { readFileSourceMap } = await import('../dist/capture/script-map-resources.js');
  const controller = new AbortController();
  controller.abort();
  const url = new URL('./fixtures/script-reach/bundle.js.map', import.meta.url).href;
  await assert.rejects(readFileSourceMap(url, url, controller.signal), { name: 'AbortError' });
});

test('local maps must be regular files under the input cap', async () => {
  const { readFileSourceMap } = await import('../dist/capture/script-map-resources.js');
  const url = new URL('./fixtures/script-reach/', import.meta.url).href;
  await assert.rejects(readFileSourceMap(url, url, AbortSignal.timeout(1000)), /regular file/);
});

test('HAR replay also refuses the CDP fallback', async () => {
  const { evidence, calls } = await capture({ blocked: true, har: true });
  assert.match(evidence.scripts[0].reason, /routing or HAR/);
  assert.equal(
    calls.some(([name]) => name === 'Network.loadNetworkResource'),
    false,
  );
});

test('oversized regular local maps are refused before reading', async () => {
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

function fakePage({ fallback, maps = {}, count = 1 } = {}) {
  const listeners = new Map();
  const calls = [];
  const entries = Array.from({ length: count }, (_, i) => ({
    scriptId: String(i),
    url: `https://app.test/${i}.js`,
    functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
  }));
  const client = {
    on(name, callback) {
      listeners.set(name, callback);
    },
    async detach() {
      calls.push('detach');
    },
    async send(method, params) {
      calls.push(method);
      if (method === 'Profiler.startPreciseCoverage')
        entries.forEach((entry) =>
          listeners.get('Debugger.scriptParsed')?.({ ...entry, sourceMapURL: `${entry.url}.map` }),
        );
      if (method === 'Profiler.takePreciseCoverage') return { result: entries };
      if (method === 'Debugger.getScriptSource') return { scriptSource: 'x' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Network.loadNetworkResource')
        return fallback?.(params) ?? { resource: { success: true, stream: 'map' } };
      if (method === 'IO.read')
        return {
          data: JSON.stringify(maps.map ?? { version: 3, sources: ['a.js'], sourcesContent: ['x'], mappings: 'AAAA' }),
          eof: true,
        };
      return {};
    },
  };
  const page = {
    _routes: [],
    _connection: {
      _objects: new Map(),
      toImpl: () => ({ _delegate: { _coverage: { _jsCoverage: { _enabled: false } } } }),
    },
    coverage: {
      async startJSCoverage() {
        calls.push('probe-start');
      },
      async stopJSCoverage() {
        calls.push('probe-stop');
        return [];
      },
    },
    context: () => ({
      _routes: [],
      browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }),
      newCDPSession: async () => client,
    }),
    url: () => 'https://app.test/',
    on() {},
    off() {},
    async evaluate() {
      throw new Error('page fetch blocked by CSP');
    },
  };
  return { page, calls, navigate: () => listeners.get('Page.frameNavigated')?.({ frame: { id: 'main' } }) };
}

test('map I/O has a bounded generous wall-clock backstop', async () => {
  const { beforeDeadline } = await import('../dist/capture/script-map-resources.js');
  await assert.rejects(beforeDeadline(new Promise(() => {}), performance.now() + 30), /budget exhausted/);
});

test('deterministic mapping size limits name every unreadable script', async () => {
  const { page, navigate } = fakePage({
    count: 10,
    maps: { map: { version: 3, sources: ['src/a.js'], mappings: 'A'.repeat(2 * 1024 * 1024 + 1) } },
  });
  const tracker = await trackScriptReach(page);
  navigate();
  const evidence = await tracker.stop();
  assert.equal(evidence.scripts.length, 10);
  assert.ok(evidence.scripts.every((s) => s.status === 'unknown' && s.reason === 'source mapping size limit exceeded'));
});

test('the CDP fallback reads a map when page fetch is blocked', async () => {
  const { page, navigate, calls } = fakePage();
  const tracker = await trackScriptReach(page);
  navigate();
  const evidence = await tracker.stop();
  assert.equal(evidence.scripts[0].status, 'mapped');
  assert.ok(calls.includes('Network.loadNetworkResource'));
  assert.ok(calls.includes('IO.close'));
});

test('evidence over 1 MiB becomes unknown without partial sources', async () => {
  const { page, navigate } = fakePage({
    maps: {
      map: {
        version: 3,
        sources: ['https://app.test/' + 'x'.repeat(1024 * 1024)],
        sourcesContent: ['x'],
        mappings: 'AAAA',
      },
    },
  });
  const tracker = await trackScriptReach(page);
  navigate();
  const { notes, ...evidence } = await tracker.stop();
  assert.ok(notes.length);
  assert.deepEqual(evidence, {
    version: 1,
    window: 'navigation',
    status: 'measured',
    projectRootPrefix: '',
    scripts: [{ url: 'https://app.test/0.js', status: 'unknown', reason: 'script evidence exceeds 1 MiB' }],
  });
});

test('tracker startup never calls page.coverage as a destructive probe', async () => {
  const { page, calls } = fakePage();
  const tracker = await trackScriptReach(page);
  assert.equal(calls.includes('probe-start'), false);
  assert.equal(calls.includes('probe-stop'), false);
  await tracker.dispose();
});

test('ownership unavailable on a transport is unmeasured without touching its profiler', async () => {
  const { page, calls } = fakePage();
  delete page._connection;
  const tracker = await trackScriptReach(page);
  assert.equal((await tracker.stop()).reason, 'script coverage ownership unavailable');
  assert.deepEqual(calls, []);
});

test('an active foreign collector is rejected before taking its counters', async () => {
  const { page, calls, navigate } = fakePage();
  const tracker = await trackScriptReach(page);
  navigate();
  page._connection.toImpl = () => ({ coverage: { _jsCoverage: { _enabled: true } } });
  page.once = () => {};
  const evidence = await tracker.stop();
  assert.equal(evidence.reason, 'page.coverage active');
  assert.equal(calls.includes('Profiler.takePreciseCoverage'), false);
  assert.equal(calls.includes('Profiler.stopPreciseCoverage'), false);
  assert.equal(calls.includes('detach'), false);
});
