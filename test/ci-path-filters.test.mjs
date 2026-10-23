import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as policy from '../scripts/ci-path-filters.mjs';

const { PATH_FILTERS_FILE, needsBrowserLanes } = policy;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const cases = [
  ['top-level prose-only', ['README.md', 'CHANGELOG.md'], true],
  ['documentation prose', ['docs/NORTH_STAR.md'], true],
  ['committed demo report', ['docs/demo/report.html'], true],
  ['documentation stylesheet', ['docs/demo/theme.css'], true],
  ['documentation script', ['docs/demo/theme.js'], true],
  ['documentation tokens', ['docs/demo/tokens.json'], true],
  ['documentation SVG', ['docs/demo/theme.svg'], true],
  ['documentation screenshot', ['docs/proof/readme-lead/readme-top.png'], true],
  ['new documentation asset extension', ['docs/new/theme.future'], true],
  ['documentation test-shaped asset', ['docs/new/theme.test.mjs'], true],
  ['documentation asset renamed to top-level prose', ['docs/demo/report.html', 'report.md'], true],
  ['top-level prose renamed to documentation', ['README.md', 'docs/new/report.html'], true],
  ['documentation asset renamed within docs', ['docs/demo/report.html', 'docs/demo/new.html'], true],
  ['changelog plus unit tests', ['CHANGELOG.md', 'test/release-notes.test.mjs', 'test/report.test.mjs'], true],
  ['agent tooling and lint config', ['.claude/skills/good-css/SKILL.md', 'AGENTS.md', 'eslint.config.js'], true],
  ['PR-body and privacy tooling', ['scripts/validate-pr-body.mjs', 'scripts/privacy-check.mjs'], true],
  ['context and suppression checks', ['scripts/check-context-layer.mjs', 'scripts/check-suppressions.mjs'], true],
  ['codex hook registration', ['.codex/hooks.json', '.claude/hooks/block-gate-bypass.sh'], true],
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
  ['path-filter file itself', ['.github/path-filters.yml'], true],
  ['mixed docs and src', ['docs/setup.md', 'src/util.ts'], true],
];

for (const [name, files, expected] of cases) {
  test(`${name} ${expected ? 'runs' : 'skips'} the browser lanes`, () => {
    assert.equal(needsBrowserLanes(files), expected);
  });
}

test('literal backslashes and line terminators never exempt a changed Git filename', () => {
  for (const file of [
    'docs\\setup.md',
    'docs\\demo\\report.html',
    'README.md',
    'src\\diff.ts',
    '.agents\\theme.css',
    '.agents\\nested\\theme.css',
    '.github\\ISSUE_TEMPLATE\\theme.css',
    ...['\n', '\r', '\u2028', '\u2029'].flatMap((term) => [`docs/theme${term}.css`, `src/${term}/theme.css`]),
  ])
    assert.equal(needsBrowserLanes([file]), true, JSON.stringify(file));
});

test('the shared filter has one documented universal positive pattern and no exemptions', () => {
  const text = read(PATH_FILTERS_FILE);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  assert.deepEqual(lines, ['lanes:', "  - '([\\s\\S]+)'"]);
  assert.match(text, /#.*line terminators/i);
});

test('a filter file that is not one fail-closed lanes filter is rejected', () => {
  assert.equal(typeof policy.validatePathFilters, 'function');
  const valid = "lanes:\n  - '([\\s\\S]+)'\n";
  for (const text of [
    '',
    '# comments only\n',
    'lanes:\n',
    "lanes:\n  - '!docs/**'\n",
    "lanes:\n  - '**'\n",
    "lanes:\n  - '**'\n  - 'src/**'\n",
    "lanes:\n  - '**'\nother:\n  - '**'\n",
    `${valid}  - '!README.md'\n`,
    `${valid}other:\n  - '**'\n`,
    `${valid}${valid}`,
    valid.replace('  -', ' -'),
    valid.replace('+', '*'),
    `${valid}# comment\r  - '!**'\n`,
    `${valid}# comment\0\n`,
    `${valid}\u00a0# comment\n`,
  ])
    assert.throws(() => policy.validatePathFilters(text), /lanes/i, JSON.stringify(text));
  assert.doesNotThrow(() => policy.validatePathFilters(`# why\n${valid}# end\n`));
  assert.doesNotThrow(() => policy.validatePathFilters(valid.replaceAll('\n', '\r\n')));
  assert.doesNotThrow(() => policy.validatePathFilters(valid.replaceAll('\n', '\r')));
});

test('only a proven empty inventory skips; malformed inventories fail closed', () => {
  assert.equal(needsBrowserLanes([]), false);
  for (const files of [null, undefined, '', {}, [''], [null], [undefined], [42], new Array(1)]) {
    assert.throws(() => needsBrowserLanes(files), /path|file|array/i);
  }
});

test('every tracked e2e spec runs browsers (Playwright collects **/*.e2e.spec.ts anywhere)', () => {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const tracked = result.stdout.split('\0');
  const specs = tracked.filter((f) => f.endsWith('.e2e.spec.ts'));
  assert.ok(specs.length > 0, 'git ls-files listed the e2e specs');
  for (const spec of specs) assert.equal(needsBrowserLanes([spec]), true, spec);
});

test('every browser-lane entry import runs browsers', () => {
  const entries = fs
    .readdirSync(path.join(root, 'test'))
    .filter((f) => f.endsWith('.e2e.spec.ts'))
    .map((f) => `test/${f}`)
    .concat('test/helpers.mjs', 'test/phase1-foundation-harness-lib.ts', 'bench/detection-rate.mjs');
  for (const entry of entries) {
    for (const [, spec] of read(entry).matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.join(path.posix.dirname(entry), spec);
      assert.equal(needsBrowserLanes([target]), true, `${entry} imports ${target}, which the path filter would skip`);
    }
  }
});

const DORNY = 'dorny/paths-filter@0e4a8c6effa4802afeda77dc8d303f8176d7dfad # v3.0.2';
const workflows = [
  ['ci.yml', 'e2e', null],
  [
    'action-dogfood.yml',
    'dogfood',
    "${{ !cancelled() && needs.changes.outputs.dogfood != 'false' && github.event.pull_request.head.repo.full_name == github.repository }}",
  ],
  [
    'store-dogfood.yml',
    'dogfood',
    "${{ !cancelled() && (github.event_name != 'pull_request' || (needs.changes.outputs.dogfood != 'false' && github.event.pull_request.head.repo.full_name == github.repository)) }}",
  ],
  [
    'styleproof-dogfood.yml',
    'dogfood',
    "${{ !cancelled() && needs.changes.outputs.dogfood != 'false' && github.event.pull_request.head.repo.full_name == github.repository }}",
  ],
  ['phase1-advisory-dogfood.yml', 'dogfood', "${{ !cancelled() && needs.changes.outputs.dogfood != 'false' }}"],
];

for (const [workflow, output, gate] of workflows) {
  test(`${workflow} filters with the shared file in one pinned dorny step`, () => {
    const yml = read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(yml, /\n {4}paths:/, `${workflow} must start on every pull_request and filter in a job`);
    assert.equal(yml.split('dorny/paths-filter@').length, 2, `${workflow} has exactly one dorny step`);
    const lines = yml.split('\n');
    const at = lines.findIndex((l) => l.endsWith(`- uses: ${DORNY}`));
    assert.ok(at > 0, `${workflow} pins ${DORNY}`);
    const indent = lines[at].indexOf('-');
    const body = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== '' && line.search(/\S/) <= indent) break;
      if (line.trim() !== '' && !line.trimStart().startsWith('#')) body.push(line.trim());
    }
    assert.deepEqual(body, [
      'id: filter',
      ...(workflow === 'ci.yml' ? ["if: github.event_name == 'pull_request'"] : []),
      'with:',
      'predicate-quantifier: every',
      `filters: ${PATH_FILTERS_FILE}`,
    ]);
    const decision =
      workflow === 'ci.yml'
        ? "github.event_name == 'push' && 'true' || steps.filter.outputs.lanes"
        : 'steps.filter.outputs.lanes';
    assert.ok(
      yml.includes(`      ${output}: \${{ ${decision} }}\n`),
      `${workflow} requires push proof or exposes the PR API verdict without coercing missing output to false`,
    );
    if (gate) assert.ok(yml.includes(`    needs: changes\n`) && yml.includes(`    if: ${gate}\n`), `${workflow} gate`);
  });
}

test('ci.yml gates every browser lane on the filter and required reads its decision', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, / {2}e2e:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, / {2}detection-corpus:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, /E2E_DECISION: \$\{\{ needs\.changes\.outputs\.e2e \}\}/);
});
