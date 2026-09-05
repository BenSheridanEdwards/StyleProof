import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSelfCheckCaptureFailure } from '../dist/runner.js';
import { generateStyleMapReport } from '../dist/report.js';
import { removeSurfaceCaptureArtifacts } from '../dist/crawl-surfaces.js';
import {
  MAP_MANIFEST,
  recordSurfaceCaptureFailure,
  readSurfaceCaptureFailures,
  writeMapManifest,
  baselineFailureMatchesSurface,
} from '../dist/map-store.js';
import {
  fixtureCommitSha,
  fixtureCompatibilityKey,
  fixtureContentHash,
  makeMap,
  mkTmp,
  rmTmp,
  writeCapture,
} from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
const CI = path.join(here, '..', 'bin', 'styleproof-ci.mjs');

function run(script, args, env = {}, cwd = process.cwd()) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: childEnv, cwd });
}

function writeManifest(dir, sha, compatibilityKey, extra = {}) {
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify(
      {
        version: 1,
        packageVersion: 'test',
        sha: fixtureCommitSha(sha),
        dirty: false,
        spec: 'e2e/styleproof.spec.ts',
        specHash: fixtureContentHash('test'),
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey: fixtureCompatibilityKey(compatibilityKey),
        createdAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      },
      null,
      2,
    ),
  );
  const expected = [
    ...new Set(
      fs
        .readdirSync(dir)
        .filter((name) => /@\d+\.json(?:\.gz)?$/.test(name))
        .map((name) => name.replace(/@\d+\.json(?:\.gz)?$/, '')),
    ),
  ];
  fs.writeFileSync(
    path.join(dir, 'styleproof-coverage.json'),
    JSON.stringify({ version: 1, expected, exclude: {}, determinism: 'self-checked' }),
  );
}

test('removeSurfaceCaptureArtifacts deletes partial widths and state screenshots only for the failed surface', () => {
  const root = mkTmp();
  try {
    for (const file of [
      'failed@900.json.gz',
      'failed@900.png',
      'failed@900.hover.png',
      'failed@1440.json',
      'failed@1440.active.png',
      'good@900.json.gz',
    ])
      fs.writeFileSync(path.join(root, file), 'partial');
    removeSurfaceCaptureArtifacts(root, 'failed', [900, 1440]);
    assert.deepEqual(fs.readdirSync(root), ['good@900.json.gz']);
  } finally {
    rmTmp(root);
  }
});

test('isSelfCheckCaptureFailure distinguishes nondeterminism from ordinary capture errors', () => {
  assert.equal(isSelfCheckCaptureFailure('styleproof self-check failed: home is non-deterministic'), true);
  assert.equal(isSelfCheckCaptureFailure('Timeout 30000ms exceeded'), false);
});

test('baselineFailureMatchesSurface: @auto matches any width for same surface only', () => {
  assert.equal(baselineFailureMatchesSurface('about@auto', 'about@1280'), true);
  assert.equal(baselineFailureMatchesSurface('about@auto', 'about@390'), true);
  assert.equal(baselineFailureMatchesSurface('about@auto', 'about-loaded@1280'), false);
  assert.equal(baselineFailureMatchesSurface('about@1280', 'about@1280'), true);
  assert.equal(baselineFailureMatchesSurface('about@1280', 'about@900'), false);
  assert.equal(baselineFailureMatchesSurface('about@1280', 'about@auto'), false);
});

test('recordSurfaceCaptureFailures merge into writeMapManifest', () => {
  const root = mkTmp();
  const dir = path.join(root, 'maps');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'home@900.json'), '{}');
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@test'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
  recordSurfaceCaptureFailure(dir, { key: 'about@900', reason: 'navigation failed', kind: 'capture' });
  const manifest = writeMapManifest({
    dir,
    spec: 'e2e/styleproof.spec.ts',
    sha: 'a'.repeat(40),
    screenshots: true,
    cwd: root,
  });
  assert.deepEqual(manifest.surfaceCaptureFailures, [
    { key: 'about@900', reason: 'navigation failed', kind: 'capture' },
  ]);
  assert.deepEqual(readSurfaceCaptureFailures(dir), manifest.surfaceCaptureFailures);
  rmTmp(root);
});

test('writeMapManifest rejects source identities its strict reader cannot consume', () => {
  const root = mkTmp();
  try {
    for (const sha of ['0123abcd', 'local', 'A'.repeat(40)]) {
      const dir = path.join(root, sha.slice(0, 8));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'home@900.json'), '{}');
      assert.throws(
        () =>
          writeMapManifest({
            dir,
            spec: 'e2e/styleproof.spec.ts',
            sha,
            screenshots: false,
            cwd: root,
          }),
        /invalid .*manifest/i,
      );
      assert.equal(fs.existsSync(path.join(dir, MAP_MANIFEST)), false);
    }
    const hostileDirtyAllowDir = path.join(root, 'hostile-dirty-allow');
    fs.mkdirSync(hostileDirtyAllowDir, { recursive: true });
    fs.writeFileSync(path.join(hostileDirtyAllowDir, 'home@900.json'), '{}');
    assert.throws(
      () =>
        writeMapManifest({
          dir: hostileDirtyAllowDir,
          spec: 'e2e/styleproof.spec.ts',
          sha: 'a'.repeat(40),
          screenshots: false,
          dirtyAllow: ['generated\tPRIVATE-CONTROL-MARKER'],
          cwd: root,
        }),
      /invalid .*manifest/i,
    );
    assert.equal(fs.existsSync(path.join(hostileDirtyAllowDir, MAP_MANIFEST)), false);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map rejects a noncanonical explicit source SHA before capture', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    for (const sha of ['0123abcd', 'local', 'A'.repeat(40)]) {
      const result = run(MAP, ['--spec', spec, '--sha', sha, '--no-upload'], {}, root);
      assert.equal(result.status, 2, result.stderr + result.stdout);
      assert.match(result.stderr, /sha.*40.*lowercase|full lowercase.*sha/i);
    }
  } finally {
    rmTmp(root);
  }
});

test('recordSurfaceCaptureFailure: keys that sanitize identically do not clobber each other', () => {
  const root = mkTmp();
  const dir = path.join(root, 'maps');
  fs.mkdirSync(dir, { recursive: true });
  // Both keys collapse to "about_x@900" under the filename sanitizer — the digest
  // suffix must keep them as two distinct ledger entries.
  recordSurfaceCaptureFailure(dir, { key: 'about?x@900', reason: 'first', kind: 'capture' });
  recordSurfaceCaptureFailure(dir, { key: 'about#x@900', reason: 'second', kind: 'capture' });
  const failures = readSurfaceCaptureFailures(dir);
  assert.equal(failures.length, 2);
  assert.deepEqual(new Set(failures.map((f) => f.key)), new Set(['about?x@900', 'about#x@900']));
  rmTmp(root);
});

test('styleproof-map: tolerate flag publishes partial baseline when Playwright exits non-zero', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@test'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(
      fakePlaywright,
      `#!/bin/sh
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/styleproof-surface-capture-failures"
printf '%s\\n' '{"key":"about@900","reason":"boom","kind":"capture"}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/styleproof-surface-capture-failures/about@900.json"
exit 1
`,
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const maps = path.join(root, 'maps');
    const r = run(
      MAP,
      ['--spec', spec, '--dir', 'base', '--base-dir', maps, '--tolerate-surface-failures', '--no-upload'],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        STYLEPROOF_SHA: undefined,
        GITHUB_HEAD_SHA: undefined,
        GITHUB_BASE_SHA: undefined,
        GITHUB_EVENT_PATH: undefined,
        GITHUB_EVENT_NAME: undefined,
        GITHUB_SHA: undefined,
      },
      root,
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(maps, 'base', MAP_MANIFEST), 'utf8'));
    assert.equal(manifest.sha, 'uncommitted');
    assert.equal(manifest.dirty, true);
    assert.equal(manifest.surfaceCaptureFailures?.length, 1);
    assert.match(r.stderr, /partial baseline/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: tolerate flag does NOT promote a failure with no ledger entry', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@test'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    // Maps captured, exit 1, but NOTHING in the failure ledger — the failure class
    // (self-check, nondeterminism, harness crash) was never recorded as tolerable,
    // so promotion here would publish a lying "partial baseline".
    fs.writeFileSync(
      fakePlaywright,
      `#!/bin/sh
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
exit 1
`,
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const maps = path.join(root, 'maps');
    const r = run(
      MAP,
      ['--spec', spec, '--dir', 'base', '--base-dir', maps, '--tolerate-surface-failures', '--no-upload'],
      { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      root,
    );
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /NO ledgered surface failure/);
    assert.equal(fs.existsSync(path.join(maps, 'base', MAP_MANIFEST)), false);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: fatal self-check failure cannot be laundered by a tolerated failure', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@test'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(
      fakePlaywright,
      `#!/bin/sh
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/styleproof-surface-capture-failures"
printf '%s\\n' '{"key":"about@900","reason":"boom","kind":"capture"}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/styleproof-surface-capture-failures/about@900.json"
printf '%s\\n' 'styleproof self-check failed: home is non-deterministic' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/styleproof-fatal-capture.flag"
exit 1
`,
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const maps = path.join(root, 'maps');
    const targetDir = path.join(maps, 'base');
    const r = run(
      MAP,
      ['--spec', spec, '--dir', 'base', '--base-dir', maps, '--tolerate-surface-failures', '--no-upload'],
      { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      root,
    );
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /fatal self-check failure/i);
    assert.equal(fs.existsSync(targetDir), false, 'fatal capture output must be discarded');
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: tolerate off keeps non-zero exit when Playwright fails', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@test'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(fakePlaywright, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(fakePlaywright, 0o755);
    const maps = path.join(root, 'maps');
    const r = run(
      MAP,
      ['--spec', spec, '--dir', 'base', '--base-dir', maps, '--no-upload'],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
      root,
    );
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(path.join(maps, 'base', MAP_MANIFEST)), false);
  } finally {
    rmTmp(root);
  }
});

test('diff CLI: partial base manifest with failures vs full head fails closed as exit 1', () => {
  const root = mkTmp();
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeManifest(A, baseSha, 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
  });
  writeManifest(B, headSha, 'same-env-key');
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath, '--expected-before-sha', baseSha, '--expected-after-sha', headSha]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /BASELINE capture/);
  assert.match(r.stdout, /repair the base branch/);
  assert.doesNotMatch(r.stdout, /about@1280: new surface/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(parsed.baselineFailures, [{ key: 'about@1280', reason: 'capture_failed' }]);
  assert.equal(parsed.surfaces.find((s) => s.surface === 'about@1280')?.missing, 'before');
  assert.equal(parsed.certifiesFully, false);
  rmTmp(root);
});

test('diff CLI: baseline failure receipt without a head surface still blocks a clean certification', () => {
  const root = mkTmp();
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, baseSha, 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
  });
  writeManifest(B, headSha, 'same-env-key');
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath, '--expected-before-sha', baseSha, '--expected-after-sha', headSha]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /✓ 0 reviewable computed-style changes/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(parsed.partialBaseline, true);
  assert.equal(parsed.certifiesFully, false);
  rmTmp(root);
});

test('diff CLI: about@auto baseline failure vs about@1280 head is repair-base not exit 3', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@auto', reason: 'viewport detection failed', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /repair the base branch/);
  assert.doesNotMatch(r.stdout, /review before baselining/);
  assert.doesNotMatch(r.stdout, /about@1280: new surface/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(parsed.baselineFailures, [{ key: 'about@auto', reason: 'capture_failed' }]);
  assert.deepEqual(parsed.explainedMissingBaselineSurfaces, ['about@1280']);
  assert.equal(parsed.partialBaseline, true);
  rmTmp(root);
});

test('diff CLI: greenfield sibling still exits 1 when another surface has @auto repair debt', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeCapture(B, 'pricing@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@auto', reason: 'viewport detection failed', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /review before baselining/);
  assert.match(r.stdout, /repair the base branch/);
  const jsonPath = path.join(root, 'mixed.json');
  run(DIFF, [A, B, '--json', jsonPath]);
  const mixed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(mixed.partialBaseline, true);
  assert.deepEqual(mixed.explainedMissingBaselineSurfaces, ['about@1280']);
  rmTmp(root);
});

test('diff CLI: manifest with zero maps still exit 2', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'home@1280', reason: 'all failed', kind: 'capture' }],
  });
  writeCapture(B, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2);
  rmTmp(root);
});

test('styleproof-report surfaces baseline capture failure callout', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@1280', reason: 'base nav timeout', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1, 'new surfaces make the report exit 1');
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(md, /baseline capture failure/i);
  assert.match(md, /do not approve indefinitely/i);
  assert.match(md, /baseline capture failed \(not first adoption\)/i);
  rmTmp(root);
});

test('styleproof-report persists the complete bounded baseline-failure receipt without relabeling unrelated new surfaces', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  for (const key of ['new-a@1280', 'new-b@1280', 'new-c@1280']) writeCapture(B, key, m, null);
  const failures = ['failed-a@1280', 'failed-b@1280', 'failed-c@1280', 'failed-d@1280', 'failed-e@1280'].map((key) => ({
    key,
    reason: `private exception for ${key}`,
    kind: 'capture',
  }));
  writeManifest(A, 'base-sha', 'same-env-key', { surfaceCaptureFailures: failures });
  writeManifest(B, 'head-sha', 'same-env-key');

  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));

  assert.deepEqual(
    json.baselineFailures,
    failures.map(({ key }) => ({ key, reason: 'capture_failed' })),
  );
  assert.equal(json.partialBaseline, true);
  const diffPath = path.join(root, 'diff.json');
  const diff = run(DIFF, [A, B, '--json', diffPath]);
  assert.equal(diff.status, 1, diff.stderr + diff.stdout);
  const diffReceipt = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
  assert.equal(diffReceipt.partialBaseline, true);
  assert.equal(diffReceipt.certifiesFully, false);
  assert.equal(json.surfaces.filter((surface) => surface.isNew === true).length, 3);
  assert.deepEqual(
    json.surfaces
      .filter((surface) => surface.isNew === true)
      .map((surface) => surface.surface)
      .sort(),
    ['new-a@1280', 'new-b@1280', 'new-c@1280'],
  );
  for (const { key } of failures) assert.match(md, new RegExp(key.replace('@', '@')));
  assert.match(md, /5 baseline capture failure\(s\)/i);
  assert.match(md, /3 new surface\(s\).*review.*first[- ]adoption/is);
  assert.doesNotMatch(md, /private exception/i);
  rmTmp(root);
});

test('styleproof-report marks only a matching failed baseline surface as repair debt', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'failed@1280', m, null);
  writeCapture(B, 'genuinely-new@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'failed@auto', reason: 'private viewport exception', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');

  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /1 new surface\(s\) with no baseline/);
  assert.doesNotMatch(r.stdout, /2 new surface\(s\)/);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const failed = json.surfaces.find((surface) => surface.surface === 'failed@1280');
  const genuinelyNew = json.surfaces.find((surface) => surface.surface === 'genuinely-new@1280');

  assert.deepEqual(failed, {
    ...failed,
    isNew: false,
    baselineStatus: 'capture-failed',
  });
  assert.equal(genuinelyNew.isNew, true);
  assert.equal(genuinelyNew.baselineStatus, 'new');
  assert.match(md, /failed@1280.*baseline repair debt/is);
  assert.match(md, /genuinely-new@1280.*reviewable first-adoption surface/is);
  assert.doesNotMatch(md, /private viewport exception/i);
  rmTmp(root);
});

test('styleproof-report fails closed for repair debt without misreporting it as new', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'failed@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'failed@auto', reason: 'private exception', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');

  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /1 removed or baseline-repair-debt surface\(s\)/);
  assert.doesNotMatch(r.stdout, /new surface\(s\)/);
  rmTmp(root);
});

test('styleproof-report keeps large baseline-failure receipts inside the markdown display budget', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  const failures = Array.from({ length: 10_000 }, (_, index) => ({
    key: `failed-${String(index).padStart(5, '0')}@1280`,
    reason: 'private exception',
    kind: 'capture',
  }));
  writeManifest(A, 'base-sha', 'same-env-key', { surfaceCaptureFailures: failures });
  writeManifest(B, 'head-sha', 'same-env-key');

  generateStyleMapReport({ beforeDir: A, afterDir: B, outDir: out, maxReportBytes: 400_000 });
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.ok(Buffer.byteLength(md) <= 400_000, `markdown bytes: ${Buffer.byteLength(md)}`);
  assert.match(md, /display budget/);
  assert.match(md, /full bounded identities are in report\.json/);
  assert.equal(json.baselineFailures.length, failures.length);
  assert.deepEqual(json.baselineFailures[0], { key: 'failed-00000@1280', reason: 'capture_failed' });
  assert.deepEqual(json.baselineFailures.at(-1), { key: 'failed-09999@1280', reason: 'capture_failed' });
  rmTmp(root);
});

test('styleproof-report treats maxReportBytes as a strict UTF-8 ceiling for every report shape', () => {
  const cases = [
    { budget: 0, kind: 'empty' },
    { budget: 1, kind: 'empty' },
    { budget: 64, kind: 'one-sided' },
    { budget: 64, kind: 'changed' },
    { budget: 256, kind: 'unicode' },
  ];
  for (const { budget, kind } of cases) {
    const root = mkTmp();
    const A = path.join(root, 'a');
    const B = path.join(root, 'b');
    const out = path.join(root, 'report');
    const baseText = kind === 'unicode' ? 'é'.repeat(40) : 'before';
    const headText = kind === 'unicode' ? '界'.repeat(40) : 'after';
    const base = makeMap({ elements: { body: { tag: 'body' }, 'body > p': { tag: 'p', text: baseText } } });
    const head =
      kind === 'one-sided'
        ? makeMap({
            elements: {
              body: { tag: 'body' },
              'body > p': { tag: 'p', text: baseText },
              'body > aside': { tag: 'aside', text: headText },
            },
          })
        : kind === 'changed' || kind === 'unicode'
          ? makeMap({ elements: { body: { tag: 'body' }, 'body > p': { tag: 'p', text: headText } } })
          : base;
    writeCapture(A, 'home@1280', base, null);
    writeCapture(B, 'home@1280', head, null);
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');

    generateStyleMapReport({ beforeDir: A, afterDir: B, outDir: out, includeContent: true, maxReportBytes: budget });
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.ok(
      Buffer.byteLength(md, 'utf8') <= budget,
      `${kind} report used ${Buffer.byteLength(md, 'utf8')} of ${budget} bytes`,
    );
    rmTmp(root);
  }
});

test('styleproof-report never echoes untrusted baseline failure details', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const marker = 'PRIVATE-BASELINE-FAILURE-MARKER';
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: `home@1280-${marker}`, reason: `**pwned** <script> ${marker}`, kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  run(REPORT, [A, B, '--out', out]);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const json = fs.readFileSync(path.join(out, 'report.json'), 'utf8');
  assert.match(md, /baseline capture failure/i);
  assert.doesNotMatch(md, /<script>|PRIVATE-BASELINE-FAILURE-MARKER|pwned/i);
  assert.doesNotMatch(json, /<script>|PRIVATE-BASELINE-FAILURE-MARKER|pwned/i);
  assert.match(json, /capture-[0-9a-f]{12}/);
  rmTmp(root);
});

test('styleproof-ci passes tolerate only on cold base capture args', () => {
  const src = fs.readFileSync(CI, 'utf8');
  assert.match(src, /--tolerate-surface-failures/);
  const headCapture = src.match(/let headOverlay;[\s\S]*?writeOutputs\(baseCaptureFailed\);/);
  assert.ok(headCapture, 'head capture block');
  assert.doesNotMatch(headCapture[0], /tolerate-surface-failures/);
});

test('styleproof-map help documents tolerate is baseline-only and CI head never enables it', () => {
  const help = run(MAP, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /never on head/);
});

test('action.yml documents partial baseline vs DEGRADED_BASELINE', () => {
  const action = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
  assert.match(action, /Partial baselines with tolerated per-surface failures keep this false/);
  assert.match(action, /PARTIAL_BASELINE/);
  assert.match(action, /Block on partial baseline/);
  assert.match(action, /explainedMissingBaselineSurfaces/);
  assert.doesNotMatch(
    action.match(/- name: Block on partial baseline[\s\S]*?(?=\n\s{4}- name:)/)?.[0] ?? '',
    /require-approval/,
  );
});
