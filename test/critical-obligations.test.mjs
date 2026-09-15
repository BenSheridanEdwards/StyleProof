import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyCriticalObligationReceipts,
  auditCriticalObligations,
  criticalStatesGateArmed,
  obligationMatches,
  readCriticalStatesFile,
  resolveConfiguredCriticalStatesPath,
} from '../dist/critical-obligations.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const receipt = (surface, status, required = false) => ({ surface, status, required });

test('readCriticalStatesFile returns {} when the default file is absent and nothing was requested', () => {
  // No explicit path, no env → the default styleproof.critical-states.json in cwd.
  // This test must run from a directory without that file (repo root has none).
  assert.equal(fs.existsSync(path.resolve('styleproof.critical-states.json')), false);
  assert.deepEqual(readCriticalStatesFile(), {});
});

test('readCriticalStatesFile throws when an explicitly requested file is missing', () => {
  const dir = mkTmp('styleproof-critical-explicit-');
  const missing = path.join(dir, 'nope.json');
  assert.throws(() => readCriticalStatesFile(missing), /not readable/);
  rmTmp(dir);
});

test('readCriticalStatesFile throws on malformed JSON', () => {
  const dir = mkTmp('styleproof-critical-malformed-');
  const file = path.join(dir, 'styleproof.critical-states.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readCriticalStatesFile(file), /not valid JSON/);
  rmTmp(dir);
});

test('readCriticalStatesFile rejects non-object and entry-shape violations', () => {
  const dir = mkTmp('styleproof-critical-shape-');
  const file = path.join(dir, 'obligations.json');
  const cases = [
    ['[]', /JSON object/],
    ['"home"', /JSON object/],
    [JSON.stringify({ home: 'because' }), /owner.*reason|must be/],
    [JSON.stringify({ home: { owner: 'team' } }), /exactly owner and reason/],
    [JSON.stringify({ home: { owner: 'team', reason: 'why', extra: 1 } }), /exactly owner and reason/],
    [JSON.stringify({ home: { owner: '', reason: 'why' } }), /non-empty owner/],
    [JSON.stringify({ home: { owner: 'team', reason: ' ' } }), /non-empty reason/],
  ];
  for (const [body, pattern] of cases) {
    fs.writeFileSync(file, body);
    assert.throws(() => readCriticalStatesFile(file), pattern, `body: ${body}`);
  }
  rmTmp(dir);
});

test('readCriticalStatesFile rejects unsafe keys and unbounded metadata', () => {
  const dir = mkTmp('styleproof-critical-unsafe-');
  const file = path.join(dir, 'obligations.json');
  const meta = { owner: 'team', reason: 'why' };
  for (const key of ['../escape', 'a/b', 'a\\b', '.', 'has..dots', ' lead', 'trail ']) {
    fs.writeFileSync(file, JSON.stringify({ [key]: meta }));
    assert.throws(() => readCriticalStatesFile(file), /critical state obligation key/, `key: ${key}`);
  }
  fs.writeFileSync(file, JSON.stringify({ home: { owner: 'x'.repeat(161), reason: 'why' } }));
  assert.throws(() => readCriticalStatesFile(file), /single line of at most/);
  fs.writeFileSync(file, JSON.stringify({ home: { owner: 'team', reason: 'two\nlines' } }));
  assert.throws(() => readCriticalStatesFile(file), /single line of at most/);
  rmTmp(dir);
});

test('a valid obligation file parses with trimmed bounded metadata', () => {
  const dir = mkTmp('styleproof-critical-valid-');
  const file = path.join(dir, 'obligations.json');
  fs.writeFileSync(file, JSON.stringify({ home: { owner: ' checkout team ', reason: ' blocks release ' } }));
  assert.deepEqual(readCriticalStatesFile(file), {
    home: { owner: 'checkout team', reason: 'blocks release' },
  });
  rmTmp(dir);
});

test('obligationMatches binds the exact key and the widthless surface base only', () => {
  assert.equal(obligationMatches('home', 'home'), true);
  assert.equal(obligationMatches('home', 'home@1280'), true);
  assert.equal(obligationMatches('home@1280', 'home@1280'), true);
  assert.equal(obligationMatches('home', 'cart'), false);
  assert.equal(obligationMatches('home@1280', 'home@390'), false);
  assert.equal(obligationMatches('home', 'home-deep'), false);
});

test('auditCriticalObligations classifies certified, failing, unresolved, and contradictory', () => {
  const receipts = [
    receipt('home@1280', 'comparable'),
    receipt('cart@1280', 'unproven'),
    receipt('search@1280', 'incomparable'),
    receipt('excluded@1280', 'comparable'),
  ];
  const declared = {
    home: { owner: 'a', reason: 'r' },
    cart: { owner: 'a', reason: 'r' },
    search: { owner: 'a', reason: 'r' },
    missing: { owner: 'a', reason: 'r' },
    excluded: { owner: 'a', reason: 'r' },
  };
  const audit = auditCriticalObligations(receipts, declared, ['excluded'], true);
  assert.deepEqual(audit.certified, ['home']);
  assert.deepEqual(audit.failing, ['cart', 'search']);
  assert.deepEqual(audit.unresolved, ['missing']);
  assert.deepEqual(audit.contradictory, ['excluded']);
  assert.deepEqual(audit.obligations, ['cart', 'excluded', 'home', 'missing', 'search']);
});

test('applyCriticalObligationReceipts marks only failing obligations required', () => {
  const receipts = [receipt('home@1280', 'comparable'), receipt('cart@1280', 'unproven')];
  const audit = auditCriticalObligations(
    receipts,
    { home: { owner: 'a', reason: 'r' }, cart: { owner: 'a', reason: 'r' } },
    [],
    true,
  );
  const applied = applyCriticalObligationReceipts(receipts, audit);
  assert.equal(applied[0].required, false, 'certifying obligation must not be downgraded');
  assert.equal(applied[1].required, true, 'non-certifying critical pair must become required');
  assert.equal(receipts[1].required, false, 'apply must not mutate the input receipts');
});

test('applyCriticalObligationReceipts is a no-op when the gate is not armed', () => {
  const receipts = [receipt('cart@1280', 'unproven')];
  assert.equal(applyCriticalObligationReceipts(receipts, null), receipts);
  assert.equal(applyCriticalObligationReceipts(receipts, auditCriticalObligations(receipts, {}, [], false)), receipts);
});

test('criticalStatesGateArmed and resolveConfiguredCriticalStatesPath honor flag > env > config', () => {
  const env = { STYLEPROOF_CRITICAL_STATES: '/env/path.json' };
  assert.equal(resolveConfiguredCriticalStatesPath('/flag.json', '/config.json', env), '/flag.json');
  assert.equal(resolveConfiguredCriticalStatesPath(undefined, '/config.json', env), '/env/path.json');
  assert.equal(resolveConfiguredCriticalStatesPath(undefined, '/config.json', {}), '/config.json');
  assert.equal(
    resolveConfiguredCriticalStatesPath(undefined, '/config.json', { STYLEPROOF_CRITICAL_STATES: '' }),
    undefined,
    'empty env must unarm a config-discovered obligation file',
  );
  assert.equal(criticalStatesGateArmed('/explicit.json'), true);
});
