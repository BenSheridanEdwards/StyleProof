import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleReachKey } from '../dist/reach-ledger.js';
test('declaration edits invalidate range acknowledgements', () => {
  const row = { key: '.panel', sheet: '/app.css', hash: 'old' };
  assert.notEqual(ruleReachKey(row), ruleReachKey({ ...row, hash: 'new' }));
  assert.equal(ruleReachKey({ key: '.panel', hash: 'old' }), undefined);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessReachMaps } from '../dist/report/reach.js';
test('armed gate holds gaps, stale entries and declaration rot; warn stays advisory', () => {
  const map = (hash) => ({
    defaults: {},
    elements: {},
    states: {},
    reach: {
      version: 2,
      scope: 'compared',
      sheets: ['/app.css'],
      rules: hash ? [{ key: '.panel', hash, sheet: 0 }] : [],
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-gate-'));
  const ledger = path.join(dir, 'ledger.json');
  const previous = process.env.STYLEPROOF_REACH;
  process.env.STYLEPROOF_REACH = ledger;
  const assess = (hash = 'current', level = 'gate') => assessReachMaps([map()], [map(hash)], level);
  try {
    fs.writeFileSync(ledger, '{}');
    assert.equal(assess().blocking, 1);
    const key = ruleReachKey({ key: '.panel', hash: 'current', sheet: '/app.css' });
    fs.writeFileSync(ledger, JSON.stringify({ [key]: 'Intentional' }));
    assert.equal(assess().blocking, 0);
    assert.equal(assess().rules[0].acknowledged, true);
    assert.equal(assess('edited').audit.staleAcknowledgements[0], key);
    assert.ok(assess('edited').blocking > 0);
    fs.writeFileSync(
      ledger,
      JSON.stringify({ [key]: 'Intentional', [ruleReachKey({ key: '.old', hash: 'old', sheet: 'inline' })]: 'Old' }),
    );
    assert.equal(assess().blocking, 1);
    assert.equal(assess('current', 'warn').blocking, 0);
    assert.equal(assess(undefined).blocking, 1);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'STYLEPROOF_REACH');
    else process.env.STYLEPROOF_REACH = previous;
  }
});

import { spawnSync } from 'node:child_process';
import { fixtureCommitSha, makeMap, tmpDirs, writeCapture } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
test('diff CLI names stale acknowledgements and the recovery steps', () => {
  const dirs = tmpDirs();
  for (const [dir, label] of [
    [dirs.beforeDir, 'base'],
    [dirs.afterDir, 'head'],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    writeCapture(
      dir,
      'home@1280',
      {
        ...makeMap({ elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } } }),
        reach: { version: 2, scope: 'compared', sheets: ['/app.css'], rules: [] },
      },
      null,
    );
    stampCertifyingFixture(dir, fixtureCommitSha(label));
  }
  fs.writeFileSync(path.join(dirs.root, 'styleproof.config.json'), JSON.stringify({ changeReach: 'gate' }));
  const stale = ruleReachKey({ key: '.old', hash: 'old', sheet: 'inline' });
  const ledger = path.join(dirs.root, 'reach.json');
  fs.writeFileSync(ledger, JSON.stringify({ [stale]: 'Old range' }));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve('bin/styleproof-diff.mjs'),
      dirs.beforeDir,
      dirs.afterDir,
      '--expected-before-sha',
      fixtureCommitSha('base'),
      '--expected-after-sha',
      fixtureCommitSha('head'),
    ],
    { cwd: dirs.root, encoding: 'utf8', env: { ...process.env, STYLEPROOF_REACH: ledger } },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(stale), result.stdout + result.stderr);
  assert.match(result.stdout, /prune it from styleproof\.reach\.json/);
  assert.match(result.stdout, /current changed range, mapped to a reason/);
});
