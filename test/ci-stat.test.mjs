import assert from 'node:assert/strict';
import test from 'node:test';
import { attemptStats, summarize, percentile, main } from '../scripts/ci-stat.mjs';

const time = (seconds) => new Date(1700000000000 + seconds * 1000).toISOString();
const job = (created, start, end, extra = {}) => ({
  created_at: time(created),
  started_at: start === null ? null : time(start),
  completed_at: time(end),
  conclusion: 'success',
  ...extra,
});
const run = { id: 1, created_at: time(0), run_started_at: time(0), status: 'completed', conclusion: 'success' };
const stats = (jobs, extra = {}) => attemptStats({ ...run, ...extra }, jobs);

test('attempt one includes the wait before run_started_at', () => {
  const row = stats([job(35, 35, 45)], { run_started_at: time(30) });
  assert.equal(row.run_queue, 35);
  assert.equal(row.wall, 45);
  assert.equal(row.queue_time, 35);
});
test('live attempts exclude carried jobs by attempt identity', () => {
  const output = [];
  const exec = (_, args) => {
    const endpoint = args[1];
    if (endpoint.includes('/workflows/')) return JSON.stringify({ workflow_runs: [{ ...run, run_attempt: 2 }] });
    const second = endpoint.includes('/attempts/2');
    if (!endpoint.includes('/jobs')) return JSON.stringify({ ...run, run_started_at: time(second ? 100 : 0) });
    const carried = job(0, 1, 10, { run_attempt: 1 });
    // Its clock overlaps attempt two, but its explicit identity still belongs to attempt one.
    const overlapping = job(100, 102, 120, { run_attempt: 1 });
    return JSON.stringify({
      jobs: second ? [carried, overlapping, job(100, 101, 110, { run_attempt: 2 })] : [carried],
    });
  };
  main(['--live', '--json'], { exec, write: (value) => output.push(value) });
  const row = JSON.parse(output[0]).rows.find((row) => row.id === '1#2');
  assert.equal(row.run_time, 9);
  assert.equal(row.wall, 10);
  assert.equal(row.queue_time, 1);
});
test('fixture reruns require attempt metadata', () => {
  assert.throws(
    () =>
      main(['--fixture', 'fixture.json'], {
        read: () => JSON.stringify({ runs: [{ ...run, run_attempt: 2 }], jobs: {} }),
        write: () => {},
      }),
    /Missing attempt metadata/,
  );
});
test('live pagination includes jobs after the first hundred', () => {
  const calls = [];
  const output = [];
  const exec = (_, args) => {
    const endpoint = args[1];
    calls.push(endpoint);
    if (endpoint.includes('/workflows/')) return JSON.stringify({ workflow_runs: [run] });
    if (!endpoint.includes('/jobs')) return JSON.stringify(run);
    return JSON.stringify({
      jobs: endpoint.includes('&page=2') ? [job(10, 11, 30)] : Array.from({ length: 100 }, () => job(0, 1, 10)),
    });
  };
  main(['--live', '--json'], { exec, write: (value) => output.push(value) });
  assert.ok(calls.some((endpoint) => endpoint.endsWith('&page=2')));
  assert.equal(JSON.parse(output[0]).rows[0].wall, 30);
  assert.equal(JSON.parse(output[0]).rows[0].run_time, 28);
});
test('bare live and json are rejected before reading data', () => {
  for (const args of [
    ['live', '--json'],
    ['--fixture', 'fixture.json', 'json'],
  ]) {
    assert.equal(
      main(args, {
        exec: () => JSON.stringify({ workflow_runs: [] }),
        read: () => JSON.stringify({ runs: [], jobs: {} }),
        write: () => {},
      }),
      2,
    );
  }
});
test('skewed job durations are clamped in the execution and queue totals', () => {
  const row = stats([job(0, 50, 100), job(0, 90, 40), job(0, 20, 30), job(0, 35, 39)]);
  assert.equal(row.run_time, 64);
  assert.equal(row.queue_time, 36);
});

test('linear chain partitions wall into queue and execution seconds', () => {
  const row = stats([job(2, 5, 15), job(15, 20, 40), job(40, 42, 43)]);
  assert.equal(row.run_time, 31);
  assert.equal(row.wall, 43);
  assert.equal(row.queue_time + row.run_time, row.wall);
  assert.equal(row.run_queue, 2);
});
test('parallel shards follow a chain instead of summing execution', () => {
  const row = stats([job(0, 0, 10), ...Array.from({ length: 6 }, (_, i) => job(10, 15, 25 + i)), job(30, 31, 32)]);
  assert.equal(row.run_time, 26);
});
test('rerun origin excludes carried jobs', () => {
  const row = stats([job(0, 1, 10), job(100, 105, 115)], { attempt: 2, run_started_at: time(100) });
  assert.equal(row.wall, 15);
  assert.equal(row.run_time, 10);
  assert.equal(row.id, '1#2');
});
test('skipped jobs do not affect timing', () => {
  assert.deepEqual(stats([job(0, 1, 10), job(0, 0, 900, { conclusion: 'skipped' })]), stats([job(0, 1, 10)]));
});
test('queued cancellation contributes queue statistics but excludes aggregates', () => {
  const row = stats([job(0, 1, 10), job(2, null, 22)]);
  assert.equal(row.max_job_queue, 20);
  assert.equal(row.incomplete, true);
  assert.equal(summarize([row]).count, 0);
});
test('cancelled and empty attempts are excluded', () => {
  const row = stats([job(0, 1, 10)], { conclusion: 'cancelled' });
  assert.equal(summarize([row, stats([])]).cancelled, 1);
  assert.equal(summarize([row, stats([])]).count, 0);
  assert.equal(stats([]).wall, null);
});
test('nearest rank handles singleton, ten, forty and empty samples', () => {
  assert.equal(percentile([9], 0.9), 9);
  assert.equal(
    percentile(
      Array.from({ length: 10 }, (_, i) => i + 1),
      0.9,
    ),
    9,
  );
  assert.equal(
    percentile(
      Array.from({ length: 40 }, (_, i) => i + 1),
      0.9,
    ),
    36,
  );
  assert.equal(percentile([], 0.9), null);
});
test('burst tail is queueing rather than job execution', () => {
  const rows = Array.from({ length: 12 }, (_, i) => stats([job(0, i * 86, i * 86 + 258)]));
  const summary = summarize(rows);
  assert.equal(summary.run_time.p90, 258);
  assert.equal(summary.queue_time.p90, 860);
});
test('clock skew and missing creation timestamps are counted', () => {
  const row = stats([job(3, 2, 1), job(0, 5, 10, { created_at: null })]);
  assert.equal(row.skew, 2);
  assert.equal(row.missing_created, 1);
});
test('live fetches every attempt with injectable gh execution', () => {
  const calls = [];
  const exec = (command, args) => {
    assert.equal(command, 'gh');
    const endpoint = args[1];
    calls.push(endpoint);
    if (endpoint.includes('/workflows/')) return JSON.stringify({ workflow_runs: [{ ...run, run_attempt: 2 }] });
    if (endpoint.includes('/jobs')) return JSON.stringify({ jobs: [job(100, 101, 110)] });
    return JSON.stringify({ ...run, run_started_at: time(100) });
  };
  const output = [];
  assert.equal(main(['--live', '--repo', 'owner/repo', '--json'], { exec, write: (value) => output.push(value) }), 0);
  assert.equal(JSON.parse(output[0]).rows.length, 2);
  assert.ok(calls.includes('repos/owner/repo/actions/runs/1/attempts/2/jobs?per_page=100'));
});
test('fixture mode reads the same attempt data and rejects conflicting modes', () => {
  const output = [];
  const fixture = { runs: [run], jobs: { '1#1': [job(0, 1, 10)] } };
  assert.equal(
    main(['--fixture', 'data.json', '--json'], { read: () => JSON.stringify(fixture), write: (s) => output.push(s) }),
    0,
  );
  assert.equal(JSON.parse(output[0]).summary.count, 1);
  assert.equal(main(['--fixture', 'data.json', '--live'], { write: (s) => output.push(s) }), 2);
  assert.match(output.at(-1), /Usage:/);
});
