import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as diff from '../dist/diff.js';
import * as channels from '../dist/visual-channels.js';
import { generateStyleMapReport } from '../dist/report.js';
import { assessCertificationEvidence } from '../dist/verdict.js';
import { pairFixture, rmTmp } from './helpers.mjs';

const keyframe = 'animation keyframes (pulse)';
const unknown = '(keyframes unknown; not compared)';
const blob = '(blob URL; not compared)';
function map(prop, rest, state, pseudo = '', proven = true) {
  const props = (value) => (value === undefined ? {} : { [prop]: value });
  return {
    defaults: {},
    elements: {
      body: {
        tag: 'body',
        cls: '',
        style: pseudo ? {} : props(rest),
        ...(pseudo ? { pseudo: { [pseudo]: props(rest) } } : {}),
      },
    },
    states: { body: { hover: { ['body' + pseudo]: { ...props(state), color: 'red' } } } },
    ...(proven
      ? {
          visualChannels: {
            version: 1,
            keyframes: {
              A: { name: 'pulse', status: 'known', body: 'A' },
              B: { name: 'pulse', status: 'known', body: 'B' },
              [unknown]: { name: 'pulse', status: 'unknown' },
              [blob]: { name: 'pulse', status: 'known', body: blob },
              '': { name: 'pulse', status: 'unknown' },
            },
          },
        }
      : {}),
  };
}

test('a one-sided state channel without comparable resting evidence is not a change', () => {
  assert.deepEqual(diff.diffStyleMaps(map(keyframe, undefined, undefined), map(keyframe, undefined, 'A')), []);
});

test('generated channel confidence pairs obey the same rule at every property layer', () => {
  const alphabet = ['A', 'B', unknown, undefined, blob, ''];
  const known = (v) => v === 'A' || v === 'B';
  let pairs = 0;
  for (const prop of [keyframe, 'img currentSrc'])
    for (const pseudo of ['', '::before', '::marker'])
      for (const ra of alphabet)
        for (const rb of alphabet)
          for (const sa of alphabet)
            for (const sb of alphabet) {
              const before = map(prop, ra, sa, pseudo),
                after = map(prop, rb, sb, pseudo);
              const result = diff.diffStyleMapsWithEvidence(before, after);
              const effectiveA = sa ?? ra,
                effectiveB = sb ?? rb;
              const restUnknown = (v) => v !== undefined && !known(v);
              const comparable = known(effectiveA) && known(effectiveB) && !restUnknown(ra) && !restUnknown(rb);
              const restPresent = ra !== undefined || rb !== undefined;
              const statePresent = restPresent || sa !== undefined || sb !== undefined;
              const stateChanges = result.findings.filter((f) => f.kind === 'state').flatMap((f) => f.props);
              assert.equal(
                stateChanges.length,
                statePresent && comparable && effectiveA !== effectiveB ? 1 : 0,
                JSON.stringify({ prop, pseudo, ra, rb, sa, sb }),
              );
              const restCompared = restPresent && known(ra) && known(rb);
              assert.equal(
                result.findings.filter((f) => f.kind === 'style').flatMap((f) => f.props).length,
                restCompared && ra !== rb ? 1 : 0,
              );
              const expectedMissing = (restPresent && !restCompared ? 1 : 0) + (statePresent && !comparable ? 1 : 0);
              assert.equal(result.visualChannels.notCompared, expectedMissing);
              assert.equal(result.visualChannels.compared, Number(restCompared) + Number(statePresent && comparable));
              assert.equal(result.visualChannels.limits.length, expectedMissing);
              pairs++;
            }
  assert.equal(pairs, 7776);
});

test('the central decision treats absent, unproven and non-comparable values as limits', () => {
  for (const prop of [keyframe, 'img currentSrc']) {
    for (const [before, after] of [
      [undefined, undefined],
      ['A', undefined],
      [undefined, 'B'],
      [blob, 'A'],
      ['', 'B'],
      [unknown, 'A'],
    ]) {
      assert.equal(channels.compareChannelValues(prop, before, after).status, 'not-compared');
    }
    assert.equal(channels.compareChannelValues(prop, 'A', 'B', undefined, undefined, false).status, 'not-compared');
  }
  const result = diff.diffStyleMapsWithEvidence(map(keyframe, 'A', 'B'), map(keyframe, 'A', 'B', '', false));
  assert.equal(result.findings.length, 0);
  assert.equal(result.visualChannels.notCompared, 2);
});

test('a missing hover edit has a counted, non-certifying report explanation', () => {
  for (const kind of ['unknown', 'incomplete', 'volatile']) {
    const before = map(keyframe, 'A', 'A'),
      after = map(keyframe, 'A', 'B');
    if (kind === 'unknown') before.elements.body.style[keyframe] = unknown;
    if (kind === 'incomplete') {
      before.statesSkipped = true;
      after.statesSkipped = true;
      before.states = {};
      after.states = {};
    }
    if (kind === 'volatile') {
      before.volatile = ['body'];
      after.volatile = ['body'];
    }
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      const result = generateStyleMapReport(fixture),
        md = fs.readFileSync(result.reportMdPath, 'utf8'),
        json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      assert.match(md, /not certified|NOT certified|not compared|incomplete|uncertified/i);
      assert.ok(
        kind === 'unknown'
          ? json.visualChannels.notCompared > 0
          : kind === 'incomplete'
            ? json.statesUncertified > 0
            : before.volatile.length,
      );
      if (kind === 'incomplete') assert.match(md, /forced.state.*not certified/i);
      if (kind === 'unknown') {
        assert.doesNotMatch(md, /✓ No reviewable computed-style changes/);
        assert.equal(
          assessCertificationEvidence({
            sourceBinding: { status: 'bound' },
            coverage: { basis: 'complete' },
            determinism: { status: 'proven' },
            statesUncertified: 0,
            visualChannels: json.visualChannels,
          }).certifies,
          false,
        );
      }
    } finally {
      rmTmp(fixture.root);
    }
  }
});

test('confidence asymmetry still fails the strict channel self-check', () => {
  const before = map(keyframe, 'A', 'A'),
    after = map(keyframe, unknown, 'A');
  assert.deepEqual(diff.diffStyleMaps(before, after), []);
  assert.throws(() => channels.assertDeterministicVisualChannels(before, after, 'confidence'), /self-check failed/);
});

test('unproven maps and unknown models cannot manufacture known body evidence', () => {
  const before = map(keyframe, 'A', 'A', '', false),
    after = map(keyframe, 'B', 'B', '', false);
  assert.equal(diff.diffStyleMapsWithEvidence(before, after).visualChannels.notCompared, 2);
  before.visualChannels = { version: 1, keyframes: { A: { name: 'pulse', status: 'unknown', body: 'A' } } };
  after.visualChannels = { version: 1, keyframes: { B: { name: 'pulse', status: 'unknown', body: 'B' } } };
  assert.deepEqual(diff.diffStyleMaps(before, after), []);
  assert.equal(diff.diffStyleMapsWithEvidence(before, after).visualChannels.notCompared, 2);
});

test('raw legacy blob URLs are not comparable image sources', () => {
  assert.equal(
    channels.compareChannelValues('img currentSrc', 'blob:http://example.test/a', '/b.png').status,
    'not-compared',
  );
});
