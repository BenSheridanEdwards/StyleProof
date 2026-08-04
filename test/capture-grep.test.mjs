import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAPTURE_TEST_GREP } from '../dist/runner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright's own `--grep` compilation, copied from `forceRegExp` in
 * `playwright/lib/util.js`: a `/pattern/flags` string becomes that regex, and
 * ANY OTHER string becomes `new RegExp(pattern, 'gi')` — case-insensitive.
 *
 * That fallback is the whole bug. Reproducing it here rather than asserting
 * against a hand-written regex keeps the test honest about what Playwright
 * actually does with the string we hand it.
 */
function compileGrepLikePlaywright(pattern) {
  const asRegexLiteral = pattern.match(/^\/(.*)\/([gi]*)$/);
  if (asRegexLiteral) return new RegExp(asRegexLiteral[1], asRegexLiteral[2]);
  return new RegExp(pattern, 'gi');
}

/**
 * Playwright matches the grep against the joined title path — file, every enclosing
 * describe, the test title, then tags — not against the test title alone.
 */
function grepTitle(...titlePathSegments) {
  return titlePathSegments.join(' ');
}

function matchesCaptureGrep(...titlePathSegments) {
  const compiled = compileGrepLikePlaywright(CAPTURE_TEST_GREP);
  compiled.lastIndex = 0;
  return compiled.test(grepTitle(...titlePathSegments));
}

test('the capture selector still selects every capture test', () => {
  // The two describes in runner.ts, and the browser-build test nested inside them —
  // it inherits the describe title, which is what the selector matches on.
  assert.ok(matchesCaptureGrep('e2e/styleproof.spec.ts', 'styleproof capture', 'home @ 1440'));
  assert.ok(matchesCaptureGrep('e2e/styleproof.spec.ts', 'styleproof capture (crawl)', 'settings @ 768'));
  assert.ok(matchesCaptureGrep('e2e/styleproof.spec.ts', 'styleproof capture', 'styleproof browser build'));
});

test('the capture selector ignores a consumer test that merely mentions StyleProof capture', () => {
  // The real title that broke a consumer: it asserts head-only UI, and because
  // `styleproof-ci --spec-ref` overlays the head harness onto the BASE checkout, being
  // swept into the capture run made it run against the base application, fail, and take
  // the whole base capture down — 230 surfaces left with no baseline, head green.
  assert.equal(
    matchesCaptureGrep(
      'tests/e2e/view-behaviours.spec.ts',
      'ci runners: the StyleProof capture fixture actually contains the lane panel',
    ),
    false,
    'a prose mention of "StyleProof capture" must not be selected as a capture test',
  );

  // The same title through the OLD bare-string selector, to prove the bug was real and
  // that this test would not have caught it before.
  const bareStringSelector = compileGrepLikePlaywright('styleproof capture');
  assert.ok(
    bareStringSelector.test(
      grepTitle(
        'tests/e2e/view-behaviours.spec.ts',
        'ci runners: the StyleProof capture fixture actually contains the lane panel',
      ),
    ),
    'the bare-string selector DID match it — that is the defect being fixed',
  );
});

test('the capture selector does not match a longer word', () => {
  assert.equal(matchesCaptureGrep('spec.ts', 'restyleproof capturely', 'x'), false);
});

test('styleproof-map selects with the shared constant, not its own literal', () => {
  // The selector and the `test.describe` titles used to be two independent string
  // literals with nothing holding them together; either could drift silently.
  const mapCli = fs.readFileSync(path.join(REPO_ROOT, 'bin/styleproof-map.mjs'), 'utf8');

  assert.match(mapCli, /--grep',\s*CAPTURE_TEST_GREP/);
  assert.doesNotMatch(
    mapCli,
    /'--grep',\s*'styleproof capture'/,
    'the CLI must not carry its own copy of the selector',
  );
});
