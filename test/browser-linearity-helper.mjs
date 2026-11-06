import assert from 'node:assert/strict';
/** Same warmed minimum-CPU ratio and wall guard as the Node helper, using Chromium thread ticks. */
export async function assertBrowserLinearScaling(t, { client, name, n, prepare, run, check }) {
  await client.send('Performance.enable', { timeDomain: 'threadTicks' });
  const cpu = async () => {
    const { metrics } = await client.send('Performance.getMetrics');
    const value = metrics.find((metric) => metric.name === 'ThreadTime')?.value;
    assert.equal(typeof value, 'number', 'Chromium main-thread CPU clock must be available');
    return value * 1000;
  };
  const samples = [[], []];
  for (let repeat = -1; repeat < 5; repeat++) {
    for (const [index, size] of [n, n * 4].entries()) {
      await prepare(size);
      const start = await cpu();
      const wall = performance.now();
      const result = await run();
      const elapsed = performance.now() - wall;
      const ms = (await cpu()) - start;
      check(result, size);
      assert.ok(elapsed < 60_000, `${name}: ${size} exceeded the 60 s wall guard (${elapsed} ms)`);
      if (repeat >= 0) samples[index].push(ms);
    }
  }
  const [minN, min4N] = samples.map((times) => Math.min(...times));
  const ratio = min4N / minN;
  const detail = {
    name,
    clock: 'Chromium thread CPU ms',
    n,
    largeN: n * 4,
    warmupsPerSize: 1,
    samples,
    minN,
    min4N,
    ratio,
  };
  t.diagnostic(JSON.stringify(detail));
  assert.ok(Number.isFinite(ratio) && ratio < 8, `${name}: 4N/N minimum ratio must be < 8; ${JSON.stringify(detail)}`);
}
