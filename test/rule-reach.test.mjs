import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRuleReach } from '../dist/rule-reach.js';

// Change Reach J1 (#995): every served rule that differs between base and head gets one
// status, judged on the side where it can render.

const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const map = (...rules) => ({ defaults: {}, elements: {}, states: {}, reach: { sheets: ['/app.css'], rules } });
const statusOf = (result, key) => result.rules.find((r) => r.key === key);

test('an unchanged ledger has nothing to classify', () => {
  const side = map(rule('.a', 'h1', { used: true }), rule('.b', 'h2'));
  assert.deepEqual(classifyRuleReach([side], [side]), { ledger: 'complete', rules: [], unreadableSheets: 0 });
});

test('a changed rule is reached when a head state matched it, and never-rendered otherwise', () => {
  const base = map(rule('.link:hover', 'h1', { used: true }), rule('.panel--fault .indicator', 'h2'));
  const head = map(rule('.link:hover', 'h1b', { used: true }), rule('.panel--fault .indicator', 'h2b'));
  const result = classifyRuleReach([base], [head]);
  assert.equal(statusOf(result, '.link:hover').status, 'reached');
  assert.deepEqual(statusOf(result, '.panel--fault .indicator'), {
    key: '.panel--fault .indicator',
    change: 'changed',
    status: 'never-rendered',
    why: 'its selector never matched',
    sheet: '/app.css',
  });
});

test('reach unions every surface and width of a side', () => {
  const base = [map(rule('.badge--bad', 'h1')), map(rule('.badge--bad', 'h1', { used: true }))];
  const head = [map(rule('.badge--bad', 'h2')), map(rule('.badge--bad', 'h2', { used: true }))];
  assert.equal(classifyRuleReach(base, head).rules[0].status, 'reached');
});

test('an added rule is judged on head, a removed rule on base', () => {
  const base = map(rule('.panel--fault', 'h1'), rule('.gone', 'h2', { used: true }));
  const head = map(rule('.new', 'h3', { used: true }), rule('.unseen', 'h4'));
  const result = classifyRuleReach([base], [head]);
  assert.deepEqual(
    result.rules.map((r) => [r.key, r.change, r.status]),
    [
      ['.gone', 'removed', 'reached'],
      ['.new', 'added', 'reached'],
      ['.panel--fault', 'removed', 'never-rendered'],
      ['.unseen', 'added', 'never-rendered'],
    ],
  );
});

test('a never-rendered rule inside at-rules names its condition', () => {
  const key = '@media (prefers-color-scheme: dark) > .panel > .cell';
  const result = classifyRuleReach([map(rule(key, 'h1'))], [map(rule(key, 'h2'))]);
  assert.equal(statusOf(result, key).condition, '@media (prefers-color-scheme: dark)');
  assert.equal(statusOf(result, key).why, 'never matched while @media (prefers-color-scheme: dark) applied');
  const nested = '@media (min-width: 1440px) > @supports (display: grid) > .panel';
  assert.equal(
    classifyRuleReach([map(rule(nested, 'h1'))], [map(rule(nested, 'h2'))]).rules[0].condition,
    '@media (min-width: 1440px) > @supports (display: grid)',
  );
});

test('a changed custom property is reached only when every rule that reads it matched', () => {
  const base = map(
    rule(':root', 'h1', { used: true, vars: { '--warn': 'green', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { used: true, uses: ['--ok'] }),
  );
  const head = map(
    rule(':root', 'h1b', { used: true, vars: { '--warn': 'amber', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { used: true, uses: ['--ok'] }),
  );
  const root = statusOf(classifyRuleReach([base], [head]), ':root');
  assert.equal(root.status, 'never-rendered');
  assert.equal(root.why, '--warn changed, and its consumer .fault-badge never matched');

  // The same change is reached once the consumer renders; an unchanged token's consumers don't matter.
  const rendered = map(
    rule(':root', 'h1b', { used: true, vars: { '--warn': 'amber', '--ok': 'green' } }),
    rule('.fault-badge', 'h2', { used: true, uses: ['--warn'] }),
    rule('.badge--ok', 'h3', { uses: ['--ok'] }),
  );
  assert.equal(statusOf(classifyRuleReach([base], [rendered]), ':root').status, 'reached');
});

test('a changed @keyframes is a blind channel when a rendered rule references it', () => {
  const base = map(rule('@keyframes pulse', 'k1'), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  const head = map(rule('@keyframes pulse', 'k2'), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  assert.deepEqual(statusOf(classifyRuleReach([base], [head]), '@keyframes pulse'), {
    key: '@keyframes pulse',
    change: 'changed',
    status: 'blind-channel',
    why: 'referenced by .badge, which rendered',
    sheet: '/app.css',
  });
  const unreferenced = map(rule('@keyframes pulse', 'k2'), rule('.badge', 'b', { refs: ['pulse'] }));
  assert.equal(statusOf(classifyRuleReach([base], [unreferenced]), '@keyframes pulse').status, 'never-rendered');
});

test('a side with any map lacking a ledger classifies nothing', () => {
  const ledgered = map(rule('.a', 'h1', { used: true }));
  const legacy = { defaults: {}, elements: {}, states: {} };
  assert.deepEqual(classifyRuleReach([ledgered, legacy], [ledgered]), {
    ledger: 'missing',
    rules: [],
    unreadableSheets: 0,
  });
  assert.equal(classifyRuleReach([ledgered], []).ledger, 'missing');
});

test('unreadable stylesheets on either side are counted', () => {
  const base = { ...map(rule('.a', 'h1', { used: true })), reach: { sheets: [], rules: [], unreadable: 2 } };
  const head = { ...map(), reach: { sheets: [], rules: [], unreadable: 1 } };
  assert.equal(classifyRuleReach([base], [head]).unreadableSheets, 3);
});
