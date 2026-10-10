import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyMutation,
  formatHistory,
  normalizeFindings,
  scoreMutation,
  summarizeRun,
  validateTarget,
} from '../bench/mutation-harness/score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const target = (over = {}) => ({
  name: 'app',
  root: '../app',
  serve: { static: 'dist' },
  pages: [{ key: 'home', path: '/' }],
  mutations: [{ id: 'm1', file: 'a.css', find: 'red', replace: 'blue', expect: { selector: '.cta' } }],
  ...over,
});

test('validateTarget fills defaults for a static target', () => {
  const t = validateTarget(target());
  assert.deepEqual(t.widths, [1280]);
  assert.equal(t.serve.settleMs, 0);
  assert.deepEqual(t.copy, { exclude: ['.git', 'node_modules'], link: ['node_modules'] });
  assert.equal(t.mutations[0].category, 'other');
});

test('validateTarget names every problem at once', () => {
  assert.throws(
    () =>
      validateTarget(
        target({
          serve: { command: 'npm run dev', url: 'http://127.0.0.1:3000' },
          mutations: [
            { id: 'dup', file: 'a', find: 'x', replace: 'y', expect: { selector: '.a' } },
            { id: 'dup', file: 'a', find: 'x', replace: 'x', expect: {} },
          ],
        }),
      ),
    (e) =>
      e.message.includes('{port}') &&
      e.message.includes('unique') &&
      e.message.includes('identical') &&
      e.message.includes('clean: true'),
  );
});

test('the committed demo target validates', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/mutation-targets/demo.json'), 'utf8'));
  const t = validateTarget(raw);
  const source = fs.readFileSync(path.join(ROOT, 'bench/mutation-targets', t.root, 'index.html'), 'utf8');
  for (const m of t.mutations) assert.notEqual(applyMutation(source, m), source);
});

test('applyMutation requires exactly one occurrence', () => {
  const m = { id: 'm', file: 'a.css', find: 'red', replace: '$&blue' };
  assert.equal(applyMutation('a{color:red}', m), 'a{color:$&blue}');
  assert.throws(() => applyMutation('a{color:blue}', m), /occurs 0 times/);
  assert.throws(() => applyMutation('a{color:red;fill:red}', m), /occurs 2 times/);
});

const style = (path, props) => ({ kind: 'style', path, cls: '', pseudo: null, props: props.map((prop) => ({ prop })) });

test('scoreMutation: a finding on the target with the expected prop is a clean detection', () => {
  const findings = normalizeFindings('home@1280', [style('body > main > button', ['background-color'])], []);
  const r = scoreMutation(
    { id: 'm', category: 'color', expect: { selector: '.cta', props: ['background'] } },
    findings,
    { 'home@1280': ['body > main > button'] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.detected, true);
  assert.equal(r.precision, 1);
});

test('scoreMutation: descendants count as target, allow paths are not stray, the rest is', () => {
  const findings = normalizeFindings(
    'home@1280',
    [style('body > main', ['color']), style('body > main > p', ['color']), style('body > footer', ['color'])],
    [{ kind: 'text', path: 'body > nav', cls: 'nav' }],
  );
  const r = scoreMutation({ id: 'm', category: 'color', expect: { selector: 'main' } }, findings, {
    'home@1280': ['body > main'],
  });
  assert.equal(r.onTarget, 2);
  assert.equal(r.stray, 2);
  assert.equal(r.precision, 0.5);
  assert.equal(r.ok, false);
  assert.match(r.why, /2 stray/);
  const allowed = scoreMutation(
    { id: 'm', category: 'color', expect: { selector: 'main' } },
    findings,
    { 'home@1280': ['body > main'] },
    { 'home@1280': ['body > footer', 'body > nav'] },
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.precision, 1);
});

test('scoreMutation: wrong prop is imprecise; unresolved selector says so; clean needs zero findings', () => {
  const findings = normalizeFindings('home@1280', [style('body > a', ['color'])], []);
  const imprecise = scoreMutation(
    { id: 'm', category: 'color', expect: { selector: 'a', props: ['background-color'] } },
    findings,
    { 'home@1280': ['body > a'] },
  );
  assert.equal(imprecise.detected, false);
  assert.match(imprecise.why, /imprecise/);
  const unresolved = scoreMutation({ id: 'm', category: 'color', expect: { selector: '.gone' } }, [], {
    'home@1280': [],
  });
  assert.match(unresolved.why, /matched no element/);
  const clean = scoreMutation({ id: 'm', category: 'equivalent', expect: { clean: true } }, []);
  assert.deepEqual([clean.ok, clean.detected, clean.precision], [true, null, null]);
  const noisy = scoreMutation({ id: 'm', category: 'equivalent', expect: { clean: true } }, findings);
  assert.equal(noisy.ok, false);
  assert.equal(noisy.stray, 1);
});

test('summarizeRun and formatHistory', () => {
  const results = [
    { expect: 'detect', ok: true, detected: true, stray: 0, precision: 1, runtimeMs: 900 },
    { expect: 'detect', ok: false, detected: false, stray: 2, precision: 0, runtimeMs: 1200 },
    { expect: 'clean', ok: true, detected: null, stray: 0, precision: null, runtimeMs: 1000 },
  ];
  const totals = summarizeRun(results);
  assert.deepEqual(totals, {
    mutations: 3,
    passed: 2,
    detected: '1/2',
    detectionRate: 0.5,
    falsePositiveRate: 1 / 3,
    meanPrecision: 0.5,
    medianRuntimeMs: 1000,
  });
  const lines = formatHistory([
    {
      at: '2026-01-02T03:04:05.000Z',
      styleproof: { version: '7.6.0', commit: 'abc1234', dirty: true },
      target: { name: 'app' },
      totals,
    },
  ]);
  assert.equal(lines.length, 2);
  assert.match(
    lines[1],
    /^2026-01-02 03:04:05 {2}7\.6\.0@abc1234\+dirty {2}app +50\.0% \(1\/2\) +33\.3% +50\.0% +1000 ms$/,
  );
});
