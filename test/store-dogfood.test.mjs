import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The store-dogfood workflow is the end-to-end trust proof: a real capture,
// published to a scratch branch on the real remote, restored, certified. These
// tests pin the workflow's contract so a refactor can't quietly drop a link of
// the chain (the very failure mode the workflow exists to catch).

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = fs.readFileSync(path.join(here, '..', '.github/workflows/store-dogfood.yml'), 'utf8');

test('store dogfood runs the whole chain: capture+publish → restore → certify → miss taxonomy', () => {
  const captureIndex = workflow.indexOf('--sha "$HEAD_SHA" --upload');
  const restoreIndex = workflow.indexOf('--restore --sha "$HEAD_SHA"');
  const certifyIndex = workflow.indexOf('styleproof-diff.mjs "$MAP_ROOT/captured" "$MAP_ROOT/restored"');
  const missIndex = workflow.indexOf('--restore --sha "0000000000000000000000000000000000000001"');
  assert.ok(captureIndex > 0, 'captures at the real head SHA and requires upload');
  assert.ok(restoreIndex > captureIndex, 'restores the published bundle after capture');
  assert.ok(certifyIndex > restoreIndex, 'certifies restored == captured after restore');
  assert.ok(missIndex > certifyIndex, 'checks the miss taxonomy last');
  // The capture binds to the CHECKED-OUT commit, not event metadata.
  assert.match(workflow, /HEAD_SHA="\$\(git rev-parse HEAD\)"/);
  // A miss must surface as exit 4 — a fake hit or an infra code fails the job.
  assert.match(workflow, /if \[ "\$code" -ne 4 \]; then/);
});

test('store dogfood isolates and cleans up its scratch branch', () => {
  // Unique per attempt, so parallel PRs and reruns never collide and the real
  // styleproof-maps store is never touched.
  assert.match(
    workflow,
    /STYLEPROOF_CACHE_BRANCH: styleproof-maps-dogfood-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  // runner.temp is not legal in a job-level env expression. Resolve the native
  // RUNNER_TEMP variable at step runtime and export it for subsequent steps.
  assert.match(workflow, /echo "MAP_ROOT=\$RUNNER_TEMP\/store-dogfood" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(workflow, /MAP_ROOT: \$\{\{ runner\.temp \}\}/);
  // Deleted even when the round trip fails.
  const cleanup = workflow.match(
    /if: always\(\)[\s\S]*?git ls-remote --exit-code --heads origin "\$STYLEPROOF_CACHE_BRANCH"[\s\S]*?gh api --method DELETE/,
  );
  assert.ok(cleanup, 'the scratch branch is deleted in an always() step');
  assert.doesNotMatch(cleanup[0], /\|\| true/, 'cleanup failures are never suppressed');
  assert.doesNotMatch(
    cleanup[0],
    /git push/,
    'cleanup must not invoke the repository pre-push hook with dogfood-only environment variables',
  );
  assert.match(cleanup[0], /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // Forks lack write permission for the scratch branch.
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /contents: write/);
});

test('serve-static: serves the demo fixture and refuses path escapes', async () => {
  const SERVE = path.join(here, '..', 'scripts', 'serve-static.mjs');
  const demo = path.join(here, '..', 'example', 'demo');
  const port = 4970 + Number(process.env.TEST_WORKER_INDEX ?? 0);
  const child = spawn(process.execPath, [SERVE, demo, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', resolve);
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    const get = (urlPath) =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: urlPath }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          })
          .on('error', reject);
      });
    assert.equal(await get('/'), 200, 'serves index.html at /');
    assert.equal(await get('/missing.html'), 404);
    // Escape attempts never serve a file outside the root: percent-encoded
    // separators stay literal (no decode → no such file), and raw ../ segments
    // are normalized away by URL parsing before they reach the filesystem.
    assert.notEqual(await get('/..%2f..%2fpackage.json'), 200, 'encoded path escapes are refused');
    assert.notEqual(await get('/../package.json'), 200, 'raw path escapes are refused');
  } finally {
    child.kill();
  }
});
