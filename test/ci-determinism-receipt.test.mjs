import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const receiptPath = 'test-results/determinism-oracle.json';

test('CI prints and uploads the determinism receipt after browser verification', () => {
  const e2eIndex = workflow.indexOf('name: Smoke e2e');
  const printIndex = workflow.indexOf('name: Print determinism oracle receipt');
  const uploadIndex = workflow.indexOf('name: Upload determinism oracle receipt');

  assert.ok(e2eIndex >= 0, 'CI must run the browser fixture');
  assert.ok(printIndex > e2eIndex, 'CI must print the receipt after the browser fixture');
  assert.ok(uploadIndex > printIndex, 'CI must upload the same receipt after printing it');
  assert.match(workflow, new RegExp(receiptPath.replaceAll('.', '\\.')));
  assert.match(workflow, /missing determinism oracle receipt/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 30/);
});
