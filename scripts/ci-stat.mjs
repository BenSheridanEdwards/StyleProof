import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Fixtures: { runs: [...], attempts: { 'runId#attempt': metadata },
// jobs: { 'runId#attempt': [...] } }; reruns require attempt metadata.
// The greedy temporal chain makes queue_time an upper bound on waiting time.
// Cancelled, incomplete or empty attempts are excluded from summary aggregates.

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}

// Seconds throughout; infer a temporal chain without parsing YAML dependencies.
export function attemptStats(run, jobs, now = Date.now()) {
  const attempt = run.attempt ?? 1;
  const origin = Date.parse(attempt === 1 ? run.created_at : run.run_started_at);
  const row = {
    id: `${run.id}#${attempt}`,
    cancelled: run.conclusion === 'cancelled',
    incomplete: run.status !== 'completed',
    skew: 0,
    missing_created: 0,
  };
  const clamp = (value) => {
    if (value < 0) row.skew++;
    return Math.max(0, value);
  };
  const measured = jobs
    .filter(
      (job) =>
        job.conclusion !== 'skipped' &&
        (job.run_attempt != null
          ? job.run_attempt === attempt
          : !job.started_at || Date.parse(job.started_at) >= origin),
    )
    .map((job) => {
      if (!job.created_at) row.missing_created++;
      const created = job.created_at ? Date.parse(job.created_at) : origin;
      const start = job.started_at ? Date.parse(job.started_at) : null;
      const end = job.completed_at ? Date.parse(job.completed_at) : now;
      if (start === null || !job.completed_at) row.incomplete = true;
      return {
        created,
        start,
        end,
        queue: clamp((start ?? end) - created) / 1000,
        duration: start === null ? 0 : clamp(end - start) / 1000,
      };
    });
  const started = measured.filter((job) => job.start !== null);
  let cursor = Infinity;
  let execution = 0;
  for (const job of [...started].sort((a, b) => b.end - a.end)) {
    if (job.end <= cursor) {
      execution += job.duration;
      cursor = Math.min(cursor, job.start);
    }
  }
  const wall = started.length ? (Math.max(...started.map((job) => job.end)) - origin) / 1000 : null;
  const runQueue = measured.length ? clamp(Math.min(...measured.map((job) => job.created)) - origin) / 1000 : null;
  return {
    ...row,
    wall,
    run_queue: runQueue,
    run_time: wall === null ? null : execution,
    queue_time: wall === null ? null : wall - execution,
    max_job_queue: measured.length ? Math.max(...measured.map((job) => job.queue)) : null,
    median_job_queue: percentile(
      measured.map((job) => job.queue),
      0.5,
    ),
  };
}

export function summarize(rows) {
  const eligible = rows.filter((row) => !row.cancelled && !row.incomplete && row.wall !== null);
  return {
    count: eligible.length,
    cancelled: rows.filter((row) => row.cancelled).length,
    excluded: rows.length - eligible.length,
    ...Object.fromEntries(
      ['wall', 'queue_time', 'run_time'].map((key) => [
        key,
        {
          median: percentile(
            eligible.map((row) => row[key]),
            0.5,
          ),
          p90: percentile(
            eligible.map((row) => row[key]),
            0.9,
          ),
        },
      ]),
    ),
  };
}

function liveData(options, exec) {
  const api = (endpoint) =>
    JSON.parse(exec('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
  const root = `repos/${options.repo}/actions`;
  const runs = api(`${root}/workflows/${options.workflow}/runs?per_page=${options.limit}`).workflow_runs;
  const attempts = {};
  const jobs = {};
  for (const run of runs) {
    for (let n = 1; n <= (run.run_attempt ?? 1); n++) {
      const key = `${run.id}#${n}`;
      const endpoint = `${root}/runs/${run.id}/attempts/${n}`;
      attempts[key] = api(endpoint);
      jobs[key] = [];
      for (let page = 1; ; page++) {
        const batch = api(`${endpoint}/jobs?per_page=100${page === 1 ? '' : `&page=${page}`}`).jobs;
        jobs[key].push(...batch);
        if (batch.length < 100) break;
      }
    }
  }
  return { runs, attempts, jobs };
}

function parseArgs(args) {
  const options = { repo: 'BenSheridanEdwards/StyleProof', workflow: 'ci.yml', limit: '40' };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Expected -- option: ${args[i]}`);
    const key = args[i].replace(/^--/, '');
    if (['live', 'json'].includes(key)) options[key] = true;
    else if (['fixture', 'repo', 'workflow', 'limit'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--'))
      options[key] = args[++i];
    else throw new Error(`Unknown or missing option: ${args[i]}`);
  }
  if (
    Boolean(options.live) === Boolean(options.fixture) ||
    !/^\d+$/.test(options.limit) ||
    +options.limit < 1 ||
    +options.limit > 100
  )
    throw new Error('Choose one source; limit must be 1..100');
  return options;
}

export function main(args, { exec = execFileSync, read = readFileSync, write = console.log } = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    write(
      `Usage: ci-stat --fixture FILE | --live [--repo O/R] [--workflow ci.yml] [--limit 40] [--json]\n${error.message}`,
    );
    return 2;
  }
  const data = options.live ? liveData(options, exec) : JSON.parse(read(options.fixture, 'utf8'));
  const rows = data.runs.flatMap((run) =>
    Array.from({ length: run.run_attempt ?? 1 }, (_, index) => {
      const attempt = index + 1;
      const key = `${run.id}#${attempt}`;
      const metadata = data.attempts?.[key] ?? run;
      if (attempt > 1 && !data.attempts?.[key]) throw new Error(`Missing attempt metadata: ${key}`);
      return attemptStats({ ...run, ...metadata, attempt }, data.jobs[key] ?? []);
    }),
  );
  const summary = summarize(rows);
  if (options.json) write(JSON.stringify({ rows, summary }, null, 2));
  else {
    write('Seconds; inferred temporal critical path (not YAML dependencies).');
    for (const row of rows) write(JSON.stringify(row));
    write(`Summary: ${JSON.stringify(summary)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
