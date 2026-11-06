import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/** Compare warmed medians on the same operation; setup and correctness checks are untimed. */
export function assertLinearScaling(t, { name, n, make, run, check }) {
  const fixtures = [n, n * 4].map((size) => ({ size, input: make(size) }));
  const measure = ({ size, input }) => {
    const started = performance.now();
    const result = run(input);
    const ms = performance.now() - started;
    check(result, input, size);
    assert.ok(ms < 10_000, `${name}: ${size} exceeded the 10 s hang guard (${ms} ms)`);
    return ms;
  };
  // Warm each size once, then interleave three samples to reduce drift from load or GC.
  for (const fixture of fixtures) measure(fixture);
  const samples = [[], []];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const [index, fixture] of fixtures.entries()) samples[index].push(measure(fixture));
  }
  const [medianN, median4N] = samples.map((times) => [...times].sort((a, b) => a - b)[1]);
  const ratio = median4N / medianN;
  const detail = { name, n, largeN: n * 4, warmupsPerSize: 1, samples, medianN, median4N, ratio };
  t.diagnostic(JSON.stringify(detail));
  assert.ok(Number.isFinite(ratio) && ratio < 8, `${name}: 4N/N median ratio must be < 8; ${JSON.stringify(detail)}`);
}
