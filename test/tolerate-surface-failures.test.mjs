import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSelfCheckCaptureFailure } from '../dist/runner.js';
import {
  MAP_MANIFEST,
  recordSurfaceCaptureFailure,
  readSurfaceCaptureFailures,
  writeMapManifest,
  baselineFailureMatchesSurface,
} from '../dist/map-store.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
const CI = path.join(here, '..', 'bin', 'styleproof-ci.mjs');

function run(script, args, env = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, cwd });
}

function writeManifest(dir, sha, compatibilityKey, extra = {}) {
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify(
      {
        version: 1,
        packageVersion: 'test',
        sha,
        dirty: false,
        spec: 'e2e/styleproof.spec.ts',
        specHash: 'test',
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      },
      null,
      2,
    ),
  );
}

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
    sha: 'abc',
    screenshots: true,
    cwd: root,
  });
  assert.deepEqual(manifest.surfaceCaptureFailures, [
    { key: 'about@900', reason: 'navigation failed', kind: 'capture' },
  ]);
  assert.deepEqual(readSurfaceCaptureFailures(dir), manifest.surfaceCaptureFailures);
  rmTmp(root);
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
      { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      root,
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(maps, 'base', MAP_MANIFEST), 'utf8'));
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

test('diff CLI: partial base manifest with failures vs full head is not exit 2', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.notEqual(r.status, 2);
  assert.match(r.stdout, /BASELINE capture/);
  assert.match(r.stdout, /repair the base branch/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(parsed.baselineSurfaceFailures.length, 1);
  assert.equal(parsed.baselineSurfaceFailures[0].key, 'about@1280');
  assert.equal(parsed.surfaces.find((s) => s.surface === 'about@1280')?.missing, 'before');
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
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /repair the base branch/);
  assert.doesNotMatch(r.stdout, /review before baselining/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(parsed.baselineSurfaceFailures, [
    { key: 'about@auto', reason: 'viewport detection failed', kind: 'capture' },
  ]);
  assert.deepEqual(parsed.explainedMissingBaselineSurfaces, ['about@1280']);
  assert.equal(parsed.partialBaseline, true);
  rmTmp(root);
});

test('diff CLI: greenfield sibling stays exit 3 when another surface has @auto failure', () => {
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
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stdout, /review before baselining/);
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

test('styleproof-report escapes injected markdown in baseline failure reason', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const out = path.join(root, 'report');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key', {
    surfaceCaptureFailures: [{ key: 'home@1280', reason: '**pwned** <script>', kind: 'capture' }],
  });
  writeManifest(B, 'head-sha', 'same-env-key');
  run(REPORT, [A, B, '--out', out]);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.doesNotMatch(md, /<script>/i);
  assert.match(md, /\\\*\\\*pwned\\\*\\\*/);
  rmTmp(root);
});

test('styleproof-ci passes tolerate only on cold base capture args', () => {
  const src = fs.readFileSync(CI, 'utf8');
  assert.match(src, /--tolerate-surface-failures/);
  const headCapture = src.match(/captureOrDie\(\[([^\]]+)\]/);
  assert.ok(headCapture, 'head captureOrDie call');
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
