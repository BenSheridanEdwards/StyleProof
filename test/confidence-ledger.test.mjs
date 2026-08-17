// Confidence ledger (#399) — the first-class "how complete and trustworthy was
// the capture?" artifact. Producers (#390 auth, #398 incomplete UI, coverage,
// determinism) write into one schema; visual PASS and completeness stay two
// badges; old bundles degrade to `unknown` and never block retroactively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIDENCE_LEDGER,
  buildConfidenceLedger,
  summarizeConfidence,
  writeConfidenceLedger,
  readConfidenceLedger,
  resolveBundleConfidence,
} from '../dist/confidence-ledger.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';

const coverage = (over = {}) => ({ version: 1, expected: null, exclude: {}, ...over });

test('captured surfaces with an asserted registry and proven determinism read complete', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home', 'about'],
    coverage: coverage({ expected: ['home', 'about'], determinism: 'self-checked' }),
  });
  assert.equal(ledger.basis, 'asserted');
  assert.deepEqual(
    ledger.entries.map((e) => [e.surface, e.status, e.producer]),
    [
      ['about', 'captured', 'capture'],
      ['home', 'captured', 'capture'],
    ],
  );
  const summary = summarizeConfidence(ledger);
  assert.equal(summary.completeness, 'complete');
  assert.equal(summary.counts.captured, 2);
});

test('coverage producers: exclusions carry their reason, uncovered registry keys are unknown', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home'],
    coverage: coverage({
      expected: ['home', 'account', 'pricing'],
      exclude: { account: 'Authentication fixture is not available.' },
      determinism: 'self-checked',
    }),
  });
  const byKey = Object.fromEntries(ledger.entries.map((e) => [e.surface, e]));
  assert.equal(byKey.account.status, 'excluded-with-reason');
  assert.equal(byKey.account.producer, 'coverage');
  assert.equal(byKey.account.reason, 'Authentication fixture is not available.');
  assert.equal(byKey.pricing.status, 'unknown');
  assert.match(byKey.pricing.reason, /never captured/);
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('unproven determinism downgrades every captured surface — a green without proof is not certified', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home'],
    coverage: coverage({ expected: ['home'], determinism: 'unproven' }),
  });
  assert.equal(ledger.entries[0].status, 'unproven-determinism');
  assert.equal(ledger.entries[0].producer, 'determinism');
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('an asserted coverage ledger without determinism proof cannot claim complete confidence', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home'],
    coverage: coverage({ expected: ['home'] }),
  });
  assert.equal(ledger.entries[0].status, 'unproven-determinism');
  assert.equal(ledger.entries[0].producer, 'determinism');
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('auth producer (#390): unacknowledged walls are inaccessible, acknowledged ones excluded-with-reason', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['landing'],
    coverage: null,
    auth: {
      acknowledged: [{ key: '/admin·password-input', reason: 'Admin console is out of certification scope.' }],
      unacknowledged: [{ key: '/login·password-input' }],
    },
  });
  const byKey = Object.fromEntries(ledger.entries.map((e) => [e.surface, e]));
  assert.equal(byKey['/login·password-input'].status, 'inaccessible');
  assert.equal(byKey['/login·password-input'].producer, 'auth-boundary');
  assert.equal(byKey['/admin·password-input'].status, 'excluded-with-reason');
  // A wall outranks the unasserted basis: the run is limited, not merely unasserted.
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('incomplete-UI producer (#398): blocked continuations are inaccessible with classifier reasons', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['checkout'],
    coverage: null,
    incompleteUi: [{ surface: '/checkout·form', reasons: ['form-present', 'required-input-empty'] }],
  });
  const blocked = ledger.entries.find((e) => e.surface === '/checkout·form');
  assert.equal(blocked.status, 'inaccessible');
  assert.equal(blocked.producer, 'incomplete-ui');
  assert.match(blocked.reason, /form-present, required-input-empty/);
});

test('one row per surface: the strongest honesty signal wins and no percentage is ever emitted', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home'],
    coverage: coverage({ expected: ['home'], exclude: {}, determinism: 'self-checked' }),
    auth: { acknowledged: [], unacknowledged: [{ key: 'home' }] },
  });
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].status, 'inaccessible');
  assert.doesNotMatch(JSON.stringify(ledger), /%/);
});

test('a non-captured entry without a reason is rejected — silence cannot mark scope limited', () => {
  assert.throws(
    () =>
      buildConfidenceLedger({
        capturedKeys: [],
        coverage: null,
        incompleteUi: [{ surface: '/x', reasons: [] }],
      }),
    /non-empty reason/,
  );
});

test('no registry and no determinism proof stays limited without claiming an enumerable universe', () => {
  const ledger = buildConfidenceLedger({ capturedKeys: ['page'], coverage: null });
  assert.equal(ledger.basis, 'unasserted');
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('a bundle without the ledger degrades to unknown — advisory, never a retroactive block', () => {
  assert.equal(summarizeConfidence(null).completeness, 'unknown');
});

test('write/read roundtrip; missing and malformed files degrade to null instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-'));
  try {
    assert.equal(readConfidenceLedger(dir), null);
    const ledger = buildConfidenceLedger({
      capturedKeys: ['home'],
      coverage: coverage({ expected: ['home'], determinism: 'self-checked' }),
    });
    writeConfidenceLedger(dir, ledger);
    assert.deepEqual(readConfidenceLedger(dir), ledger);
    fs.writeFileSync(path.join(dir, CONFIDENCE_LEDGER), '{corrupt');
    assert.equal(readConfidenceLedger(dir), null);
    // A structurally-valid file whose non-captured entry lost its reason is rejected too.
    fs.writeFileSync(
      path.join(dir, CONFIDENCE_LEDGER),
      JSON.stringify({ version: 1, basis: 'asserted', entries: [{ surface: 'x', status: 'inaccessible' }] }),
    );
    assert.equal(readConfidenceLedger(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed producer, empty surface, and duplicate rows degrade to null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-invalid-schema-'));
  const write = (entries) =>
    fs.writeFileSync(path.join(dir, CONFIDENCE_LEDGER), JSON.stringify({ version: 1, basis: 'asserted', entries }));
  try {
    write([{ surface: 'home', status: 'captured', producer: 'invented' }]);
    assert.equal(readConfidenceLedger(dir), null);

    write([{ surface: '', status: 'captured', producer: 'capture' }]);
    assert.equal(readConfidenceLedger(dir), null);

    write([
      { surface: 'home', status: 'captured', producer: 'capture' },
      { surface: 'home', status: 'inaccessible', producer: 'auth-boundary', reason: 'Authentication boundary.' },
    ]);
    assert.equal(readConfidenceLedger(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBundleConfidence derives from the coverage ledger + maps when no file was persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-derive-'));
  try {
    fs.writeFileSync(path.join(dir, 'home@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    fs.writeFileSync(
      path.join(dir, COVERAGE_LEDGER),
      JSON.stringify(coverage({ expected: ['home', 'about'], determinism: 'self-checked' })),
    );
    const ledger = resolveBundleConfidence(dir);
    const byKey = Object.fromEntries(ledger.entries.map((e) => [e.surface, e.status]));
    assert.equal(byKey.home, 'captured');
    assert.equal(byKey.about, 'unknown');
    assert.equal(ledger.basis, 'asserted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('derived confidence maps expanded capture keys through the asserted registry vocabulary', () => {
  for (const expected of ['home', 'home-loaded']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-expanded-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'home-loaded@1440.json'),
        JSON.stringify({ defaults: {}, elements: {}, states: {}, metadata: { surfaceKey: 'home' } }),
      );
      fs.writeFileSync(
        path.join(dir, COVERAGE_LEDGER),
        JSON.stringify(coverage({ expected: [expected], determinism: 'self-checked' })),
      );
      const ledger = resolveBundleConfidence(dir);
      assert.deepEqual(
        ledger.entries.map((e) => [e.surface, e.status]),
        [[expected, 'captured']],
      );
      assert.equal(summarizeConfidence(ledger).completeness, 'complete');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('resolveBundleConfidence merges a persisted producer file over the derived set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-merge-'));
  try {
    fs.writeFileSync(path.join(dir, 'landing@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    writeConfidenceLedger(
      dir,
      buildConfidenceLedger({
        capturedKeys: ['landing'],
        coverage: null,
        auth: { acknowledged: [], unacknowledged: [{ key: '/login·password-input' }] },
      }),
    );
    const ledger = resolveBundleConfidence(dir);
    const byKey = Object.fromEntries(ledger.entries.map((e) => [e.surface, e.status]));
    assert.equal(byKey.landing, 'unproven-determinism');
    assert.equal(byKey['/login·password-input'], 'inaccessible');
    assert.equal(summarizeConfidence(ledger).completeness, 'limited');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persisted or coverage ledgers cannot overstate confidence or crash reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-malformed-resolve-'));
  try {
    fs.writeFileSync(path.join(dir, 'home@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    fs.writeFileSync(
      path.join(dir, COVERAGE_LEDGER),
      JSON.stringify(coverage({ expected: ['home'], determinism: 'self-checked' })),
    );
    fs.writeFileSync(
      path.join(dir, CONFIDENCE_LEDGER),
      JSON.stringify({
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'home', status: 'captured', producer: 'invented' }],
      }),
    );
    assert.equal(resolveBundleConfidence(dir), null, 'present malformed confidence must not derive complete');

    fs.rmSync(path.join(dir, CONFIDENCE_LEDGER));
    fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify({ version: 1, expected: {}, exclude: {} }));
    assert.doesNotThrow(() => resolveBundleConfidence(dir));
    assert.equal(resolveBundleConfidence(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persisted confidence rejects producer/status contradictions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-producer-status-'));
  try {
    fs.writeFileSync(
      path.join(dir, CONFIDENCE_LEDGER),
      JSON.stringify({
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'home', status: 'captured', producer: 'auth-boundary' }],
      }),
    );
    assert.equal(readConfidenceLedger(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crawl captures without determinism provenance are explicitly unproven', () => {
  const ledger = buildConfidenceLedger({ capturedKeys: ['home'], coverage: null });
  assert.deepEqual(ledger.entries, [
    {
      surface: 'home',
      status: 'unproven-determinism',
      producer: 'determinism',
      reason: 'captured without self-check or replay — the styles could have drifted unnoticed',
    },
  ]);
});

test('prototype-named expected surfaces cannot disappear through inherited exclusions', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: [],
    coverage: coverage({ expected: ['toString', '__proto__'], exclude: {} }),
  });
  assert.deepEqual(
    ledger.entries.map(({ surface, status, producer }) => ({ surface, status, producer })),
    [
      { surface: '__proto__', status: 'unknown', producer: 'coverage' },
      { surface: 'toString', status: 'unknown', producer: 'coverage' },
    ],
  );
});

test('persisted crawl producer truth ignores partial map artifacts for failed surfaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-partial-crawl-'));
  try {
    fs.writeFileSync(path.join(dir, 'good@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    fs.writeFileSync(path.join(dir, 'failed@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    writeConfidenceLedger(dir, buildConfidenceLedger({ capturedKeys: ['good'], coverage: null }));
    const ledger = resolveBundleConfidence(dir);
    assert.deepEqual(
      ledger.entries.map((entry) => entry.surface),
      ['good'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger builders reject empty producer surface keys', () => {
  assert.throws(() => buildConfidenceLedger({ capturedKeys: [''], coverage: null }), /non-empty surface/);
  assert.throws(
    () =>
      buildConfidenceLedger({
        capturedKeys: [],
        coverage: null,
        auth: { acknowledged: [], unacknowledged: [{ key: '   ' }] },
      }),
    /non-empty surface/,
  );
});

test('discovered crawl surfaces that were not fully captured stay named and limited', () => {
  const ledger = buildConfidenceLedger({
    capturedKeys: ['home'],
    coverage: null,
    captureGaps: [
      {
        surface: 'menu-open',
        reason: 'crawl stopped before this discovered surface was captured',
      },
    ],
  });
  assert.deepEqual(
    ledger.entries.map(({ surface, status, producer }) => ({ surface, status, producer })),
    [
      { surface: 'home', status: 'unproven-determinism', producer: 'determinism' },
      { surface: 'menu-open', status: 'unknown', producer: 'capture' },
    ],
  );
  assert.equal(summarizeConfidence(ledger).completeness, 'limited');
});

test('prototype keys are not valid confidence statuses', () => {
  assert.throws(
    () =>
      summarizeConfidence({
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'home', status: 'toString', producer: 'capture', reason: 'x' }],
      }),
    /invalid status/,
  );
});

test('resolveBundleConfidence returns null for a bundle with neither source (old capture)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conf-old-'));
  try {
    fs.writeFileSync(path.join(dir, 'home@1440.json'), JSON.stringify({ defaults: {}, elements: {}, states: {} }));
    assert.equal(resolveBundleConfidence(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
