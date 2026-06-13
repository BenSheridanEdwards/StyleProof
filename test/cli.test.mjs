import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveStyleMap } from '../dist/capture.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

// Two surfaces that differ in one longhand, and an identical pair.
function differingPair() {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(
    A,
    'home@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(0, 0, 0)' } } } }),
    null,
  );
  writeCapture(
    B,
    'home@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(255, 0, 0)' } } } }),
    null,
  );
  return { root, A, B };
}

function identicalPair() {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(0, 0, 0)' } } },
  });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  return { root, A, B };
}

// ---------------------------------------------------------------- styleproof-diff

test('diff CLI exits 0 when captures are identical', () => {
  const { root, A, B } = identicalPair();
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /surfaces identical/);
  rmTmp(root);
});

test('diff CLI exits 1 when captures differ', () => {
  const { root, A, B } = differingPair();
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /computed-style difference\(s\)/);
  rmTmp(root);
});

test('diff CLI exits 2 on wrong argument count', () => {
  const r = run(DIFF, ['only-one-dir']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: styleproof-diff/);
});

test('diff CLI exits 2 on an unknown flag', () => {
  const r = run(DIFF, ['a', 'b', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag: --bogus/);
});

test('diff CLI exits 2 when a capture dir does not exist', () => {
  const r = run(DIFF, ['/no/such/before', '/no/such/after']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no capture at/);
});

test('diff CLI --json writes the structured diff to a file', () => {
  const { root, A, B } = differingPair();
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(parsed.counts.style, 1);
  assert.ok(Array.isArray(parsed.surfaces));
  rmTmp(root);
});

test('diff CLI --json=PATH equals form is accepted', () => {
  const { root, A, B } = differingPair();
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, `--json=${jsonPath}`]);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(jsonPath));
  rmTmp(root);
});

test('diff CLI --max truncates the per-surface listing and prints a hint', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  // Several differing elements so the listing exceeds --max 1.
  const mk = (c) =>
    makeMap({
      elements: {
        'body > div:nth-child(1)': { tag: 'div', style: { color: c } },
        'body > div:nth-child(2)': { tag: 'div', style: { color: c } },
        'body > div:nth-child(3)': { tag: 'div', style: { color: c } },
      },
    });
  writeCapture(A, 'home@1280', mk('rgb(0, 0, 0)'), null);
  writeCapture(B, 'home@1280', mk('rgb(1, 1, 1)'), null);
  const r = run(DIFF, [A, B, '--max', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /more lines/);
  rmTmp(root);
});

test('diff CLI reads a plain .json capture against a .json.gz capture', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  saveStyleMap(
    path.join(A, 'home@1280.json'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'rgb(0, 0, 0)' } } } }),
  );
  saveStyleMap(
    path.join(B, 'home@1280.json.gz'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'rgb(9, 9, 9)' } } } }),
  );
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1);
  rmTmp(root);
});

// -------------------------------------------------------------- styleproof-report

test('report CLI exits 0 and writes an empty report when nothing changed', () => {
  const { root, A, B } = identicalPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no changes/);
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
  rmTmp(root);
});

test('report CLI exits 1 and writes a report when surfaces changed', () => {
  const { root, A, B } = differingPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  rmTmp(root);
});

test('report CLI exits 2 on wrong argument count', () => {
  const r = run(REPORT, ['only-one']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: styleproof-report/);
});

test('report CLI exits 2 on an unknown flag', () => {
  const r = run(REPORT, ['a', 'b', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag: --nope/);
});

// ------------------------------------------------------- error & validation paths

test('diff CLI exits 2 with a naming message on a corrupt .gz', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  fs.writeFileSync(path.join(A, 'home@1280.json.gz'), Buffer.from('this is not gzip'));
  fs.writeFileSync(path.join(B, 'home@1280.json.gz'), Buffer.from('this is not gzip'));
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /corrupt or truncated/);
  rmTmp(root);
});

test('diff CLI exits 2 on a non-numeric --max', () => {
  const { root, A, B } = identicalPair();
  const r = run(DIFF, [A, B, '--max', 'abc']);
  assert.equal(r.status, 2);
  rmTmp(root);
});

test('report CLI exits 2 on a non-numeric --pad', () => {
  const { root, A, B } = differingPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out, '--pad', 'xyz']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pad must be a number/);
  rmTmp(root);
});
