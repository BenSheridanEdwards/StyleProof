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
function differingPair() {
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
  return { root, A, B };
}

function identicalPair() {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const m = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'rgb(0, 0, 0)' } } },
  });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
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
      '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"; touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.har"; printf "%s|%s|%s|%s\\n" "$STYLEMAP_DIR" "$STYLEPROOF_BASEDIR" "$STYLEPROOF_SCREENSHOTS" "$*"\n',
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
      '#!/bin/sh\nmkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"; touch "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@1280.har"\n',
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
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA']) {
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
  assert.match(r.stderr, /run styleproof-map on the base and head commits/);
  rmTmp(repo);
});

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

test('init scaffolds the out-of-the-box gate: cache-first maps + report workflow, no git hook', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(fs.existsSync(path.join(dir, '.githooks', 'pre-push')), false, 'init does not create a pre-push hook');
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.styleproof\//);

    const ci = fs.readFileSync(path.join(dir, '.github', 'workflows', 'styleproof.yml'), 'utf8');
    assert.match(ci, /styleproof-map --restore --sha "\$BASE_SHA"/, 'CI first restores cached maps');
    assert.match(ci, /capture-needed=true/, 'CI records cache misses');
    assert.match(ci, /Capture maps in CI on cache miss/, 'CI has a correctness fallback');
    assert.match(ci, /STYLEPROOF_REPLAY_FROM=__stylemaps__\/base/, 'fallback replays base data for head');
    assert.match(ci, /BenSheridanEdwards\/StyleProof@v3/, 'workflow uses the full report action');
    assert.match(ci, /require-approval: true/, 'workflow enables the approval report gate');
    assert.doesNotMatch(ci, /git add stylemaps/);
    assert.doesNotMatch(ci, /core\.hooksPath/);

    assert.match(r.stdout, /it runs on your first PR with no extra steps/, 'guidance leads with zero-config');
    assert.match(r.stdout, /Optional, faster/, 'the local map pre-cache is framed as an optional speedup');
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
