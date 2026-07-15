import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRE_PUSH_ZERO_OID, choosePrePushCaptureSha, docsOnlyFiles, parsePrePushRefs } from '../dist/prepush.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PREPUSH = path.join(here, '..', 'bin', 'styleproof-prepush.mjs');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REMOTE = 'c'.repeat(40);

const ref = (overrides = {}) => ({
  localRef: 'refs/heads/feature',
  localOid: HEAD,
  remoteRef: 'refs/heads/feature',
  remoteOid: REMOTE,
  ...overrides,
});

test('parsePrePushRefs: reads the pre-push stdin protocol, ignoring malformed lines', () => {
  const refs = parsePrePushRefs(
    [
      `refs/heads/feature ${HEAD} refs/heads/feature ${REMOTE}`,
      '', // blank line at EOF
      'not a protocol line',
      `refs/tags/v1 ${OTHER} refs/tags/v1 ${PRE_PUSH_ZERO_OID}`,
    ].join('\n'),
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], ref());
  assert.equal(refs[1].remoteOid, PRE_PUSH_ZERO_OID);
});

test('docsOnlyFiles: matches the non-render doc set exactly', () => {
  assert.equal(docsOnlyFiles(['README.md', 'docs/guide.mdx', 'notes.txt', 'LICENSE', 'LICENSE.MIT']), true);
  assert.equal(docsOnlyFiles(['README.md', 'src/app.css']), false);
  assert.equal(docsOnlyFiles(['LICENSE-APACHE']), false, 'LICENSE-* is not the LICENSE. pattern');
  assert.equal(docsOnlyFiles([]), false, 'an empty/unreadable range never skips');
});

test('choosePrePushCaptureSha: captures the checked-out ref, skips others for CI to recapture', () => {
  // The pushed ref's tip IS the checked-out tree → capture it.
  assert.equal(choosePrePushCaptureSha({ refs: [ref()], headSha: HEAD, changedFiles: () => ['src/a.ts'] }).sha, HEAD);
  // Pushing some other branch: capturing its SHA from this tree would lie.
  assert.equal(
    choosePrePushCaptureSha({ refs: [ref({ localOid: OTHER })], headSha: HEAD, changedFiles: () => ['src/a.ts'] }).sha,
    undefined,
  );
  // A ref delete has nothing to render.
  assert.equal(
    choosePrePushCaptureSha({
      refs: [ref({ localOid: PRE_PUSH_ZERO_OID })],
      headSha: HEAD,
      changedFiles: () => ['src/a.ts'],
    }).sha,
    undefined,
  );
});

test('choosePrePushCaptureSha: docs-only pushes skip with a note; a new ref never docs-skips', () => {
  const docsOnly = choosePrePushCaptureSha({
    refs: [ref()],
    headSha: HEAD,
    changedFiles: () => ['README.md', 'docs/guide.md'],
  });
  assert.equal(docsOnly.sha, undefined);
  assert.match(docsOnly.notes[0], /docs-only push \(refs\/heads\/feature\)/);

  // A brand-new ref (zero remote oid) has no readable range: capture, don't skip.
  const newRef = choosePrePushCaptureSha({
    refs: [ref({ remoteOid: PRE_PUSH_ZERO_OID })],
    headSha: HEAD,
    changedFiles: () => {
      throw new Error('must not diff against the zero oid');
    },
  });
  assert.equal(newRef.sha, HEAD);

  // An unreadable range (remote oid not fetched locally) also never skips.
  assert.equal(choosePrePushCaptureSha({ refs: [ref()], headSha: HEAD, changedFiles: () => undefined }).sha, HEAD);
});

test('choosePrePushCaptureSha: no refs on stdin falls back to HEAD (manual run / older git)', () => {
  assert.equal(choosePrePushCaptureSha({ refs: [], headSha: HEAD, changedFiles: () => [] }).sha, HEAD);
  assert.equal(choosePrePushCaptureSha({ refs: [], headSha: undefined, changedFiles: () => [] }).sha, undefined);
});

test('styleproof-prepush: STYLEPROOF_SKIP_CAPTURE=1 exits 0 before touching git or the map store', () => {
  const res = spawnSync(process.execPath, [PREPUSH], {
    encoding: 'utf8',
    input: `refs/heads/x ${HEAD} refs/heads/x ${REMOTE}\n`,
    env: { ...process.env, STYLEPROOF_SKIP_CAPTURE: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
});

test('styleproof-prepush: a non-checked-out ref push exits 0 without capturing', () => {
  // localOid can't equal this repo's real HEAD, so the driver must decide
  // "nothing to faithfully capture" and exit before spawning styleproof-map.
  const res = spawnSync(process.execPath, [PREPUSH], {
    encoding: 'utf8',
    input: `refs/heads/x ${OTHER} refs/heads/x ${REMOTE}\n`,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /styleproof-map/);
});
