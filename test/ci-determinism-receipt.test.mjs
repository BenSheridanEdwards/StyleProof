import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const receiptPath = '.styleproof/ci/determinism-oracle.json';

test('CI prints and uploads the determinism receipt after browser verification', () => {
  const e2eIndex = workflow.indexOf('name: Browser shard');
  const printIndex = workflow.indexOf('name: Verify complete browser evidence and print determinism oracle receipt');
  const uploadIndex = workflow.indexOf('name: Upload verified browser evidence');

  assert.ok(e2eIndex >= 0, 'CI must run the browser fixture');
  assert.ok(printIndex > e2eIndex, 'CI must print the receipt after the browser fixture');
  assert.ok(uploadIndex > printIndex, 'CI must upload the same receipt after printing it');
  assert.match(workflow, new RegExp(receiptPath.replaceAll('.', '\\.')));
  assert.match(workflow, /node scripts\/verify-e2e-shards.mjs/);
  assert.match(workflow, /needs: \[build, e2e, e2e-evidence, cli-smoke\]/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 30/);
});
