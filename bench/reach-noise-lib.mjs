import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function flagOf({ j1, j2, j3 }) {
  return (
    j1 === 'never-rendered' || (['never-ran', 'partly-ran'].includes(j2) && j3 !== 'reached') || j3 === 'never-rendered'
  );
}

export function autoLabel(unit, findings, hunk) {
  const tokens = unit.tokens ?? [];
  if (
    tokens.some((t) => (unit.headClasses ?? []).includes(t)) ||
    findings.some(
      (f) => (unit.paths ?? []).includes(f.path) || tokens.some((t) => (f.cls ?? '').split(/\s+/).includes(t)),
    )
  )
    return 'noise:join-miss';
  const lines = hunk
    .split('\n')
    .filter((s) => /^[+-](?![+-])/.test(s))
    .map((s) => s.slice(1).trim());
  return lines.length &&
    lines.every((s) => !s || /^\/\//.test(s) || /^import\s.*;\s*$/.test(s) || /^type\s+\w+\s*=\s*[^{}]+;\s*$/.test(s))
    ? 'noise:no-visual'
    : null;
}

export function aggregate(labels) {
  const out = { total: labels.length, real: 0, joinMiss: 0, noVisual: 0, unclassified: 0 };
  const keys = {
    real: 'real',
    'noise:join-miss': 'joinMiss',
    'noise:no-visual': 'noVisual',
    unclassified: 'unclassified',
  };
  for (const label of labels) {
    if (!Object.hasOwn(keys, label)) throw new Error('Unknown label');
    out[keys[label]]++;
  }
  return out;
}

export function verdict({ replayed, real }) {
  return !replayed ? 'NOT MEASURED' : real ? 'PASSED' : 'FAILED';
}

export function assertAggregateOnly(receipt) {
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const counts = (obj, keys) =>
    obj && Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k) && count(obj[k]));
  if (
    !receipt ||
    Object.keys(receipt).some((k) => !['prs', 'flags'].includes(k)) ||
    !counts(receipt.prs, ['attempted', 'replayed', 'unmeasured']) ||
    !counts(receipt.flags, ['total', 'real', 'joinMiss', 'noVisual', 'unclassified'])
  )
    throw new Error('Receipt must contain aggregate counts only');
  return receipt;
}

export function privateOutOk(out, repoRoot) {
  let current = path.resolve(out);
  while (!fs.existsSync(current)) current = path.dirname(current);
  current = fs.realpathSync(current);
  const root = fs.realpathSync(repoRoot);
  if (current === root || current.startsWith(`${root}${path.sep}`)) return false;
  try {
    execFileSync('git', ['-C', current, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

export function selectPairs(log, { globs, cap = 15 }) {
  return log
    .filter(
      (r) =>
        !/^revert\b/i.test(r.title) &&
        r.files.length <= 40 &&
        !r.dependencyOnly &&
        !/\b(?:bump|upgrade|update)\b.*\bdependenc/i.test(r.title) &&
        r.files.some((f) => globs.some((g) => path.matchesGlob(f, g)) && !/(^|\/)(?:tests?|e2e|__tests__)\//.test(f)),
    )
    .slice(0, Math.min(15, cap));
}
