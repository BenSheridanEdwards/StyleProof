import test from 'node:test';
import assert from 'node:assert/strict';
import { trackScriptReach } from '../dist/capture/script-reach.js';
import { scriptReachFixture } from './script-reach-fixture.mjs';
import { MAP_READ_BUDGET_MS } from '../dist/capture/script-map-resources.js';

async function capture(f) {
  const tracker = await trackScriptReach(f.page);
  f.navigate();
  return tracker.stop();
}

test('unsupported webpack eval script is named unmeasured', async () => {
  const simple = scriptReachFixture({
    entries: [
      {
        scriptId: '0',
        url: 'webpack-internal:///./src/eval.js',
        functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
      },
    ],
  });
  const result = await capture(simple);
  assert.equal(result.scripts.length, 1);
  assert.equal(result.scripts[0].status, 'unmeasured');
  assert.equal(result.scripts[0].reason, 'unsupported script URL');
});

test('missing script metadata cannot silently produce measured empty evidence', async () => {
  const f = scriptReachFixture();
  const original = f.client.send;
  f.client.send = async (method, args) =>
    method === 'Profiler.takePreciseCoverage'
      ? {
          result: [
            {
              scriptId: 'missing',
              url: 'https://app.test/eval.js',
              functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
            },
          ],
        }
      : original(method, args);
  const result = await capture(f);
  assert.deepEqual(result.scripts, [
    { url: 'https://app.test/eval.js', status: 'unmeasured', reason: 'unsupported script URL' },
  ]);
});

test('duplicate file keys across scripts make both scripts unknown', async () => {
  const f = scriptReachFixture({
    entries: [0, 1].map((i) => ({
      scriptId: String(i),
      url: `https://app.test/${i}.js`,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    })),
  });
  const result = await capture(f);
  assert.ok(result.scripts.every((s) => s.status === 'unknown' && s.reason === 'source key collision'));
});

test('map read clock is a generous backstop rather than the normal limit', () => {
  assert.ok(MAP_READ_BUDGET_MS >= 30_000);
});

test('cache is restored at navigation load before map/forced-state reads', async () => {
  const f = scriptReachFixture();
  const t = await trackScriptReach(f.page);
  f.navigate();
  f.emit('Page.loadEventFired', {});
  await Promise.resolve();
  assert.ok(f.calls.some(([m, p]) => m === 'Network.setCacheDisabled' && p.cacheDisabled === false));
  assert.ok(!f.calls.some(([m]) => m === 'Profiler.takePreciseCoverage'));
  await t.dispose();
});

test('a total evidence cap rejects many individually in-limit scripts', async () => {
  const count = 7;
  const f = scriptReachFixture({
    entries: Array.from({ length: count }, (_, i) => ({
      scriptId: String(i),
      url: `https://app.test/${i}.js`,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    })),
    maps: Array.from({ length: count }, (_, i) => ({
      version: 3,
      sources: [`src/${i}/` + 'x'.repeat(400_000)],
      sourcesContent: ['x'],
      mappings: 'AAAA',
    })),
  });
  const result = await capture(f);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'total script evidence exceeds 4 MiB');
  assert.deepEqual(result.scripts, []);
});

test('unrouted maps use CDP without entering page JavaScript', async () => {
  const f = scriptReachFixture();
  let entered = false;
  f.page.evaluate = async () => {
    entered = true;
    throw new Error('patched fetch');
  };
  assert.equal((await capture(f)).scripts[0].status, 'mapped');
  assert.equal(entered, false);
});

test('HAR router arrays require the routed page fetch', async () => {
  const f = scriptReachFixture({ har: true });
  const result = await capture(f);
  assert.equal(result.scripts[0].status, 'mapped');
  assert.ok(!f.calls.some(([name]) => name === 'Network.loadNetworkResource'));
});

test('unavailable ownership warns once and never probes the profiler', async () => {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    for (let i = 0; i < 2; i++) {
      const f = scriptReachFixture();
      delete f.page._connection;
      await capture(f);
      assert.deepEqual(f.calls, []);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /script coverage ownership unavailable/);
  } finally {
    console.warn = original;
  }
});

test('blocked HAR array routing cannot escape through CDP', async () => {
  const f = scriptReachFixture({ har: true, blocked: true });
  const result = await capture(f);
  assert.equal(result.scripts[0].status, 'unknown');
  assert.ok(!f.calls.some(([name]) => name === 'Network.loadNetworkResource'));
});

test('an unrelated replay route uses the CDP map reader', async () => {
  const f = scriptReachFixture({ blocked: true });
  f.page._routes = [{ matches: (url) => url.endsWith('/api/data') }];
  assert.equal((await capture(f)).scripts[0].status, 'mapped');
  assert.ok(f.calls.some(([method]) => method === 'Network.loadNetworkResource'));
});

test('map read restores cache for same-document navigation without a load event', async () => {
  const f = scriptReachFixture();
  const tracker = await trackScriptReach(f.page);
  f.navigate();
  await tracker.beginMapRead?.();
  assert.ok(f.calls.some(([method, args]) => method === 'Network.setCacheDisabled' && args.cacheDisabled === false));
  assert.ok(!f.calls.some(([method]) => method === 'Profiler.takePreciseCoverage'));
  await tracker.dispose();
});

test('oversized parsed scripts are refused before fetching generated code', async () => {
  const f = scriptReachFixture();
  const original = f.client.send;
  f.client.send = async (method, args) => {
    const result = await original(method, args);
    if (method === 'Debugger.enable' || method === 'Profiler.startPreciseCoverage')
      f.emit('Debugger.scriptParsed', { scriptId: '0', url: 'https://app.test/0.js', length: 4 * 1024 * 1024 + 1 });
    return result;
  };
  const tracker = await trackScriptReach(f.page);
  f.navigate();
  const evidence = await tracker.stop();
  assert.equal(evidence.scripts[0].status, 'unknown');
  assert.match(evidence.scripts[0].reason, /size limit/);
  assert.ok(!f.calls.some(([method]) => method === 'Debugger.getScriptSource'));
});

test('Playwright evaluation sourceURL is excluded while page eval remains named', async () => {
  const f = scriptReachFixture({
    entries: ['__playwright_evaluation_script__', ''].map((url, i) => ({
      scriptId: String(i),
      url,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    })),
  });
  const evidence = await capture(f);
  assert.deepEqual(evidence.scripts, [{ url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' }]);
});

test('measured evidence names the four V8 expression residuals', async () => {
  const evidence = await capture(scriptReachFixture());
  assert.match(
    evidence.notes?.join(' ') ?? '',
    /default parameter.*destructuring default.*logical assignment.*optional chain/,
  );
});

test('early script metadata collection resumes debugger pauses while arming', async () => {
  const f = scriptReachFixture();
  const original = f.client.send;
  f.client.send = async (method, args) => {
    if (method === 'Debugger.enable') f.emit('Debugger.paused', {});
    return original(method, args);
  };
  const tracker = await trackScriptReach(f.page);
  assert.ok(f.calls.some(([method]) => method === 'Debugger.resume'));
  await tracker.dispose();
});

test('stored capture JSON redacts absolute bundler script paths and relativises app files', async () => {
  const { join, parse } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const projectRoot = join(tmpdir(), 'reach-checkout');
  const outside = join(parse(projectRoot).root, 'Users', 'other', 'private.js');
  const inside = join(projectRoot, 'src/app.ts');
  const urls = ['webpack-internal://' + outside, 'webpack://' + inside];
  const f = scriptReachFixture({
    entries: urls.map((url, i) => ({
      scriptId: String(i),
      url,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    })),
    maps: [{}, { version: 3, sources: ['webpack://' + inside], sourcesContent: ['x'], mappings: 'AAAA' }],
  });
  const t = await trackScriptReach(f.page, { projectRoot });
  f.navigate();
  const evidence = await t.stop();
  const json = JSON.stringify(evidence);
  for (const forbidden of [
    outside,
    projectRoot,
    outside.replace(/^\//, ''),
    projectRoot.replace(/^\//, ''),
    encodeURI(outside),
    encodeURI(projectRoot),
  ])
    assert.ok(!json.includes(forbidden), 'stored evidence must omit filesystem paths');
  assert.ok(evidence.scripts.some((s) => s.url === 'webpack-internal:<outside root>'));
  assert.ok(evidence.scripts.some((s) => s.files?.[0]?.sourceKey === 'src/app.ts'));
});

for (const owner of ['page', 'context'])
  for (const value of [undefined, {}, 'unavailable'])
    test(`unknown ${owner} routing metadata cannot use the CDP loader: ${typeof value}`, async () => {
      const f = scriptReachFixture();
      f[owner]._routes = value;
      const result = await capture(f);
      assert.equal(result.scripts[0].status, 'mapped');
      assert.ok(!f.calls.some(([method]) => method === 'Network.loadNetworkResource'));
    });

test('script count has a deterministic named cap before source or map reads', async () => {
  const limits = await import('../dist/script-reach-limits.js');
  const count = (limits.MAX_SCRIPTS ?? 1000) + 1;
  const f = scriptReachFixture({
    entries: Array.from({ length: count }, (_, i) => ({
      scriptId: String(i),
      url: `https://app.test/${i}.js`,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
    })),
  });
  const result = await capture(f);
  assert.deepEqual(result.scripts, [
    { url: '<script limit>', status: 'unknown', reason: `script count exceeds ${count - 1}` },
  ]);
  assert.ok(!f.calls.some(([method]) => ['Debugger.getScriptSource', 'Network.loadNetworkResource'].includes(method)));
});

test('evidence names the post-throwing-call V8 residual', async () => {
  const evidence = await capture(scriptReachFixture());
  assert.match(
    evidence.notes?.join(' ') ?? '',
    /block was entered; code after a call that threw in that block is not proved/,
  );
});
