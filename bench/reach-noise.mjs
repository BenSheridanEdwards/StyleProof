// Private adapters write evidence.json to REACH_OUT: maps keyed by surface,
// coverage entries per surface, and sourceMaps keyed by coverage URL. Nothing
// from the consumer is printed or written into this checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { classifyRuleReach } from '../dist/rule-reach.js';
import { diffStyleMaps } from '../dist/diff.js';
import { classVocabulary, classReach, jsReach, lineExecution, diffHunks, coverageProjection } from './reach-joins.mjs';
import { flagOf, autoLabel, aggregate, privateOutOk, selectPairs, rawOnlyDriftCount } from './reach-noise-lib.mjs';

const { values: a } = parseArgs({
  options: Object.fromEntries(
    ['repo', 'pairs', 'build', 'capture', 'globs', 'private-out', 'labels', 'prepare', 'gate', 'cutoff'].map((k) => [
      k,
      { type: 'string' },
    ]),
  ),
});
for (const key of ['repo', 'build', 'capture', 'globs', 'private-out', 'labels', 'gate'])
  if (!a[key]) throw new Error(`Missing --${key}`);
if (!privateOutOk(a['private-out'], process.cwd()) || !privateOutOk(a.labels, process.cwd()))
  throw new Error('Output must be outside every git worktree');
const out = path.resolve(a['private-out']);
fs.mkdirSync(out, { recursive: true });
const started = Date.now();
const deadline = started + 60 * 60_000;
const git = (...args) => execFileSync('git', ['-C', a.repo, ...args], { encoding: 'utf8' }).trim();
if (git('remote')) throw new Error('Replay requires a disposable clone with no remotes');
const write = (name, obj) => fs.writeFileSync(path.join(out, name), JSON.stringify(obj, null, 2));
const append = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
const counts = { attempted: 0, replayed: 0, unmeasured: 0 };
const labels = [];
const reviewed = new Map(
  (fs.existsSync(a.labels) ? fs.readFileSync(a.labels, 'utf8').trim().split('\n').filter(Boolean) : []).map((s) => {
    const row = JSON.parse(s);
    return [row.id, row.label];
  }),
);
const statusCounts = { J1: {}, J2: {}, J3: {} };
const summary = (reason) => {
  write('run.json', { prs: counts, flags: aggregate(labels), statusCounts, reason, wallMs: Date.now() - started });
  console.log(JSON.stringify({ prs: counts, flags: aggregate(labels) }));
};
const command = (cmd, dir, log) => {
  const fd = fs.openSync(path.join(out, log), 'a');
  try {
    execFileSync('/bin/sh', ['-c', cmd], {
      cwd: a.repo,
      env: { ...process.env, REACH_OUT: dir },
      stdio: ['ignore', fd, fd],
      timeout: Math.max(1, deadline - Date.now()),
    });
  } finally {
    fs.closeSync(fd);
  }
};
const supplied = a.pairs ?? process.env.REACH_NOISE_PAIRS;
const cutoff = a.cutoff ?? git('rev-parse', 'HEAD');
let selected = 0;
const log = supplied
  ? JSON.parse(fs.readFileSync(supplied, 'utf8'))
  : git('log', '--first-parent', '--format=%H', cutoff)
      .split('\n')
      .flatMap((head) => {
        if (selected >= 15) return [];
        try {
          const base = git('rev-parse', `${head}^1`);
          const files = git('diff', '--name-only', base, head).split('\n');
          const row = {
            base,
            head,
            files,
            title: git('show', '-s', '--format=%s', head),
            dependencyOnly: files.every((f) => /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)),
          };
          if (selectPairs([row], { globs: a.globs.split(',') }).length) selected++;
          return [row];
        } catch {
          return [];
        }
      });
const pairs = selectPairs(log, { globs: a.globs.split(','), cap: 15 });
write('selection.json', { cutoff, pairs });
if (!pairs.length) {
  summary('no eligible pairs');
  process.exit(1);
}
const cache = new Map();
fs.writeFileSync(path.join(out, 'detail.jsonl'), '');
fs.writeFileSync(path.join(out, 'review-needed.md'), '# Flags needing review\n');
if (!fs.existsSync(a.labels)) fs.writeFileSync(a.labels, '');
function capture(sha, suffix = '') {
  if (!suffix && cache.has(sha)) return cache.get(sha);
  const dir = path.join(out, 'captures', `${sha}${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  git('reset', '--hard', sha);
  if (a.prepare) command(a.prepare, dir, 'prepare.log');
  command(a.build, dir, 'build.log');
  command(a.capture, dir, 'capture.log');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
  if (!Object.keys(data.maps ?? {}).length || !data.coverage?.length || !Object.keys(data.sourceMaps ?? {}).length)
    throw new Error('Missing maps, coverage or source maps');
  cache.set(`${sha}${suffix}`, data);
  return data;
}
function evaluate(pair, base, head) {
  const surfaces = Object.keys(base.maps);
  if (!isDeepStrictEqual(surfaces.sort(), Object.keys(head.maps).sort())) throw new Error('Surface mismatch');
  const maps = surfaces.map((s) => ({ base: base.maps[s], head: head.maps[s] }));
  const findings = maps.flatMap((p) => diffStyleMaps(p.base, p.head));
  const j1 = classifyRuleReach(Object.values(base.maps), Object.values(head.maps));
  const vocabulary = classVocabulary(
    [base, head].flatMap((d) => Object.values(d.maps).flatMap((m) => (m.reach?.rules ?? []).map((r) => r.key))),
  );
  const headClasses = [
    ...new Set(
      Object.values(head.maps).flatMap((m) => Object.values(m.elements).flatMap((e) => (e.cls ?? '').split(/\s+/))),
    ),
  ];
  const hunk = git('diff', '--no-color', '-U3', pair.base, pair.head);
  const units = j1.rules.map((r) => ({
    key: r.key,
    j1: j1.ledger === 'complete' ? r.status : 'partial',
    j2: 'n/a',
    j3: 'n/a',
    why: r.why,
    hunk,
    tokens: [...classVocabulary([r.key])],
    headClasses,
  }));
  units.push(...jsUnits(pair, base, head, vocabulary, maps, headClasses));
  return { surfaces, findings, units, ledger: j1.ledger };
}
function jsUnits(pair, base, head, vocabulary, maps, headClasses) {
  return pair.files
    .filter((f) => /\.[jt]sx?$/.test(f))
    .flatMap((file) => fileUnits(file, pair, base, head, vocabulary, maps, headClasses));
}
function fileUnits(file, pair, base, head, vocabulary, maps, headClasses) {
  const units = [];
  const texts = {};
  for (const [side, sha] of [
    ['base', pair.base],
    ['head', pair.head],
  ]) {
    try {
      texts[side] = git('show', `${sha}:${file}`);
    } catch {
      texts[side] = '';
    }
    fs.writeFileSync(path.join(out, `${side}.source`), texts[side]);
  }
  const executions = (data) =>
    data.coverage.flatMap((c) =>
      c.entries.flatMap((e) => (data.sourceMaps[e.url] ? [lineExecution(e, data.sourceMaps[e.url], file)] : [])),
    );
  const runs = { base: executions(base), head: executions(head) };
  for (const h of diffHunks(path.join(out, 'base.source'), path.join(out, 'head.source')))
    units.push(...hunkUnits(h, { file, texts, runs, vocabulary, maps, headClasses }));
  return units;
}
function hunkUnits(h, { file, texts, runs, vocabulary, maps, headClasses }) {
  const units = [];
  for (let i = 0; i < Math.max(h.base.length, h.head.length); i++) {
    const b = texts.base.split('\n')[h.base[i] - 1] ?? '';
    const t = texts.head.split('\n')[h.head[i] - 1] ?? '';
    const j3 = classReach(b, t, vocabulary, maps);
    units.push({
      key: `${file}:${h.head[i] ?? h.base[i]}`,
      j1: 'n/a',
      j2: jsReach(h.head[i] ?? h.base[i], runs[h.head[i] ? 'head' : 'base']),
      j3: j3.status,
      tokens: [...j3.added, ...j3.removed],
      headClasses,
      hunk: `-${b}\n+${t}`,
    });
  }
  return units;
}
try {
  command(a.gate, out, 'load.log');
  const first = capture(pairs[0].base);
  write('step0.json', { status: 'GO' });
  command(a.gate, out, 'load.log');
  const twice = capture(pairs[0].base, '-determinism');
  const firstProjection = coverageProjection(first);
  const twiceProjection = coverageProjection(twice);
  const coverageSurfaces = [...new Set([...Object.keys(firstProjection), ...Object.keys(twiceProjection)])];
  const projectionDrift = coverageSurfaces.filter(
    (s) => !isDeepStrictEqual(firstProjection[s], twiceProjection[s]),
  ).length;
  const rawOnlyDriftOutsideAppProjection = rawOnlyDriftCount(first, twice, firstProjection, twiceProjection);
  const determinism = { projectionDrift, rawOnlyDriftOutsideAppProjection, surfaces: coverageSurfaces.length };
  const stable = Object.keys(first.maps).every(
    (s) =>
      twice.maps[s] &&
      !diffStyleMaps(first.maps[s], twice.maps[s]).length &&
      isDeepStrictEqual(first.maps[s].reach, twice.maps[s].reach),
  );
  if (
    !stable ||
    !isDeepStrictEqual(firstProjection, twiceProjection) ||
    !isDeepStrictEqual(Object.keys(first.maps), Object.keys(twice.maps))
  ) {
    write('determinism.json', { status: 'FAILED', ...determinism });
    summary('unmeasured: harness non-deterministic');
    process.exit(1);
  }
  write('determinism.json', { status: 'PASSED', ...determinism });
  command(a.gate, out, 'load.log');
  for (const pair of pairs) {
    if (counts.replayed >= 12 || Date.now() >= deadline) break;
    counts.attempted++;
    try {
      const detail = evaluate(pair, capture(pair.base), capture(pair.head));
      append(path.join(out, 'detail.jsonl'), { pair, ...detail });
      for (const [i, unit] of detail.units.entries()) {
        for (const [join, key] of [
          ['J1', 'j1'],
          ['J2', 'j2'],
          ['J3', 'j3'],
        ])
          statusCounts[join][unit[key]] = (statusCounts[join][unit[key]] ?? 0) + 1;
        if (!flagOf(unit)) continue;
        const id = `${pair.head}:${i}`;
        const label = reviewed.get(id) ?? autoLabel(unit, detail.findings, unit.hunk);
        if (!reviewed.has(id)) append(a.labels, { id, label });
        labels.push(label ?? 'unclassified');
        if (!label)
          fs.appendFileSync(
            path.join(out, 'review-needed.md'),
            `\n## ${id}\n\n\`\`\`json\n${JSON.stringify({ unit, findings: detail.findings, surfaces: detail.surfaces }, null, 2)}\n\`\`\`\n`,
          );
      }
      counts.replayed++;
    } catch (error) {
      counts.unmeasured++;
      append(path.join(out, 'detail.jsonl'), { pair, error: String(error) });
    }
  }
  summary('replay complete');
} catch (error) {
  write('failure.json', { error: String(error) });
  if (!fs.existsSync(path.join(out, 'step0.json'))) write('step0.json', { status: 'NO-GO' });
  summary('unmeasured: capture failed');
  process.exitCode = 1;
}
