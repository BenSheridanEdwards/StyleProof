import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PNG } from 'pngjs';
import { mkTmp, rmTmp } from './helpers.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function demoFixture(t) {
  const root = mkTmp('styleproof-demo-check-');
  t.after(() => rmTmp(root));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['demo-report.mjs', 'fixture-util.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(root, 'scripts', file));
  }
  // Shared dependencies are read-only; only this fixture's copied demo is mutated.
  for (const directory of ['dist', 'node_modules']) {
    fs.symlinkSync(path.join(repoRoot, directory), path.join(root, directory), 'junction');
  }
  fs.cpSync(path.join(repoRoot, 'docs/demo'), path.join(root, 'docs/demo'), { recursive: true });
  return root;
}

function checkDemo(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/demo-report.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('demo freshness accepts the committed Markdown, HTML, and crop pixels', (t) => {
  const result = checkDemo(demoFixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs\/demo\/ is up to date/);
});

test('demo freshness rejects a CSS-only change to the committed HTML', (t) => {
  const root = demoFixture(t);
  const htmlPath = path.join(root, 'docs/demo/report.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const changed = html.replace('color: #1f2328; background: #fff;', 'color: magenta; background: black;');
  assert.notEqual(changed, html, 'the fixture must change the rendered report CSS');
  fs.writeFileSync(htmlPath, changed);
  const result = checkDemo(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /report\.html differs/);
});

test('demo freshness rejects missing committed HTML explicitly', (t) => {
  const root = demoFixture(t);
  fs.rmSync(path.join(root, 'docs/demo/report.html'));
  const result = checkDemo(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /report\.html is missing/);
});

test('demo freshness still rejects changed Markdown', (t) => {
  const root = demoFixture(t);
  fs.appendFileSync(path.join(root, 'docs/demo/report.md'), '\nUnexpected content.\n');
  const result = checkDemo(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /report\.md differs/);
});

test('demo freshness still rejects changed decoded crop pixels', (t) => {
  const root = demoFixture(t);
  const cropDir = path.join(root, 'docs/demo/crops');
  const cropPath = path.join(
    cropDir,
    fs.readdirSync(cropDir).find((file) => file.endsWith('.png')),
  );
  const png = PNG.sync.read(fs.readFileSync(cropPath));
  png.data[0] ^= 255;
  fs.writeFileSync(cropPath, PNG.sync.write(png));
  const result = checkDemo(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /pixels differ: crops\//);
});

test('demo freshness accepts re-encoded crops with identical decoded pixels', (t) => {
  const root = demoFixture(t);
  const cropDir = path.join(root, 'docs/demo/crops');
  const cropPath = path.join(
    cropDir,
    fs.readdirSync(cropDir).find((file) => file.endsWith('.png')),
  );
  const original = fs.readFileSync(cropPath);
  const reencoded = PNG.sync.write(PNG.sync.read(original), { deflateLevel: 0 });
  assert.notDeepEqual(reencoded, original, 'the PNG encoding must change without changing its pixels');
  fs.writeFileSync(cropPath, reencoded);
  const result = checkDemo(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs\/demo\/ is up to date/);
});
