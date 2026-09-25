import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLD_REASONS,
  classifyAncestorCaptureColdReason,
  classifyColdReasonFromMissMessage,
  extractColdReasonFromLog,
  formatMapRestoreDecisionLine,
  formatShaField,
  isColdReason,
} from '../dist/map-hit-observability.js';

// Greppable exact / ancestor / miss lines — Fleet Visual keys on `base_hit=` and
// `cold_reason=` (issue #734). Soft-pass HOLD: observe only.

test('formatMapRestoreDecisionLine: exact hit names base_hit=exact and the SHA', () => {
  const line = formatMapRestoreDecisionLine({
    side: 'base',
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseHit: 'exact',
  });
  assert.equal(line, 'styleproof: map-restore side=base sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa base_hit=exact');
  assert.match(line, /^styleproof: map-restore /);
  assert.match(line, /\bbase_hit=exact\b/);
});

test('formatMapRestoreDecisionLine: ancestor reuse disambiguates with ancestor_reuse_from', () => {
  const line = formatMapRestoreDecisionLine({
    side: 'base',
    sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    baseHit: 'ancestor',
    ancestorReuseFrom: 'cccccccccccccccccccccccccccccccccccccccc',
  });
  assert.equal(
    line,
    'styleproof: map-restore side=base sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb base_hit=ancestor ancestor_reuse_from=cccccccccccccccccccccccccccccccccccccccc',
  );
  assert.match(line, /\bbase_hit=ancestor\b/);
  assert.match(line, /\bancestor_reuse_from=c{40}\b/);
  assert.doesNotMatch(line, /\bcold_reason=/);
});

test('formatMapRestoreDecisionLine: miss always carries structured cold_reason', () => {
  for (const coldReason of ['no_bundle', 'compat_mismatch', 'no_store', 'ancestor_relevant_changes']) {
    const line = formatMapRestoreDecisionLine({
      side: 'base',
      sha: 'dddddddddddddddddddddddddddddddddddddddd',
      baseHit: 'miss',
      coldReason,
    });
    assert.match(line, /\bbase_hit=miss\b/);
    assert.match(line, new RegExp(`\\bcold_reason=${coldReason}\\b`));
  }
});

test('formatMapRestoreDecisionLine: head side uses the same base_hit vocabulary', () => {
  const line = formatMapRestoreDecisionLine({
    side: 'head',
    sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    baseHit: 'exact',
  });
  assert.match(line, /\bside=head\b/);
  assert.match(line, /\bbase_hit=exact\b/);
});

test('COLD_REASONS: documents the stable enum including selective_* reserved for #733', () => {
  assert.ok(COLD_REASONS.includes('no_bundle'));
  assert.ok(COLD_REASONS.includes('compat_mismatch'));
  assert.ok(COLD_REASONS.includes('store_unreachable'));
  assert.ok(COLD_REASONS.includes('dirty'));
  assert.ok(COLD_REASONS.includes('opt_in_selective_off'));
  assert.ok(COLD_REASONS.includes('selective_all'));
  assert.ok(COLD_REASONS.includes('forced_recapture'));
  assert.ok(isColdReason('ancestor_none_stored'));
  assert.equal(isColdReason('not_a_real_reason'), false);
});

test('classifyColdReasonFromMissMessage: maps store miss text onto the enum', () => {
  assert.equal(classifyColdReasonFromMissMessage('no cached map for abc on styleproof-maps'), 'no_bundle');
  assert.equal(
    classifyColdReasonFromMissMessage('no cached map for abc with compatibility deadbeef on styleproof-maps'),
    'compat_mismatch',
  );
  assert.equal(classifyColdReasonFromMissMessage('map store branch styleproof-maps does not exist'), 'branch_missing');
  assert.equal(
    classifyColdReasonFromMissMessage('could not restore abc from styleproof-maps after 3 attempts: ECONNRESET'),
    'store_unreachable',
  );
});

test('extractColdReasonFromLog: reads a prior structured cold_reason token', () => {
  const log =
    'styleproof-map: …\nstyleproof: map-restore side=base sha=abc base_hit=miss cold_reason=compat_mismatch\n';
  assert.equal(extractColdReasonFromLog(log), 'compat_mismatch');
  assert.equal(extractColdReasonFromLog('no structured fields here'), undefined);
});

test('classifyAncestorCaptureColdReason: prefers reasonCode then free-text', () => {
  assert.equal(classifyAncestorCaptureColdReason('x', 'ancestor_none_stored'), 'ancestor_none_stored');
  assert.equal(
    classifyAncestorCaptureColdReason('3 of 5 path(s) changed since ancestor are capture-relevant (first: src/a.ts)'),
    'ancestor_relevant_changes',
  );
  assert.equal(
    classifyAncestorCaptureColdReason('no stored bundle among the 50 nearest first-parent ancestor(s)'),
    'ancestor_none_stored',
  );
  assert.equal(classifyAncestorCaptureColdReason('rev-list failed: boom'), 'ancestor_error');
});

test('formatShaField: lowercases hex SHAs', () => {
  assert.equal(formatShaField('ABCDEF0'), 'abcdef0');
});
