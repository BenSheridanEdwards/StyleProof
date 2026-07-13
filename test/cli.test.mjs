import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveStyleMap } from '../dist/capture.js';
import { DEFAULT_MAP_STORE_BRANCH, MAP_MANIFEST, expectedCompatibilityKey } from '../dist/map-store.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
const INIT = path.join(here, '..', 'bin', 'styleproof-init.mjs');
const VARIANTS = path.join(here, '..', 'bin', 'styleproof-variants.mjs');

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

// Two surfaces that differ in one longhand, and an identical pair.
// A real capture always carries a manifest (v4 refuses a map-bearing side without one),
// so the fixtures stamp one on both sides by default. Pass `{ bare: true }` for the
// manifest-refusal tests that deliberately ship maps with no manifest (a legacy bundle).
function differingPair({ bare = false } = {}) {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(
    A,
    'home@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(0, 0, 0)' } } } }),
    null,
  );
  writeCapture(
    B,
    'home@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(255, 0, 0)' } } } }),
    null,
  );
  if (!bare) {
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');
  }
  return { root, A, B };
}

function identicalPair({ bare = false } = {}) {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(0, 0, 0)' } } },
  });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  if (!bare) {
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');
  }
  return { root, A, B };
}

// ---------------------------------------------------------------- styleproof-map

test('styleproof-map runs Playwright with local cache defaults', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(
      fakePlaywright,
      '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"; touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.json" "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.har"; printf "%s|%s|%s|%s\\n" "$STYLEMAP_DIR" "$STYLEPROOF_BASEDIR" "$STYLEPROOF_SCREENSHOTS" "$*"\n',
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const r = spawnSync(process.execPath, [MAP], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /current\|\.styleproof\/maps\|1\|test --grep styleproof capture/);
    assert.equal(fs.existsSync(path.join(root, '.styleproof/maps/current/home@1280.har')), false);
    assert.ok(fs.existsSync(path.join(root, '.styleproof/maps/current', MAP_MANIFEST)));
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map keeps HAR files only when explicitly requested', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(
      fakePlaywright,
      '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"; touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.json" "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.har"\n',
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const r = spawnSync(process.execPath, [MAP, '--keep-har'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(root, '.styleproof/maps/current/home@1280.har')), true);
    assert.ok(fs.existsSync(path.join(root, '.styleproof/maps/current', MAP_MANIFEST)));
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map writes no manifest when the capture produced zero surfaces', () => {
  // A manifest over an empty bundle would read as "a bundle that claims to exist
  // yet holds nothing", which the diff refuses as a missing base map (exit 2). A
  // bare dir instead means "no baseline yet" — on a first adoption the base
  // commit predates the spec, and the diff takes the exit-3 review path.
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(fakePlaywright, '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"\n');
    fs.chmodSync(fakePlaywright, 0o755);
    const r = spawnSync(process.execPath, [MAP], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /0 surfaces captured — no manifest written/);
    assert.equal(fs.existsSync(path.join(root, '.styleproof/maps/current', MAP_MANIFEST)), false);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map runs configured variant crawl before Playwright capture', () => {
  const root = mkTmp();
  try {
    const spec = path.join(root, 'e2e/styleproof.spec.ts');
    const log = path.join(root, 'order.log');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, '// fake spec');
    const binDir = path.join(root, 'fake-bin');
    fs.mkdirSync(binDir);
    const fakeVariants = path.join(binDir, 'styleproof-variants');
    fs.writeFileSync(fakeVariants, '#!/bin/sh\nprintf "crawl:%s\\n" "$*" >> "$STYLEPROOF_TEST_LOG"\n');
    fs.chmodSync(fakeVariants, 0o755);
    const fakePlaywright = path.join(binDir, 'playwright');
    fs.writeFileSync(
      fakePlaywright,
      '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"; printf "map:%s\\n" "$*" >> "$STYLEPROOF_TEST_LOG"\n',
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const r = spawnSync(
      process.execPath,
      [
        MAP,
        '--crawl-base-url',
        'http://127.0.0.1:3000',
        '--crawl-route',
        '/',
        '--crawl-route',
        'settings=/settings',
        '--crawl-out',
        'styleproof.variants.generated.json',
        '--crawl-strict',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, STYLEPROOF_TEST_LOG: log },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      'crawl:--base-url http://127.0.0.1:3000 --out styleproof.variants.generated.json --route / --route settings=/settings --strict',
      'map:test --grep styleproof capture',
    ]);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map exits 2 when the default spec is missing', () => {
  const root = mkTmp();
  try {
    const r = spawnSync(process.execPath, [MAP], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /run styleproof-init/);
    assert.match(r.stderr, /Next: run styleproof-init/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-variants documents the required running-app input', () => {
  const r = run(VARIANTS, ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--base-url <url>/);
  assert.match(r.stdout, /--route <route>/);
  assert.match(r.stdout, /--strict/);
});

// ---------------------------------------------------------------- styleproof-diff

test('diff CLI exits 0 when captures are identical', () => {
  const { root, A, B } = identicalPair();
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(root);
});

test('diff CLI exits 1 when captures differ', () => {
  const { root, A, B } = differingPair();
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /computed-style difference\(s\)/);
  rmTmp(root);
});

test('diff CLI exits 2 on wrong argument count', () => {
  const r = run(DIFF, ['a', 'b', 'c']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: styleproof-diff/);
});

test('diff CLI exits 2 on an unknown flag', () => {
  const r = run(DIFF, ['a', 'b', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.match(r.stderr, /Next: run styleproof-diff --help/);
});

test('diff CLI exits 2 when a capture dir does not exist', () => {
  const r = run(DIFF, ['/no/such/before', '/no/such/after']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no capture at/);
  assert.match(r.stderr, /Next: pass existing capture directories/);
});

test('diff CLI exits 2 (never 3) when the before dir has a manifest but zero captures', () => {
  // A restore/capture that CLAIMS success (the bundle manifest is there) yet
  // delivered no maps — a corrupt bundle. Without the guard every after surface
  // marks `missing: 'before'` → exit 3 ("only new surfaces") → an approvable
  // all-new report that bakes in a full regression.
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  writeManifest(A, 'base-sha', 'same-env-key'); // a valid manifest but the bundle holds zero maps
  writeCapture(B, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  writeManifest(B, 'head-sha', 'same-env-key'); // the head side is a real capture with a manifest
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.notEqual(r.status, 3);
  assert.match(r.stderr, /base map missing: restore it from the map store or recapture both sides/);
  assert.match(r.stderr, /refusing to treat every surface as new/);
  rmTmp(root);
});

test('diff CLI keeps exit 3 for a truly bare before dir — no baseline was ever captured', () => {
  // The first-adoption flow: the recapture fallback checks out a base commit that
  // predates the capture spec, so the base side legitimately yields zero surfaces
  // AND no manifest. That is "no baseline exists yet", not breakage — the head's
  // surfaces show as new for review before baselining.
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  writeCapture(B, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  writeManifest(B, 'head-sha', 'same-env-key'); // head is a real capture; base is genuinely bare
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /new surface\(s\) captured with no baseline/);
  rmTmp(root);
});

test('diff CLI exits 2 (never 3) when the after dir has zero captures but the before dir has some', () => {
  // The mirror case: a head capture/restore that produced nothing. Without the
  // guard every base surface marks `missing: 'after'`, the new-surface count
  // (which tallies both directions) exits 3, and a head that rendered nothing
  // becomes an approvable "all new" report — and, once approved, the next base.
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(A, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  writeManifest(A, 'base-sha', 'same-env-key'); // the base side is a real capture with a manifest
  fs.mkdirSync(B, { recursive: true });
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.notEqual(r.status, 3);
  assert.match(r.stderr, /head map missing: the head capture produced zero surfaces/);
  assert.match(r.stderr, /refusing to treat every surface as removed\/new/);
  rmTmp(root);
});

test('diff CLI keeps exit 3 when a baseline exists and only specific surfaces are new', () => {
  // Before is NON-empty (home matches) and about is new → genuinely new surface,
  // exit 3 keeps its meaning. This is the case the exit-2 guard must NOT swallow.
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /new surface\(s\) captured with no baseline/);
  rmTmp(root);
});

test('diff CLI --json writes the structured diff to a file', () => {
  const { root, A, B } = differingPair();
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(parsed.counts.style, 1);
  assert.ok(Array.isArray(parsed.surfaces));
  rmTmp(root);
});

test('diff CLI --json=PATH equals form is accepted', () => {
  const { root, A, B } = differingPair();
  const jsonPath = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, `--json=${jsonPath}`]);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(jsonPath));
  rmTmp(root);
});

test('diff CLI exits 2 (not 1) when --json cannot be written', () => {
  // A bad --json path is a usage/setup error, not "reviewable differences". The
  // write throws (ENOENT: no such directory) and must surface as exit 2 — never the
  // exit 1 that CI reads as a real diff.
  const { root, A, B } = differingPair();
  const jsonPath = path.join(root, 'no', 'such', 'dir', 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonPath]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.notEqual(r.status, 1);
  assert.match(r.stderr, /could not write --json/);
  rmTmp(root);
});

test('diff CLI --max truncates the per-surface listing and prints a hint', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  // Several differing elements so the listing exceeds --max 1.
  const mk = (c) =>
    makeMap({
      elements: {
        'body > div:nth-child(1)': { tag: 'div', style: { color: c } },
        'body > div:nth-child(2)': { tag: 'div', style: { color: c } },
        'body > div:nth-child(3)': { tag: 'div', style: { color: c } },
      },
    });
  writeCapture(A, 'home@1280', mk('rgb(0, 0, 0)'), null);
  writeCapture(B, 'home@1280', mk('rgb(1, 1, 1)'), null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B, '--max', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /more lines/);
  rmTmp(root);
});

test('diff CLI allows different cache keys when the runtime environment matches', () => {
  const { root, A, B } = differingPair();
  writeManifest(A, 'base-sha', 'base-spec-key');
  writeManifest(B, 'head-sha', 'head-spec-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /computed-style difference/);
  rmTmp(root);
});

// v4: a two-directory diff/report REFUSES a side without a manifest — the
// same-environment guard can't be enforced, so it exits 2 (usage/capture error)
// naming the bare side(s), rather than the legacy "compare anyway" tolerance (#198).
// A both-present pair stays silent and compares normally.
test('diff CLI exits 2 when the before dir is a legacy bundle (maps, no manifest)', () => {
  const { root, A, B } = differingPair({ bare: true });
  writeManifest(B, 'head-sha', 'head-spec-key'); // only the after side has one
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, r.stderr); // v4 refuses — never the exit-1 real-diff path
  assert.match(r.stderr, /before carries no styleproof-manifest\.json/);
  assert.match(r.stderr, /unsupported since v4/);
  rmTmp(root);
});

test('diff CLI exits 2 naming the after dir when only it lacks a manifest', () => {
  const { root, A, B } = differingPair({ bare: true });
  writeManifest(A, 'base-sha', 'base-spec-key'); // only the before side has one
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /after carries no styleproof-manifest\.json/);
  rmTmp(root);
});

test('diff CLI exits 2 naming both sides when neither dir has a manifest', () => {
  const { root, A, B } = identicalPair({ bare: true });
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, r.stderr); // refused even though the maps are identical
  assert.match(r.stderr, /before and after carry no styleproof-manifest\.json/);
  rmTmp(root);
});

test('diff CLI compares normally when both dirs carry a manifest', () => {
  const { root, A, B } = differingPair(); // helper stamps both manifests
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1, r.stderr); // real diff → exit 1, not the manifest refusal
  assert.doesNotMatch(r.stderr, /no styleproof-manifest\.json/);
  rmTmp(root);
});

test('diff CLI reads a plain .json capture against a .json.gz capture', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  saveStyleMap(
    path.join(A, 'home@1280.json'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'rgb(0, 0, 0)' } } } }),
  );
  saveStyleMap(
    path.join(B, 'home@1280.json.gz'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'rgb(9, 9, 9)' } } } }),
  );
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1);
  rmTmp(root);
});

// ------------------------------------------------- cached styleproof-diff/report

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}
function cliEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) delete env[key];
  }
  return env;
}
const runIn = (cwd, script, a, opts = {}) =>
  spawnSync(process.execPath, [script, ...a], {
    cwd,
    encoding: 'utf8',
    env: cliEnv(opts.env),
  });
const mapWith = (color) => makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color } } } });

function writeSpec(repo) {
  fs.mkdirSync(path.join(repo, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'e2e/styleproof.spec.ts'), '// styleproof spec');
}

function commitAll(repo, message) {
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', message], { cwd: repo });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

function addBareOrigin(repo) {
  const remote = mkTmp('styleproof-remote-');
  spawnSync('git', ['init', '--bare', '-q'], { cwd: remote });
  spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  return remote;
}

function writeManifest(dir, sha, compatibilityKey) {
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
      },
      null,
      2,
    ),
  );
}

function seedMapStore(repo, bundles) {
  const remoteUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const store = mkTmp('styleproof-map-store-');
  try {
    spawnSync('git', ['init', '-q', '-b', DEFAULT_MAP_STORE_BRANCH], { cwd: store });
    spawnSync('git', ['config', 'user.email', 'styleproof@example.test'], { cwd: store });
    spawnSync('git', ['config', 'user.name', 'StyleProof Test'], { cwd: store });
    fs.writeFileSync(path.join(store, 'README.md'), '# StyleProof maps\n');
    for (const bundle of bundles) {
      const dest = path.join(store, bundle.sha, bundle.compatibilityKey);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(bundle.dir, dest, { recursive: true });
    }
    spawnSync('git', ['add', '-A'], { cwd: store });
    spawnSync('git', ['commit', '-qm', 'seed maps'], { cwd: store });
    spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: store });
    spawnSync('git', ['push', '-q', 'origin', `HEAD:${DEFAULT_MAP_STORE_BRANCH}`], { cwd: store });
  } finally {
    rmTmp(store);
  }
}

function setupCachedComparison({ headColor = 'rgb(0, 0, 0)', baseBranch = 'main' } = {}) {
  const repo = mkTmp();
  gitInit(repo);
  addBareOrigin(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeSpec(repo);
  const baseSha = commitAll(repo, 'base');
  if (baseBranch !== 'main') {
    spawnSync('git', ['checkout', '-qb', baseBranch], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'stack.txt'), baseBranch);
    commitAll(repo, baseBranch);
  }
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature');
  const headSha = commitAll(repo, 'feature');

  const compatibilityKey = expectedCompatibilityKey({ cwd: repo, spec: 'e2e/styleproof.spec.ts' });
  const baseDir = path.join(repo, 'seed-base');
  const headDir = path.join(repo, 'seed-head');
  writeCapture(baseDir, 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  writeCapture(headDir, 'home@1280', mapWith(headColor), null);
  writeManifest(
    baseDir,
    baseBranch === 'main'
      ? baseSha
      : spawnSync('git', ['rev-parse', baseBranch], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
    compatibilityKey,
  );
  writeManifest(headDir, headSha, compatibilityKey);
  seedMapStore(repo, [
    {
      sha:
        baseBranch === 'main'
          ? baseSha
          : spawnSync('git', ['rev-parse', baseBranch], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
      compatibilityKey,
      dir: baseDir,
    },
    { sha: headSha, compatibilityKey, dir: headDir },
  ]);
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(headDir, { recursive: true, force: true });
  return { repo, baseSha, headSha, compatibilityKey };
}

test('diff defaults to cached maps against the inferred main branch', () => {
  const { repo } = setupCachedComparison();
  const r = runIn(repo, DIFF, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff defaults to the GitHub PR base for stacked local branches when gh is available', () => {
  const { repo } = setupCachedComparison({ baseBranch: 'stack-base' });
  const binDir = path.join(repo, 'fake-bin');
  fs.mkdirSync(binDir);
  const fakeGh = path.join(binDir, 'gh');
  fs.writeFileSync(fakeGh, '#!/bin/sh\nprintf "stack-base\\n"\n');
  fs.chmodSync(fakeGh, 0o755);
  const r = runIn(repo, DIFF, [], {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, GITHUB_BASE_REF: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff accepts a single base ref and uses cached maps', () => {
  const { repo } = setupCachedComparison({ headColor: 'rgb(255, 0, 0)' });
  const r = runIn(repo, DIFF, ['main']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /computed-style difference/);
  rmTmp(repo);
});

test('diff default flow explains how to recover when cached maps are missing', () => {
  const repo = mkTmp();
  gitInit(repo);
  addBareOrigin(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeSpec(repo);
  fs.writeFileSync(path.join(repo, 'readme'), 'x');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'feature'), 'x');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'feature'], { cwd: repo });
  const r = runIn(repo, DIFF, ['main']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cached maps are not available/);
  assert.match(r.stderr, /nothing was compared/);
  assert.match(r.stderr, /styleproof-diff <beforeDir> <afterDir>/);
  rmTmp(repo);
});

// Fail-loud contract for the no-args inferred path in a repo with NO git remote at
// all (a fresh local clone, no `origin`): the cached-map restore can't run, so
// nothing is compared — and that MUST surface as exit 2, never a soft exit 0 that a
// newcomer reads as "certified clean". The message names both working alternatives:
// run in CI where the base is restorable, or the two-directory form.
for (const [label, script, cmd] of [
  ['diff', DIFF, 'styleproof-diff'],
  ['report', REPORT, 'styleproof-report'],
]) {
  test(`${label} no-args exits 2 (never 0) in a repo with no git remote — nothing compared`, () => {
    const repo = mkTmp();
    gitInit(repo);
    spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
    writeSpec(repo);
    fs.writeFileSync(path.join(repo, 'readme'), 'base');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'feature'), 'head');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-qm', 'head'], { cwd: repo });
    const r = runIn(repo, script, []);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /cached maps are not available/);
    assert.match(r.stderr, /nothing was compared/);
    assert.match(r.stderr, new RegExp(`${cmd} <beforeDir> <afterDir>`));
    rmTmp(repo);
  });
}

test('report defaults to cached maps against the inferred main branch', () => {
  const { repo } = setupCachedComparison({ headColor: 'rgb(255, 0, 0)' });
  const r = runIn(repo, REPORT, []);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(repo, 'styleproof-report', 'report.json')));
  rmTmp(repo);
});

test('report accepts a single base ref and uses cached maps', () => {
  const { repo } = setupCachedComparison({ headColor: 'rgb(255, 0, 0)' });
  const out = path.join(repo, 'out');
  const r = runIn(repo, REPORT, ['main', '--out', out]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
  rmTmp(repo);
});

// -------------------------------------------------------------- styleproof-report

test('report CLI exits 0 and writes an empty report when nothing changed', () => {
  const { root, A, B } = identicalPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no changes/);
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
  rmTmp(root);
});

test('report CLI exits 1 and writes a report when surfaces changed', () => {
  const { root, A, B } = differingPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  rmTmp(root);
});

test('report CLI exits 2 on a manifest-less pair (v4 refuses)', () => {
  const { root, A, B } = differingPair({ bare: true });
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 2, r.stderr); // refused, not the exit-1 report-generated path
  assert.match(r.stderr, /before and after carry no styleproof-manifest\.json/);
  assert.match(r.stderr, /unsupported since v4/);
  rmTmp(root);
});

test('report CLI compares normally when both dirs carry a manifest', () => {
  const { root, A, B } = differingPair(); // helper stamps both manifests
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out]);
  assert.equal(r.status, 1, r.stderr); // real diff → report generated, not refused
  assert.doesNotMatch(r.stderr, /no styleproof-manifest\.json/);
  rmTmp(root);
});

test('report CLI help states current crop defaults', () => {
  const r = run(REPORT, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--pad <px>[\s\S]*default: 12/);
  assert.match(r.stdout, /--max-crops <n>[\s\S]*default: 8/);
  assert.doesNotMatch(r.stdout, /default: 24/);
  assert.doesNotMatch(r.stdout, /default: 6/);
});

test('report CLI exits 2 on wrong argument count', () => {
  const r = run(REPORT, ['a', 'b', 'c']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: styleproof-report/);
});

test('report CLI exits 2 on an unknown flag', () => {
  const r = run(REPORT, ['a', 'b', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag: --nope/);
  assert.match(r.stderr, /Next: run styleproof-report --help/);
});

test('committed-map compatibility flags are not supported in the v3 CLI', () => {
  const diff = run(DIFF, ['--base-ref', 'main']);
  assert.equal(diff.status, 2);
  assert.match(diff.stderr, /unknown flag: --base-ref/);

  const report = run(REPORT, ['--maps-dir', 'stylemaps/current']);
  assert.equal(report.status, 2);
  assert.match(report.stderr, /unknown flag: --maps-dir/);
});

// ------------------------------------------------------- error & validation paths

test('diff CLI exits 2 with a naming message on a corrupt .gz', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  fs.writeFileSync(path.join(A, 'home@1280.json.gz'), Buffer.from('this is not gzip'));
  fs.writeFileSync(path.join(B, 'home@1280.json.gz'), Buffer.from('this is not gzip'));
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /corrupt or truncated/);
  rmTmp(root);
});

test('diff CLI exits 2 on a non-numeric --max', () => {
  const { root, A, B } = identicalPair();
  const r = run(DIFF, [A, B, '--max', 'abc']);
  assert.equal(r.status, 2);
  rmTmp(root);
});

test('report CLI exits 2 on a non-numeric --pad', () => {
  const { root, A, B } = differingPair();
  const out = path.join(root, 'out');
  const r = run(REPORT, [A, B, '--out', out, '--pad', 'xyz']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pad must be a number/);
  rmTmp(root);
});

test('init scaffolds a dedicated StyleProof Playwright config that serves a PRODUCTION build', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const config = fs.readFileSync(path.join(dir, 'playwright.styleproof.config.ts'), 'utf8');
    // The config starts the server itself, so a consumer can't forget to — or point it at a dev server.
    assert.match(config, /webServer:/, 'scaffolds a webServer');
    // The exact command builds + serves a production build (not a dev server) — the
    // comment elsewhere mentions `next dev` as the thing to avoid, so assert the command.
    assert.match(config, /command: 'npm run build && npm run start'/, 'the webServer serves a production build');
    // And it says WHY, so the choice is understood, not cargo-culted.
    assert.match(config, /PRODUCTION build/i);
    assert.match(config, /JIT-compile|timing-variable/i, 'explains why a dev server flakes');
    // Surfaces capture in parallel by default — independent, uniquely-keyed tests.
    assert.match(config, /fullyParallel: true/, 'scaffolds parallel surface capture');
    assert.match(config, /testDir: "\.\/e2e"/, 'scopes Playwright discovery to the StyleProof spec directory');
    assert.match(config, /testMatch: "styleproof\.spec\.ts"/, 'scopes Playwright discovery to the StyleProof spec');
    assert.match(config, /env: \{ PORT: '3000' \}/, 'passes the configured port to production servers');
  } finally {
    rmTmp(dir);
  }
});

test('init scaffolds a MINIMAL spec — StyleProof owns the settle, so go() is not boilerplate', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'styleproof.spec.ts'), 'utf8');
    // go() must NOT hand-roll waits StyleProof already does — `networkidle` never
    // fires under an SSE stream, and the network-aware settle waits for data/fonts.
    assert.doesNotMatch(spec, /waitUntil: 'networkidle'/, 'go() must not wait on networkidle');
    assert.doesNotMatch(spec, /document\.fonts\.ready/, 'settle must not re-wait fonts (StyleProof does)');
    assert.doesNotMatch(spec, /animation: none/, 'settle must not re-freeze animations (StyleProof does)');
    // What it DOES keep is the one thing StyleProof can't know about: scroll-reveal.
    assert.match(spec, /window\.scrollTo/, 'settle triggers IntersectionObserver scroll-reveal');
    // And it points at the minimal one-liner for apps with no reveal-on-scroll content.
    assert.match(spec, /go: \(page\) => page\.goto\('\/'\)/, 'documents the minimal go() escape hatch');
  } finally {
    rmTmp(dir);
  }
});

test('init scaffolds auto breakpoints — no hardcoded widths, by design', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'styleproof.spec.ts'), 'utf8');
    // The scaffold omits widths so a fresh project gets zero-config breakpoint
    // detection by default — the surface sweeps the app's real @media bands.
    assert.doesNotMatch(spec, /widths: \[/, 'no hardcoded widths — detection is the default');
    assert.match(spec, /detects your @media breakpoints/, 'explains that widths are auto-detected');
  } finally {
    rmTmp(dir);
  }
});

test('init scaffolds the out-of-the-box gate: cache-first maps + report workflow + pre-push publish hook', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    const hook = fs.readFileSync(path.join(dir, '.githooks', 'pre-push'), 'utf8');
    assert.match(hook, /styleproof-map --restore --sha "\$head_sha"/, 'hook restores an existing exact map first');
    assert.match(hook, /--sha "\$head_sha" --upload/, 'hook requires a clean exact-SHA upload on a miss');
    assert.doesNotMatch(hook, /git add/, 'maps never get committed to the PR branch');
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.styleproof\//);

    const ci = fs.readFileSync(path.join(dir, '.github', 'workflows', 'styleproof.yml'), 'utf8');
    assert.match(
      ci,
      /styleproof-map\.mjs --restore --sha "\$BASE_SHA"/,
      'CI first restores cached maps with the installed release',
    );
    assert.match(ci, /capture-needed=true/, 'CI records cache misses');
    assert.match(ci, /Capture maps in CI on cache miss/, 'CI has a correctness fallback');
    assert.match(ci, /STYLEPROOF_REPLAY_FROM="\$MAP_ROOT\/base"/, 'fallback replays base data for head');
    assert.match(ci, /steps\.maps\.outputs\.base-hit/, 'a base hit avoids rebuilding the base');
    assert.match(ci, /--sha "\$BASE_SHA" --upload/, 'cold base capture is published for reuse');
    assert.match(ci, /--sha "\$HEAD_SHA" --upload/, 'cold head capture is published for reuse');
    assert.match(ci, /BenSheridanEdwards\/StyleProof@v4/, 'workflow uses the current report action');
    assert.match(ci, /require-approval: true/, 'workflow enables the approval report gate');
    assert.doesNotMatch(ci, /git add stylemaps/);
    assert.doesNotMatch(ci, /core\.hooksPath/);

    assert.match(r.stdout, /it runs on your first PR with no extra steps/, 'guidance leads with zero-config');
    assert.match(r.stdout, /pre-push hook restores an existing exact-SHA map/, 'the least-work hook is the default');
  } finally {
    rmTmp(dir);
  }
});

test('init in a git repo does not mutate core.hooksPath', () => {
  const dir = mkTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir });
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /activated the pre-push hook/);
    const hp = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(hp, '.husky', 'leaves the existing hooksPath untouched');
  } finally {
    rmTmp(dir);
  }
});

// ─── grouped human output + shared-chrome tier (#188, #193) ───────────────────

// A .cta restyle (background + padding) across N home widths; the padding change
// drags derived transform/perspective-origin, width/height, and cascaded ancestor
// heights — the noise the report already folds and the CLI now folds too.
function ctaRestyleMap(after, width) {
  const cta = {
    tag: 'button',
    cls: 'cta',
    rect: [100, 200, 120, 44],
    style: {
      'background-color': after ? 'rgb(37, 99, 235)' : 'rgb(59, 130, 246)',
      'padding-top': after ? '14px' : '10px',
      'padding-right': after ? '20px' : '16px',
      'padding-bottom': after ? '14px' : '10px',
      'padding-left': after ? '20px' : '16px',
      // derived longhands that follow the padding change:
      width: after ? '160px' : '152px',
      height: after ? '52px' : '44px',
      'transform-origin': after ? '80px 26px' : '76px 22px',
      'perspective-origin': after ? '80px 26px' : '76px 22px',
    },
  };
  const box = (h) => ({ tag: 'div', cls: '', rect: [0, 0, width, 900], style: { height: h } });
  return makeMap({
    elements: {
      html: box(after ? '1240px' : '1232px'),
      'html > body': box(after ? '1240px' : '1232px'),
      'html > body > main': box(after ? '1180px' : '1172px'),
      'html > body > main > button:nth-child(1)': cta,
    },
  });
}

test('diff CLI groups a one-view restyle to one finding with a derived-longhand fold (#188)', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  try {
    // The .cta restyle lives on `home` at four widths; `pricing` is unchanged.
    for (const w of [1280, 1080, 768, 390]) {
      writeCapture(A, `home@${w}`, ctaRestyleMap(false, w), null);
      writeCapture(B, `home@${w}`, ctaRestyleMap(true, w), null);
      const pricing = makeMap({ elements: { html: { tag: 'html', style: { height: '900px' } } } });
      writeCapture(A, `pricing@${w}`, pricing, null);
      writeCapture(B, `pricing@${w}`, pricing, null);
    }
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');
    const r = run(DIFF, [A, B]);
    assert.equal(r.status, 1, r.stderr);
    // One grouped finding, not one per surface. The header carries the per-surface
    // count and the derived-longhand fold; only the meaningful props are shown.
    const groupHeaders = r.stdout.match(/1 element restyled/g) ?? [];
    assert.equal(groupHeaders.length, 1, `expected one grouped finding, got:\n${r.stdout}`);
    assert.match(r.stdout, /\(\+7 derived longhands\)/, 'folds the derived longhands behind a count');
    assert.match(r.stdout, /\+3 more surfaces: home @ 1280, 1080, 768, 390/, 'keeps per-surface counts');
    assert.match(r.stdout, /padding: 10px 16px → 14px 20px/, 'shows the padding shorthand');
    assert.match(r.stdout, /background-color: rgb\(59, 130, 246\) → rgb\(37, 99, 235\)/);
    // The derived noise is suppressed from the visible detail.
    assert.doesNotMatch(r.stdout, /transform-origin|perspective-origin/);
    assert.doesNotMatch(r.stdout, /^\s+height:/m);
    // pricing was identical → not in the grouped output at all.
    assert.doesNotMatch(r.stdout, /pricing/);
  } finally {
    rmTmp(root);
  }
});

test('diff CLI --json stays the raw, complete machine contract regardless of human grouping (#188)', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const jsonPath = path.join(root, 'out.json');
  try {
    for (const w of [1280, 390]) {
      writeCapture(A, `home@${w}`, ctaRestyleMap(false, w), null);
      writeCapture(B, `home@${w}`, ctaRestyleMap(true, w), null);
    }
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');
    const r = run(DIFF, [A, B, '--json', jsonPath]);
    assert.equal(r.status, 1, r.stderr);
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // The JSON keeps EVERY surface and EVERY raw longhand (transform-origin, the
    // cascaded heights) — the grouping/fold is presentation-only, never here.
    assert.equal(j.surfaces.length, 2, 'both surfaces present in JSON');
    for (const sd of j.surfaces) {
      const props = sd.findings.flatMap((f) => f.props ?? []).map((p) => p.prop);
      assert.ok(props.includes('transform-origin'), 'raw derived longhands stay in JSON');
      assert.ok(props.includes('padding-top'), 'raw longhands, not the shorthand, in JSON');
    }
    // counts are the raw per-property totals, unchanged by grouping.
    assert.ok(j.counts.style > 0);
  } finally {
    rmTmp(root);
  }
});

test('diff CLI promotes a frame-wide change to a chrome callout, leaves a one-view change alone (#193)', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  try {
    // A persistent nav item is added on EVERY view (the shared frame). One view
    // (`home`) also has a real content restyle nothing else shares.
    const nav = (extra) => ({
      'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
      'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
      ...extra,
    });
    const views = ['home', 'settings', 'reports'];
    for (const v of views) {
      // base: nav has one link; head: nav gains a second link → an added element on every view.
      const before = makeMap({ elements: nav({}) });
      const afterExtra = {
        'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } },
      };
      const after = makeMap({ elements: nav(afterExtra) });
      writeCapture(A, `${v}@1280`, before, null);
      writeCapture(B, `${v}@1280`, after, null);
    }
    // home ALSO restyles its own content element (present only on home).
    const homeBefore = makeMap({
      elements: {
        ...nav({}),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(0, 0, 0)' } },
      },
    });
    const homeAfter = makeMap({
      elements: {
        ...nav({ 'html > body > nav > a:nth-child(2)': { tag: 'a', cls: 'link', style: { color: 'rgb(0, 0, 0)' } } }),
        'html > body > main > h1': { tag: 'h1', cls: 'title', style: { color: 'rgb(255, 0, 0)' } },
      },
    });
    writeCapture(A, 'home@1280', homeBefore, null);
    writeCapture(B, 'home@1280', homeAfter, null);
    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');

    const r = run(DIFF, [A, B]);
    assert.equal(r.status, 1, r.stderr);
    // The nav addition is chrome (every base that hosts the nav changed it), and
    // the pure-nav surfaces group under the callout.
    assert.match(r.stdout, /🧱 Global chrome change\(s\) — across all 3 surface\(s\)/, r.stdout);
    assert.match(r.stdout, /1 change\(s\) rode the shared frame/, r.stdout);
    // home entangled the nav change with its OWN h1 restyle, so it renders in place
    // (never hidden under the chrome banner) — the view-specific change stays visible.
    assert.match(r.stdout, /home@1280: 1 element added, 1 element restyled/, 'the view-specific change stays visible');
    assert.match(r.stdout, /color: rgb\(0, 0, 0\) → rgb\(255, 0, 0\)/, 'home h1 restyle shown');
  } finally {
    rmTmp(root);
  }
});

test('diff CLI does NOT promote a change that hit only SOME surfaces (#193)', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  try {
    // A nav present on all three views, but the change lands on only two of them —
    // so it is a partial change, never "chrome".
    const nav = (color) => ({
      'html > body > nav': { tag: 'nav', cls: 'rail', style: { display: 'flex' } },
      'html > body > nav > a:nth-child(1)': { tag: 'a', cls: 'link', style: { color } },
    });
    writeCapture(A, 'home@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), null);
    writeCapture(B, 'home@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), null);
    writeCapture(A, 'settings@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), null);
    writeCapture(B, 'settings@1280', makeMap({ elements: nav('rgb(255, 0, 0)') }), null);
    // reports has the nav too, unchanged.
    writeCapture(A, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), null);
    writeCapture(B, 'reports@1280', makeMap({ elements: nav('rgb(0, 0, 0)') }), null);

    writeManifest(A, 'base-sha', 'same-env-key');
    writeManifest(B, 'head-sha', 'same-env-key');
    const r = run(DIFF, [A, B]);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stdout, /Global chrome/, 'a change on only some hosting surfaces is not chrome');
  } finally {
    rmTmp(root);
  }
});

// A surface present only in the BEFORE set is a REMOVED surface — a deleted route
// or a dropped width. That is a change to review (exit 1), never part of the exit-3
// "only new surfaces" onboarding path, which the approve-all box waves through
// under a "new surfaces" banner.
test('diff CLI exits 1 and says REMOVED when a surface exists only in the before set', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(A, 'checkout@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}${r.stdout}`);
  assert.match(r.stdout, /REMOVED surface/);
  assert.match(r.stdout, /checkout/);
  rmTmp(root);
});

// A ledger that EXISTS but cannot be parsed is tampering or truncation; reading it
// as "no registry" would silently disarm coverage, determinism, AND residue at once.
test('diff CLI exits 2 on a corrupt coverage ledger', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  fs.writeFileSync(path.join(B, 'styleproof-coverage.json'), '{corrupt');
  const r = run(DIFF, [A, B]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}${r.stdout}`);
  assert.match(r.stderr, /corrupt coverage ledger/);
  rmTmp(root);
});

// Volatile subtrees are excluded from every layer of the comparison, so their count
// must be VISIBLE at the gate — a head-side auto-volatile region can hide a real
// change, and silence would read as "everything compared".
test('diff CLI surfaces the excluded-volatile count in output and --json', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(
    A,
    'home@1280',
    makeMap({
      elements: { body: { tag: 'body' }, 'body > div:nth-child(1)': { tag: 'div', style: { color: 'rgb(0, 0, 0)' } } },
    }),
    null,
  );
  const headMap = makeMap({ elements: { body: { tag: 'body' } } });
  headMap.volatile = ['body > div:nth-child(1)'];
  writeCapture(B, 'home@1280', headMap, null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const jsonOut = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonOut]);
  assert.match(r.stdout, /volatile subtree\(s\) excluded/);
  assert.match(r.stdout, /NOT certified/);
  const j = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  assert.equal(j.volatileExcluded, 1);
  rmTmp(root);
});

// BOTH sides skipping the forced-state layer compares {} vs {} — certifying nothing.
// The gate must say the layer is uncertified instead of "every state matches".
test('diff CLI warns when the forced-state layer was skipped on both sides', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  m.statesSkipped = true;
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeManifest(A, 'base-sha', 'same-env-key');
  writeManifest(B, 'head-sha', 'same-env-key');
  const jsonOut = path.join(root, 'out.json');
  const r = run(DIFF, [A, B, '--json', jsonOut]);
  assert.match(r.stdout, /forced-state layer uncertified on 1 surface/);
  const j = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  assert.equal(j.statesUncertified, 1);
  rmTmp(root);
});
