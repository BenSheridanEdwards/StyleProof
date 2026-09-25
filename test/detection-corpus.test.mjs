// Static contract for the detection-rate corpus (bench/detection-rate.mjs).
// The runner itself needs Chromium and is exercised manually via
// `npm run bench:detection`; these tests guarantee the corpus stays coherent
// and that the committed receipt (bench/detection-corpus.results.json) was
// produced by the corpus on disk — so the published rate can't silently drift
// from what a reviewer sees.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'detection-corpus.json'), 'utf8'));
const fixture = fs.readFileSync(path.join(ROOT, corpus.fixture), 'utf8');
const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'detection-corpus.results.json'), 'utf8'));

const EXPECTATIONS = ['detect', 'clean', 'blind'];
const markerOf = (sel) => sel.replace(/^\./, '');

describe('detection corpus schema', () => {
  test('fixture exists and every documented expectation is a known outcome', () => {
    assert.ok(fixture.length > 0);
    for (const key of Object.keys(corpus.expectations))
      assert.ok(EXPECTATIONS.includes(key), `unknown expectation ${key}`);
  });

  test('case ids are unique, expectations valid, every case is described', () => {
    const ids = new Set();
    for (const c of corpus.cases) {
      assert.ok(c.id, 'case missing id');
      assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
      ids.add(c.id);
      assert.ok(EXPECTATIONS.includes(c.expect), `${c.id}: bad expect ${c.expect}`);
      assert.ok(c.desc?.length, `${c.id}: missing desc`);
      assert.ok(c.css || c.attr || c.text, `${c.id}: no mutation channel`);
    }
    assert.ok(corpus.cases.length >= 30, 'corpus too small to give a meaningful rate');
  });

  test('detect cases carry a target selector whose marker exists in the fixture', () => {
    for (const c of corpus.cases) {
      if (!c.sel) {
        assert.notEqual(c.expect, 'detect', `${c.id}: detect without a target selector`);
        continue;
      }
      assert.ok(c.sel.startsWith('.sp-'), `${c.id}: target must be a marker class (.sp-*)`);
      assert.ok(fixture.includes(`"${markerOf(c.sel)}"`), `${c.id}: marker ${c.sel} not in fixture`);
    }
  });

  test('corpus mixes detect, clean, and blind cases', () => {
    for (const expect of EXPECTATIONS)
      assert.ok(
        corpus.cases.some((c) => c.expect === expect),
        `no ${expect} cases`,
      );
  });
});

describe('detection corpus receipt', () => {
  test('receipt covers exactly the corpus cases, all passing', () => {
    assert.deepEqual(
      receipt.cases.map((c) => c.id).sort(),
      corpus.cases.map((c) => c.id).sort(),
      'receipt was not generated from this corpus — rerun npm run bench:detection',
    );
    assert.deepEqual(receipt.totals.failed, [], 'receipt records violated expectations');
    for (const c of receipt.cases) assert.ok(c.ok, `${c.id} failed in committed receipt`);
  });

  test('receipt totals are internally consistent', () => {
    const byExpect = (e) => receipt.cases.filter((c) => c.expect === e);
    assert.equal(receipt.totals.cases, receipt.cases.length);
    assert.equal(receipt.totals.detected.split('/')[1], String(byExpect('detect').length));
    assert.ok(receipt.totals.detectionRate > 0 && receipt.totals.detectionRate <= 1);
  });
});
