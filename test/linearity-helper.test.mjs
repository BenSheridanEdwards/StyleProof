import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { assertLinearScaling } from './linearity-helper.mjs';

function measureWithDurations(t, durations, cpuDurations = durations) {
  let now = 0;
  const timestamps = durations.flatMap((ms) => {
    const start = now;
    now += ms;
    return [start, now];
  });
  t.mock.method(performance, 'now', () => timestamps.shift());
  const cpuSamples = [...cpuDurations];
  t.mock.method(process, 'cpuUsage', (previous) => ({
    user: previous ? cpuSamples.shift() * 1000 : 0,
    system: 0,
  }));
  const checked = [];
  const diagnostics = [];
  assertLinearScaling(
    { diagnostic: (message) => diagnostics.push(JSON.parse(message)) },
    {
      name: 'controlled timing',
      n: 100,
      make: (size) => ({ size }),
      run: (input) => input.size,
      check: (result, input, size) => {
        assert.equal(result, size);
        assert.equal(input.size, size);
        checked.push(size);
      },
    },
  );
  return { checked, diagnostics };
}

test('minimum timing accepts linear work despite delays in most large samples', (t) => {
  const { checked, diagnostics } = measureWithDurations(t, [25, 100, 25, 110, 27, 260, 26, 270, 28, 280, 29, 290]);
  assert.deepEqual(checked, Array.from({ length: 6 }, () => [100, 400]).flat());
  assert.equal(diagnostics.length, 1);
  const { samples, minN, min4N, ratio } = diagnostics[0];
  assert.deepEqual(samples, [
    [25, 27, 26, 28, 29],
    [110, 260, 270, 280, 290],
  ]);
  assert.equal(minN, 25);
  assert.equal(min4N, 110);
  assert.equal(ratio, 4.4);
});

test('minimum timing still rejects quadratic growth', (t) => {
  assert.throws(
    () => measureWithDurations(t, Array.from({ length: 6 }, () => [25, 400]).flat()),
    /4N\/N minimum ratio must be < 8/,
  );
});

test('the scaling bound remains strictly below eight', (t) => {
  assert.throws(
    () => measureWithDurations(t, Array.from({ length: 6 }, () => [25, 200]).flat()),
    /4N\/N minimum ratio must be < 8/,
  );
});

test('scheduler delays do not inflate the CPU scaling ratio', (t) => {
  const { diagnostics } = measureWithDurations(
    t,
    Array.from({ length: 6 }, () => [25, 1000]).flat(),
    Array.from({ length: 6 }, () => [25, 100]).flat(),
  );
  assert.equal(diagnostics[0].clock, 'process CPU ms');
  assert.equal(diagnostics[0].ratio, 4);
});

test('the ten second hang guard still rejects a slow sample', (t) => {
  assert.throws(() => measureWithDurations(t, [25, 100, 10000], [25, 100, 25]), /10 s hang guard/);
});
