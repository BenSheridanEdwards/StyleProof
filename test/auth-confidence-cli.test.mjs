import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-capture.mjs');

// Browser-free only: real crawl CLI exit 5/0 paths need Chromium and live in
// test/auth-confidence-cli.e2e.spec.ts (npm run test:e2e / after playwright install).
test('CLI exit 2: empty auth-boundary exclusion reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-auth-cli-ex-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ '/login': '   ' }));
  try {
    const res = spawnSync(
      process.execPath,
      [CAPTURE, 'http://127.0.0.1:9/', '--crawl', '--auth-boundary-exclude', bad],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env },
      },
    );
    assert.equal(res.status, 2, res.stderr + res.stdout);
    assert.match(`${res.stderr}${res.stdout}`, /non-empty reason/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
