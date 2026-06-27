import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveStyleMap } from '../dist/capture.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
const INIT = path.join(here, '..', 'bin', 'styleproof-init.mjs');

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

test('styleproof-map runs Playwright with committed-map defaults', () => {
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
      '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$STYLEMAP_DIR" "$STYLEPROOF_BASEDIR" "$STYLEPROOF_SCREENSHOTS" "$*"\n',
    );
    fs.chmodSync(fakePlaywright, 0o755);
    const r = spawnSync(process.execPath, [MAP], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /current\|stylemaps\|0\|test --grep styleproof capture/);
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

// ------------------------------------------------- styleproof-diff --base-ref

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}
function cliEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'GITHUB_BASE_REF')) delete env.GITHUB_BASE_REF;
  return env;
}
const runIn = (cwd, script, a, opts = {}) =>
  spawnSync(process.execPath, [script, ...a], {
    cwd,
    encoding: 'utf8',
    env: cliEnv(opts.env),
  });
const mapWith = (color) => makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color } } } });

test('diff --base-ref: identical working maps vs the committed base → exit 0', () => {
  const repo = mkTmp();
  gitInit(repo);
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const r = runIn(repo, DIFF, ['--base-ref', 'HEAD', 'maps']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff defaults to stylemaps/current against the inferred main branch', () => {
  const repo = mkTmp();
  gitInit(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  const r = runIn(repo, DIFF, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff defaults to the GitHub PR base for stacked local branches when gh is available', () => {
  const repo = mkTmp();
  gitInit(repo);
  const binDir = path.join(repo, 'fake-bin');
  fs.mkdirSync(binDir);
  const fakeGh = path.join(binDir, 'gh');
  fs.writeFileSync(fakeGh, '#!/bin/sh\nprintf "stack-base\\n"\n');
  fs.chmodSync(fakeGh, 0o755);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'main-base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'stack-base'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 128, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'stack-base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  const r = runIn(repo, DIFF, [], {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, GITHUB_BASE_REF: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff accepts a single base ref and uses stylemaps/current', () => {
  const repo = mkTmp();
  gitInit(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(255, 0, 0)'), null);
  const r = runIn(repo, DIFF, ['main']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /computed-style difference/);
  rmTmp(repo);
});

test('diff --base-ref uses stylemaps/current when mapsDir is omitted', () => {
  const repo = mkTmp();
  gitInit(repo);
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const r = runIn(repo, DIFF, ['--base-ref', 'HEAD']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 changed surfaces across 1 captured surface\(s\)/);
  rmTmp(repo);
});

test('diff --base-ref: a restyled working map differs from the committed base → exit 1', () => {
  const repo = mkTmp();
  gitInit(repo);
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  // Restyle in the working tree (the pre-push head) — the committed base is unchanged.
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(255, 0, 0)'), null);
  const r = runIn(repo, DIFF, ['--base-ref', 'HEAD', 'maps']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /computed-style difference/);
  rmTmp(repo);
});

test('diff --base-ref: exits 2 when the ref has no committed captures at that path', () => {
  const repo = mkTmp();
  gitInit(repo);
  fs.writeFileSync(path.join(repo, 'readme'), 'x');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(0, 0, 0)'), null); // never committed
  const r = runIn(repo, DIFF, ['--base-ref', 'HEAD', 'maps']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no committed captures/);
  assert.match(r.stderr, /Next: make sure HEAD contains committed captures at maps/);
  rmTmp(repo);
});

test('diff base-ref flow explains how to recover when the working maps are missing', () => {
  const repo = mkTmp();
  gitInit(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'readme'), 'x');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const r = runIn(repo, DIFF, ['main']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Next: run styleproof-map to create stylemaps\/current/);
  assert.match(r.stderr, /pass --maps-dir <dir>/);
  rmTmp(repo);
});

test('report --base-ref: builds a report with the base read from a git ref', () => {
  const repo = mkTmp();
  gitInit(repo);
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(255, 0, 0)'), null); // restyled head
  const out = path.join(repo, 'out');
  const r = runIn(repo, REPORT, ['--base-ref', 'HEAD', 'maps', '--out', out]);
  assert.equal(r.status, 1, r.stderr); // changes found vs the committed base
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  rmTmp(repo);
});

test('report defaults to stylemaps/current against the inferred main branch', () => {
  const repo = mkTmp();
  gitInit(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(255, 0, 0)'), null);
  const r = runIn(repo, REPORT, []);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(repo, 'styleproof-report', 'report.json')));
  rmTmp(repo);
});

test('report accepts a single base ref and uses stylemaps/current', () => {
  const repo = mkTmp();
  gitInit(repo);
  spawnSync('git', ['checkout', '-qb', 'main'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  spawnSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(255, 0, 0)'), null);
  const out = path.join(repo, 'out');
  const r = runIn(repo, REPORT, ['main', '--out', out]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /changed surface\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
  rmTmp(repo);
});

test('report --base-ref uses stylemaps/current when mapsDir is omitted', () => {
  const repo = mkTmp();
  gitInit(repo);
  writeCapture(path.join(repo, 'stylemaps/current'), 'home@1280', mapWith('rgb(0, 0, 0)'), null);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  const out = path.join(repo, 'out');
  const r = runIn(repo, REPORT, ['--base-ref', 'HEAD', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no changes/);
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  rmTmp(repo);
});

test('report --base-ref: exits 2 when the ref has no committed captures there', () => {
  const repo = mkTmp();
  gitInit(repo);
  fs.writeFileSync(path.join(repo, 'readme'), 'x');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeCapture(path.join(repo, 'maps'), 'home@1280', mapWith('rgb(0, 0, 0)'), null); // never committed
  const out = path.join(repo, 'out');
  const r = runIn(repo, REPORT, ['--base-ref', 'HEAD', 'maps', '--out', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no committed captures/);
  assert.match(r.stderr, /Next: make sure HEAD contains committed captures at maps/);
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

test('init scaffolds a playwright.config that serves a PRODUCTION build (no dev-server trap)', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const config = fs.readFileSync(path.join(dir, 'playwright.config.ts'), 'utf8');
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

test('init scaffolds the out-of-the-box gate: pre-push capture+commit hook + browser-less CI diff', () => {
  const dir = mkTmp();
  try {
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    // Pre-push hook: capture into a COMMITTED, LEAN dir, commit it, and push it
    // WITH the branch — one `git push`, never two.
    const hookPath = path.join(dir, '.githooks', 'pre-push');
    const hook = fs.readFileSync(hookPath, 'utf8');
    assert.match(hook, /styleproof-map --spec e2e\/styleproof\.spec\.ts/, 'captures through the committed-map CLI');
    assert.match(hook, /git add stylemaps/);
    assert.match(hook, /git commit/);
    assert.match(hook, /git push "\$remote" HEAD/, 'pushes the map itself — no second manual push');
    assert.match(hook, /STYLEPROOF_SKIP_CAPTURE/, 're-entry guard stops the inner push recapturing');
    assert.doesNotMatch(hook, /push.{0,15}again/i, 'never tells the dev to push again');
    assert.ok(fs.statSync(hookPath).mode & 0o100, 'hook is executable');

    // CI does NOT run a browser — it just diffs the committed maps.
    const ci = fs.readFileSync(path.join(dir, '.github', 'workflows', 'styleproof.yml'), 'utf8');
    assert.match(ci, /styleproof-diff --base-ref/, 'CI diffs against the base ref');
    assert.match(ci, /Comment StyleProof result/, 'CI posts a PR receipt for clean diffs');
    assert.match(ci, /No visual changes detected/, 'clean receipts are explicit');
    assert.match(ci, /Fail on StyleProof diff/, 'CI still fails after posting the receipt when a diff exists');
    assert.doesNotMatch(ci, /playwright test/, 'CI never captures — maps are precomputed');

    // Activation is surfaced (this temp dir isn't a git repo, so init prints the
    // manual one-liner rather than auto-activating).
    assert.match(r.stdout, /core\.hooksPath \.githooks/, 'tells the user how to activate the hook');
  } finally {
    rmTmp(dir);
  }
});

test('init in a git repo auto-activates the pre-push hook (one command, nothing else to do)', () => {
  const dir = mkTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /activated the pre-push hook/, 'reports activation');
    const hp = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(hp, '.githooks', 'core.hooksPath points at the scaffolded hooks dir');
  } finally {
    rmTmp(dir);
  }
});

test('init does not clobber an existing core.hooksPath (e.g. husky)', () => {
  const dir = mkTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir });
    const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(
      r.stdout,
      /activated the pre-push hook/,
      'does not auto-activate when hooks are already managed',
    );
    const hp = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(hp, '.husky', 'leaves the existing hooksPath untouched');
  } finally {
    rmTmp(dir);
  }
});
