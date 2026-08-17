import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const ci = fs.readFileSync(path.join(here, '..', '.github/workflows/ci.yml'), 'utf8');

test('CI runs a small non-Linux CLI smoke without the browser suite', () => {
  assert.match(ci, /cli-smoke:/);
  assert.match(ci, /os: \[macos-latest, windows-latest\]/);
  assert.match(ci, /node-version: '22'/);
  assert.match(ci, /node --test test\/package-smoke\.test\.mjs/);
  assert.doesNotMatch(ci.match(/cli-smoke:[\s\S]*$/)?.[0] ?? '', /npm run test:e2e/);
});
