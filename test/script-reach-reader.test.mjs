import test from 'node:test';
import assert from 'node:assert/strict';
import { trackScriptReach } from '../dist/capture/script-reach.js';

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

test('review 11: the CDP fallback reads a map when page fetch is blocked', async () => {
  const { page, navigate, calls } = fakePage();
  const tracker = await trackScriptReach(page);
  navigate();
  const evidence = await tracker.stop();
  assert.equal(evidence.scripts[0].status, 'mapped');
  assert.ok(calls.includes('Network.loadNetworkResource'));
  assert.ok(calls.includes('IO.close'));
});

test('review 11: evidence over 1 MiB becomes unknown without partial sources', async () => {
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
  assert.deepEqual(await tracker.stop(), {
    version: 1,
    window: 'navigation',
    status: 'measured',
    scripts: [{ url: 'https://app.test/0.js', status: 'unknown', reason: 'script evidence exceeds 1 MiB' }],
  });
});

test('review 9: tracker startup never calls page.coverage as a destructive probe', async () => {
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

test('review 1/2: an active foreign collector is rejected before taking its counters', async () => {
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
