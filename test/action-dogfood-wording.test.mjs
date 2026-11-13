import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, tmpDirs, writeCapture, rmTmp } from './helpers.mjs';

for (const declared of [true, false]) {
  test(`dogfood assertions match generated ${declared ? 'acknowledged' : 'undeclared'} pair`, (t) => {
    const dirs = tmpDirs();
    t.after(() => rmTmp(dirs.root));
    for (const dir of [dirs.beforeDir, dirs.afterDir]) writeCapture(dir, 'home@320', makeMap({ elements: {} }), null);
    generateStyleMapReport({
      ...dirs,
      legacyPairsArmed: true,
      legacyPairDeclarations: declared ? { home: 'known fixture' } : {},
    });
    const workflow = fs.readFileSync('.github/workflows/action-dogfood.yml', 'utf8');
    const name = declared ? 'Assert acknowledged pairs' : 'Assert pairs with no product-state';
    const step = workflow.slice(workflow.indexOf('- name: ' + name)).split('\n      - ')[0];
    const assertions = step
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('grep ') || line.startsWith('! grep '));
    assert.ok(assertions.length > 0);
    for (const assertion of assertions) {
      const command = assertion.replaceAll('styleproof-report/', dirs.outDir + path.sep);
      const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${assertion}\n${result.stderr}`);
    }
  });
}
