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

test('R3.4 unsupported webpack eval script is named unmeasured', async () => {
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

test('R3.4 missing script metadata cannot silently produce measured empty evidence', async () => {
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

test('R3.3 duplicate file keys across scripts make both scripts unknown', async () => {
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

test('R3.7 map read clock is a generous backstop rather than the normal limit', () => {
  assert.ok(MAP_READ_BUDGET_MS >= 30_000);
});

test('R3.8 cache is restored at navigation load before map/forced-state reads', async () => {
  const f = scriptReachFixture();
  const t = await trackScriptReach(f.page);
  f.navigate();
  f.emit('Page.loadEventFired', {});
  await Promise.resolve();
  assert.ok(f.calls.some(([m, p]) => m === 'Network.setCacheDisabled' && p.cacheDisabled === false));
  assert.ok(!f.calls.some(([m]) => m === 'Profiler.takePreciseCoverage'));
  await t.dispose();
});

test('R3.9 a total evidence cap rejects many individually in-limit scripts', async () => {
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

test('R3.10 unrouted maps use CDP without entering page JavaScript', async () => {
  const f = scriptReachFixture();
  let entered = false;
  f.page.evaluate = async () => {
    entered = true;
    throw new Error('patched fetch');
  };
  assert.equal((await capture(f)).scripts[0].status, 'mapped');
  assert.equal(entered, false);
});

test('R3.11 HAR router arrays require the routed page fetch', async () => {
  const f = scriptReachFixture({ har: true });
  const result = await capture(f);
  assert.equal(result.scripts[0].status, 'mapped');
  assert.ok(!f.calls.some(([name]) => name === 'Network.loadNetworkResource'));
});

test('R3.12 unavailable ownership warns once and never probes the profiler', async () => {
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

test('R3.11 blocked HAR array routing cannot escape through CDP', async () => {
  const f = scriptReachFixture({ har: true, blocked: true });
  const result = await capture(f);
  assert.equal(result.scripts[0].status, 'unknown');
  assert.ok(!f.calls.some(([name]) => name === 'Network.loadNetworkResource'));
});
