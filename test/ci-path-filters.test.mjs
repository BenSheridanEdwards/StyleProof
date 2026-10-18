import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SAFE_PATHS, dornyFilterLines, isSafePath, needsBrowserLanes } from '../scripts/ci-path-filters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const cases = [
  ['docs-only', ['docs/NORTH_STAR.md', 'docs/proof/readme-lead/readme-top.png', 'README.md'], false],
  ['changelog plus unit tests', ['CHANGELOG.md', 'test/release-notes.test.mjs', 'test/report.test.mjs'], false],
  ['agent tooling and lint config', ['.claude/skills/good-css/SKILL.md', 'AGENTS.md', 'eslint.config.js'], false],
  ['PR-body and privacy tooling', ['scripts/validate-pr-body.mjs', 'scripts/privacy-check.mjs'], false],
  ['demo page CSS', ['example/demo/index.html'], true],
  ['known-truth CSS fixture', ['test/fixtures/known-truth-css/style.css'], true],
  ['detection corpus fixture', ['bench/detection-fixture.html'], true],
  ['new theme token file', ['src/theme/tokens.css'], true],
  ['capture engine', ['src/capture/browser.ts'], true],
  ['diff engine', ['src/diff.ts'], true],
  ['report renderer', ['src/report/markdown.ts'], true],
  ['CI-only src module', ['src/action-context.ts'], true],
  ['bin entry', ['bin/ci-shared.mjs'], true],
  ['ci workflow', ['.github/workflows/ci.yml'], true],
  ['approve workflow', ['.github/workflows/styleproof-approve-reusable.yml'], true],
  ['composite action', ['action.yml'], true],
  ['package-lock', ['package-lock.json'], true],
  ['package.json', ['package.json'], true],
  ['tsconfig', ['tsconfig.json'], true],
  ['playwright config', ['playwright.config.ts'], true],
  ['styleproof config', ['styleproof.config.ts'], true],
  ['e2e spec', ['test/smoke.e2e.spec.ts'], true],
  ['e2e harness library', ['test/phase1-foundation-harness-lib.ts'], true],
  ['unit test inside fixtures', ['test/fixtures/selective-remap/src/a.test.mjs'], true],
  ['markdown outside the allowlist', ['example/notes.md'], true],
  ['husky installer run by npm ci prepare', ['.husky/install.mjs'], true],
  ['unknown new top-level path', ['newdir/thing.txt'], true],
  ['unknown new script', ['scripts/new-helper.mjs'], true],
  ['path-filter classifier itself', ['scripts/ci-path-filters.mjs'], true],
  ['mixed docs and src', ['docs/setup.md', 'src/util.ts'], true],
];

for (const [name, files, expected] of cases) {
  test(`${name} ${expected ? 'runs' : 'skips'} the browser lanes`, () => {
    assert.equal(needsBrowserLanes(files), expected);
  });
}

test('Windows separators classify like POSIX paths', () => {
  assert.equal(isSafePath('docs\\setup.md'), true);
  assert.equal(needsBrowserLanes(['src\\diff.ts']), true);
});

test('every safe entry names why it cannot change a browser or dogfood outcome', () => {
  for (const { glob, why } of SAFE_PATHS) {
    assert.ok(!glob.startsWith('!') && !glob.startsWith('src/') && glob !== '**', `${glob} is not a safe-path glob`);
    assert.ok(why.length > 20, `${glob} needs a reason`);
  }
});

test('no browser-lane entry file imports a path the classifier calls safe', () => {
  const entries = fs
    .readdirSync(path.join(root, 'test'))
    .filter((f) => f.endsWith('.e2e.spec.ts'))
    .map((f) => `test/${f}`)
    .concat('test/helpers.mjs', 'test/phase1-foundation-harness-lib.ts', 'bench/detection-rate.mjs');
  for (const entry of entries) {
    for (const [, spec] of read(entry).matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.join(path.posix.dirname(entry), spec);
      assert.equal(isSafePath(target), false, `${entry} imports ${target}, which the path filter would skip`);
    }
  }
});

// Each workflow embeds the same dorny block. dorny ORs files and, with predicate-quantifier
// `every`, ANDs the patterns per file, so the output is true when any changed file is not safe.
for (const [workflow, output] of [
  ['ci.yml', 'e2e'],
  ['action-dogfood.yml', 'dogfood'],
  ['store-dogfood.yml', 'dogfood'],
  ['styleproof-dogfood.yml', 'dogfood'],
  ['phase1-advisory-dogfood.yml', 'dogfood'],
]) {
  test(`${workflow} embeds the shared fail-closed path filter`, () => {
    const yml = read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(yml, /\n {4}paths:/, `${workflow} must start on every pull_request and filter in a job`);
    const step = yml.match(
      /dorny\/paths-filter@[0-9a-f]{40} # v3\.0\.2\n(?:.*\n)*?( *)predicate-quantifier: every\n\1filters: \|\n((?:\1 {2}.*\n)+)/,
    );
    assert.ok(step, `${workflow} pins dorny/paths-filter by SHA with predicate-quantifier every`);
    assert.deepEqual(
      step[2]
        .trimEnd()
        .split('\n')
        .map((l) => l.slice(step[1].length + 2)),
      dornyFilterLines(output),
      `${workflow} filter drifted; paste dornyFilterLines('${output}') from scripts/ci-path-filters.mjs`,
    );
  });
}

for (const [workflow, job] of [
  ['action-dogfood.yml', 'action-dogfood'],
  ['store-dogfood.yml', 'round-trip'],
  ['styleproof-dogfood.yml', 'styleproof-dogfood'],
  ['phase1-advisory-dogfood.yml', 'phase1-mapping'],
]) {
  test(`${workflow}: ${job} waits for the filter and runs unless it said false`, () => {
    const yml = read(`.github/workflows/${workflow}`);
    const gated = new RegExp(
      ` {2}${job}:\\n(?: {4}.+\\n)* {4}needs: changes\\n {4}if: .*!cancelled\\(\\).*needs\\.changes\\.outputs\\.dogfood != 'false'`,
    );
    assert.match(yml, gated);
  });
}

test('ci.yml gates every browser lane on the filter and required reads its decision', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /outputs:\n(?: {6}.+\n)* {6}e2e: \$\{\{ steps\.filter\.outputs\.e2e \}\}/);
  assert.match(ci, / {2}e2e:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, / {2}detection-corpus:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, /E2E_DECISION: \$\{\{ needs\.changes\.outputs\.e2e \}\}/);
});
