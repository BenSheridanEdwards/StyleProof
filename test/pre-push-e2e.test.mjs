import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromiumInstalled, collectPrePushFiles, shouldRunStagedE2e } from '../scripts/pre-push-e2e.mjs';

const hook = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');

test('shouldRunStagedE2e matches capture/diff/report/engine and ignores README-only', () => {
  assert.equal(shouldRunStagedE2e(['README.md', 'CONTRIBUTING.md']), false);
  assert.equal(shouldRunStagedE2e(['src/capture.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/capture/browser.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/diff.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/report.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/report/html.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/runner.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/runner/browser.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/config.ts', 'package.json']), false);
  assert.equal(shouldRunStagedE2e(['src/capture.ts.bak']), false);
});

test('chromiumInstalled is true only when the resolved executable exists', () => {
  assert.equal(chromiumInstalled({ executablePath: undefined, existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '', existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '/missing/chrome', existsSync: () => false }), false);
  assert.equal(chromiumInstalled({ executablePath: '/present/chrome', existsSync: () => true }), true);
});

test('collectPrePushFiles unions staged paths with push-range diffs', () => {
  assert.deepEqual(
    collectPrePushFiles({
      stagedFiles: ['README.md', 'src/capture.ts'],
      pushRanges: [],
    }),
    ['README.md', 'src/capture.ts'],
  );
  assert.deepEqual(
    collectPrePushFiles({
      stagedFiles: ['README.md'],
      pushRanges: [{ remoteOid: '0'.repeat(40), localOid: 'a'.repeat(40) }],
    }),
    ['README.md'],
  );
});

test('pre-push runs unit tests then the staged e2e gate', () => {
  const syntax = spawnSync('sh', ['-n', '.husky/pre-push'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(hook, /npm test/);
  assert.match(hook, /scripts\/pre-push-e2e\.mjs/);
});

test('pre-push still fails closed when unit tests fail before e2e', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'styleproof-prepush-'));
  try {
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/bin/sh\necho "fake npm $*"\nexit 17\n');
    chmodSync(npm, 0o755);
    const result = spawnSync('sh', ['.husky/pre-push'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /pre-push-e2e/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('pre-push e2e gate documents Chromium-missing skip (mirrors gitleaks optional)', () => {
  const script = readFileSync(new URL('../scripts/pre-push-e2e.mjs', import.meta.url), 'utf8');
  assert.match(script, /Playwright Chromium not installed/);
  assert.match(script, /skipping staged e2e/);
  assert.match(script, /npx playwright install chromium/);
  assert.match(hook, /scripts\/pre-push-e2e\.mjs/);
});
