import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const receiptPath = '.styleproof/ci/determinism-oracle.json';

test('CI transfers the determinism receipt between jobs for verification without an unread re-upload', () => {
  const e2eIndex = workflow.indexOf('name: Browser shard');
  const printIndex = workflow.indexOf('name: Verify complete browser evidence and print determinism oracle receipt');
  const uploadIndex = workflow.indexOf('name: Upload browser shard evidence');
  const downloadIndex = workflow.indexOf('uses: actions/download-artifact@', uploadIndex);

  assert.ok(e2eIndex >= 0, 'CI must run the browser fixture');
  assert.ok(printIndex > e2eIndex, 'CI must print the receipt after the browser fixture');
  assert.ok(uploadIndex > e2eIndex, 'CI must upload the receipt from the browser shard');
  assert.ok(downloadIndex > uploadIndex, 'CI must download the uploaded shard evidence');
  assert.ok(printIndex > downloadIndex, 'CI must verify and print the downloaded receipt');
  assert.doesNotMatch(workflow.slice(printIndex), /actions\/upload-artifact@/);
  assert.match(workflow, new RegExp(receiptPath.replaceAll('.', '\\.')));
  assert.match(
    workflow,
    /path: \|\n +\.styleproof\/ci\/shard\.json\n +\.styleproof\/ci\/determinism-oracle\.json\n +\.styleproof\/ci\/inventory\.json\n/,
  );
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /node scripts\/verify-e2e-shards.mjs/);
  assert.match(
    workflow,
    /needs:\s+\[changes, build, coverage, coverage-shards, e2e, e2e-evidence, cli-smoke, detection-corpus\]/,
  );
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 1\s*$/m);
});
