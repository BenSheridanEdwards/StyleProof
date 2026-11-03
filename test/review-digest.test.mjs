import assert from 'node:assert/strict';
import test from 'node:test';

const trust = 'STYLE_REVIEW_REQUIRED';
const fixture = () => ({
  surfaces: [
    {
      surface: 'home@1280',
      classification: 'changed',
      findings: [
        { kind: 'dom', path: 'body > button', cls: 'button', change: 'retagged', detail: 'a → button' },
        {
          kind: 'style',
          path: 'body',
          cls: '',
          pseudo: null,
          contentLengthSignal: 'changed',
          props: [
            { prop: 'color', before: 'black', after: 'red' },
            { prop: 'width', before: '10px', after: '20px' },
          ],
        },
        {
          kind: 'state',
          path: 'body > button',
          cls: 'button',
          state: 'hover',
          sub: '',
          autoMarginEchoDropped: true,
          props: [{ prop: 'color', before: 'red', after: 'blue' }],
        },
      ],
    },
    { surface: 'pricing@1280', missing: 'before', classification: 'genuinely-new', findings: [] },
  ],
  inventory: { added: ['pricing'], removed: ['old'] },
  volatility: { baseOnly: [{ surface: 'home@1280', path: 'body > aside' }] },
  reach: {
    level: 'gate',
    ledger: 'complete',
    blocking: 1,
    counts: { reached: 0, 'never-rendered': 1, unmeasured: 0, 'blind-channel': 0 },
  },
});

const reverseKeys = (value) =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, entry]) => [key, reverseKeys(entry)]),
        )
      : value;

test('reviewDiffDigest ignores key order, collection order and volatile or advisory metadata', async () => {
  const { reviewDiffDigest } = await import('../dist/review-digest.js');
  const diff = fixture();
  const equivalent = reverseKeys(diff);
  equivalent.surfaces.reverse();
  equivalent.surfaces[1].findings.reverse();
  equivalent.surfaces[1].findings[1].props.reverse();
  Object.assign(equivalent, {
    timestamp: 'later',
    duration: 500,
    beforeDir: 'unused-base',
    afterDir: 'unused-head',
    sourceBinding: { headSha: 'b'.repeat(40) },
    actionTrustState: 'stale',
    reviewDigest: 'stale',
    content: { changes: 99 },
    receipts: ['unused'],
    runId: 123,
  });
  equivalent.surfaces[1].findings[2].component = { name: 'Advisory', props: { label: 'Changed' } };
  assert.match(reviewDiffDigest(diff, trust), /^[0-9a-f]{64}$/);
  assert.equal(reviewDiffDigest(diff, trust), reviewDiffDigest(equivalent, trust));
});

test('reviewDiffDigest binds every reviewable finding field and the trust state', async () => {
  const { reviewDiffDigest } = await import('../dist/review-digest.js');
  const original = reviewDiffDigest(fixture(), trust);
  const mutations = [
    (d) => d.surfaces.push({ surface: 'account@1280', findings: [] }),
    (d) => d.surfaces.pop(),
    (d) => (d.surfaces[0].surface = 'home@640'),
    (d) => (d.surfaces[1].missing = 'after'),
    (d) => (d.surfaces[1].classification = 'removed'),
    (d) => d.surfaces[0].findings.pop(),
    (d) => (d.surfaces[0].findings[0].path = 'body > a'),
    (d) => (d.surfaces[0].findings[0].cls = 'link'),
    (d) => (d.surfaces[0].findings[0].change = 'added'),
    (d) => (d.surfaces[0].findings[0].detail = 'button → div'),
    (d) => (d.surfaces[0].findings[1].pseudo = '::before'),
    (d) => (d.surfaces[0].findings[1].contentLengthSignal = 'unknown'),
    (d) => (d.surfaces[0].findings[1].props[0].prop = 'background-color'),
    (d) => (d.surfaces[0].findings[1].props[0].before = 'white'),
    (d) => (d.surfaces[0].findings[1].props[0].after = 'green'),
    (d) => (d.surfaces[0].findings[2].state = 'focus'),
    (d) => (d.surfaces[0].findings[2].sub = 'span'),
    (d) => delete d.surfaces[0].findings[2].autoMarginEchoDropped,
    (d) => (d.surfaces[0].findings[2].props[0].after = 'green'),
    (d) => d.inventory.added.push('account'),
    (d) => d.inventory.removed.push('legacy'),
    (d) => (d.volatility.baseOnly[0].path = 'body > main'),
    (d) => (d.reach.blocking = 2),
    (d) => (d.reach.ledger = 'missing'),
    (d) => (d.reach.counts.unmeasured = 1),
  ];
  for (const mutate of mutations) {
    const diff = fixture();
    mutate(diff);
    assert.notEqual(reviewDiffDigest(diff, trust), original, String(mutate));
  }
  assert.notEqual(reviewDiffDigest(fixture(), 'NO_REVIEWABLE_STYLE_CHANGES'), original);
});

test('reviewDiffDigest ignores advisory reach and unrelated receipts', async () => {
  const { reviewDiffDigest } = await import('../dist/review-digest.js');
  const diff = { surfaces: [] };
  const same = {
    ...diff,
    reach: { level: 'warn', blocking: 0, counts: { reached: 10 } },
    baselineFailures: [{ runId: 123 }],
    inventory: { added: [], removed: [], staleAcknowledgements: ['unused'] },
  };
  assert.equal(reviewDiffDigest(diff, trust), reviewDiffDigest(same, trust));
});
