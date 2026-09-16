import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateConfidence,
  aggregateCoverage,
  aggregateIncompleteUi,
  captureGaps,
  confidenceLines,
  coverageLines,
  crawlSummaryLine,
  incompleteUiLines,
} from '../dist/crawl/report.js';

const confidence = (over = {}) => ({
  status: 'complete',
  authBoundaries: [],
  acknowledged: [],
  unacknowledged: [],
  staleExclusions: [],
  certifiesFully: true,
  blocked: false,
  ...over,
});

const report = (over = {}) => ({
  surfaces: [{ key: 'base', depth: 0, path: [], elements: 10 }],
  actionsTried: 2,
  skipped: 1,
  captured: 1,
  failed: [],
  coverage: { defined: 2, rendered: 1, missing: ['b'], unreadable: [], renderedClasses: ['a'] },
  confidence: confidence(),
  incompleteUi: [],
  ...over,
});

test('aggregateCoverage: a class rendered on any page is covered; unreadable sheets dedupe', () => {
  const cov = aggregateCoverage([
    report(),
    report({ coverage: { defined: 2, rendered: 1, missing: ['a'], unreadable: ['x.css'], renderedClasses: ['b'] } }),
    report({
      coverage: { defined: 3, rendered: 0, missing: ['a', 'b', 'c'], unreadable: ['x.css'], renderedClasses: [] },
    }),
  ]);
  assert.deepEqual(cov, { defined: 3, rendered: 2, missing: ['c'], unreadable: ['x.css'] });
});

test('aggregateConfidence: incomplete-auth wins, blocked when any page is blocked, stale keys dedupe', () => {
  assert.deepEqual(aggregateConfidence([]), { blocked: false, status: 'complete', unack: [], ack: [], stale: [] });
  const wall = { key: '/login·password-input', diagnostics: [{ kind: 'credential-input', reason: 'password-input' }] };
  const agg = aggregateConfidence([
    report({ confidence: confidence({ status: 'incomplete-unknown', staleExclusions: ['/b', '/a'] }) }),
    report({
      confidence: confidence({
        status: 'incomplete-auth',
        blocked: true,
        unacknowledged: [wall],
        staleExclusions: ['/a'],
      }),
    }),
  ]);
  assert.equal(agg.status, 'incomplete-auth');
  assert.equal(agg.blocked, true);
  assert.deepEqual(agg.unack, [wall]);
  assert.deepEqual(agg.stale, ['/a', '/b']);
});

test('aggregateIncompleteUi: reasons merge per surface, sorted, with acknowledgements attached', () => {
  const entries = aggregateIncompleteUi(
    [
      report({ incompleteUi: [{ surface: 'z', diagnostics: [{ reason: 'inert' }, { reason: 'form-present' }] }] }),
      report({
        incompleteUi: [
          { surface: 'a', diagnostics: [{ reason: 'inert' }] },
          { surface: 'z', diagnostics: [{ reason: 'inert' }] },
        ],
      }),
    ],
    { a: 'out of scope' },
  );
  assert.deepEqual(entries, [
    { surface: 'a', reasons: ['inert'], acknowledgedReason: 'out of scope' },
    { surface: 'z', reasons: ['form-present', 'inert'] },
  ]);
});

test('coverageLines: full coverage, residue, and unreadable sheets keep their wording', () => {
  assert.deepEqual(coverageLines({ defined: 3, rendered: 3, missing: [], unreadable: [] }, ''), [
    '✓ coverage: all 3 stylesheet classes rendered in at least one captured surface',
  ]);
  const residue = coverageLines({ defined: 3, rendered: 2, missing: ['x'], unreadable: [] }, ' (2 pages)');
  assert.match(residue[0], /^⚠ coverage \(2 pages\): 2\/3 stylesheet classes rendered — 1 never seen/);
  assert.match(residue[0], /\n {4}x$/);
  const unreadable = coverageLines({ defined: 1, rendered: 1, missing: [], unreadable: ['a.css'] }, '');
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0], /1 stylesheet\(s\) unreadable/);
});

test('confidenceLines: complete, scope gaps → incomplete-unknown, and an unacknowledged wall fail closed', () => {
  assert.deepEqual(confidenceLines(aggregateConfidence([report()])), [
    '✓ crawl confidence: complete — no authentication boundary observed',
  ]);
  const gapped = confidenceLines(aggregateConfidence([report()]), [{ surface: 'page:x', reason: 'skipped' }]);
  assert.deepEqual(gapped, [
    '⚠ crawl confidence: incomplete-unknown',
    '    certification: not full — visual PASS does not imply complete surface access',
  ]);
  const wall = { key: '/login·password-input', diagnostics: [{ kind: 'credential-input', reason: 'password-input' }] };
  const blocked = confidenceLines(
    aggregateConfidence([
      report({ confidence: confidence({ status: 'incomplete-auth', blocked: true, unacknowledged: [wall] }) }),
    ]),
  );
  assert.match(blocked[0], /^✗ crawl confidence: incomplete-auth — .* — unacknowledged \(fail closed\)$/);
  assert.equal(blocked[1], '    unacknowledged: /login·password-input (password-input)');
  assert.match(blocked[2], /^ {4}Next: add --setup/);
  assert.match(blocked.at(-1), /certification: not full/);
});

test('incompleteUiLines: blocked entries fail closed, acknowledged ones limit scope', () => {
  assert.deepEqual(incompleteUiLines([]), []);
  const blocked = incompleteUiLines([{ surface: 'base', reasons: ['form-present'] }]);
  assert.equal(blocked[0], '✗ incomplete UI — blocked continuations leave reachable states uncaptured (fail closed)');
  assert.equal(blocked[1], '    base (form-present)');
  assert.match(blocked[2], /^ {4}Next: add deterministic setup/);
  const ack = incompleteUiLines([{ surface: 'base', reasons: ['inert'], acknowledgedReason: 'legacy\nwidget' }]);
  assert.deepEqual(ack, [
    '⚠ incomplete UI — blocked continuations leave reachable states uncaptured (scope explicitly limited)',
    '    base (inert) — acknowledged: legacy widget',
  ]);
});

test('crawlSummaryLine counts across pages and names capture failures', () => {
  const line = crawlSummaryLine([report(), report({ captured: 0, failed: ['base-2'] })], { widths: [], out: 'out' });
  assert.equal(
    line,
    '✓ 1/2 surface(s) across 2 page(s) × auto widths → out  (4 actions tried, 2 skipped, 1 capture-failed)',
  );
  assert.match(
    crawlSummaryLine([report()], { widths: [360, 1280], out: 'o' }),
    /× 2 width\(s\) → o {2}\(2 actions tried, 1 skipped\)$/,
  );
});

test('captureGaps names failed and never-captured surfaces, then the page-level gaps', () => {
  const gaps = captureGaps(
    [report({ surfaces: [{ key: 'base' }, { key: 'modal' }, { key: 'lost' }], failed: ['modal'] })],
    new Set(['base']),
    [{ surface: 'page:about', reason: 'linked page was discovered but could not be crawled' }],
  );
  assert.deepEqual(gaps, [
    { surface: 'modal', reason: 'capture failed before every configured viewport completed' },
    { surface: 'lost', reason: 'crawl stopped before this discovered surface was captured' },
    { surface: 'page:about', reason: 'linked page was discovered but could not be crawled' },
  ]);
});
