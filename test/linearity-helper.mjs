import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/** Compare warmed CPU-time minima; setup and correctness checks are untimed. */
export function assertLinearScaling(t, { name, n, make, run, check }) {
  const fixtures = [n, n * 4].map((size) => ({ size, input: make(size) }));
  const measure = ({ size, input }) => {
    global.gc?.();
    const startedCpu = process.cpuUsage();
    const started = performance.now();
    const result = run(input);
    const ms = performance.now() - started;
    const cpu = process.cpuUsage(startedCpu);
    check(result, input, size);
    assert.ok(ms < 60_000, `${name}: ${size} exceeded the 60 s wall-clock guard (${ms} ms)`);
    return (cpu.user + cpu.system) / 1000;
  };
  // CPU time excludes scheduling delays; minima reduce noise from GC and background V8 work.
  for (const fixture of fixtures) measure(fixture);
  const samples = [[], []];
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const [index, fixture] of fixtures.entries()) samples[index].push(measure(fixture));
  }
  const [minN, min4N] = samples.map((times) => Math.min(...times));
  const ratio = min4N / minN;
  const detail = { name, clock: 'process CPU ms', n, largeN: n * 4, warmupsPerSize: 1, samples, minN, min4N, ratio };
  t.diagnostic(JSON.stringify(detail));
  assert.ok(Number.isFinite(ratio) && ratio < 8, `${name}: 4N/N minimum ratio must be < 8; ${JSON.stringify(detail)}`);
}
