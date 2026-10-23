import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentFixture, createFixture, fileChangeCase, runHosted } from './helpers/browser-lanes-fixtures.mjs';
import { productChange, requiredStep, runRequired, sameTreeChange } from './helpers/ci-required.mjs';

// Execute the real required step with its own env wiring. H fixtures in
// browser-lanes.test.mjs feed actual CLI outputs into this same Bash harness.
const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const step = requiredStep();
const browserLanes = ['e2e', 'e2e-evidence', 'detection-corpus'];
const badResults = ['skipped', 'cancelled', 'failure', ''];

test('the required step reads the tree decision, proof and every needed job result', () => {
  assert.equal(step.env.E2E_DECISION, 'needs.changes.outputs.e2e');
  assert.equal(step.env.E2E_PROOF, 'needs.changes.outputs.e2e_proof');
  assert.equal(step.env.CHANGES_RESULT, 'needs.changes.result');
  const needs = ci.match(/\n {2}required:\n(?: {4}.+\n)*? {4}needs: \[([^\]]+)\]/)?.[1].split(', ');
  assert.deepEqual(needs, ['changes', 'build', 'e2e', 'e2e-evidence', 'cli-smoke', 'detection-corpus']);
  for (const job of needs.filter((name) => name !== 'changes')) {
    assert.ok(Object.values(step.env).includes(`needs.${job}.result`), `required reads needs.${job}.result`);
  }
});

test('product change with complete browser proof passes', () => {
  const { passed, output } = runRequired(productChange());
  assert.ok(passed, output);
  assert.match(output, /browser paths changed; e2e shards, evidence and detection corpus must succeed/);
});

test('proven identical trees with planned browser skips pass', () => {
  const { passed, output } = runRequired(sameTreeChange());
  assert.ok(passed, output);
  assert.match(output, /no browser paths changed; browser lanes may skip/);
});

test('product change rejects all browser lanes skipped', () => {
  const skipped = { result: 'skipped' };
  const { passed, output } = runRequired(
    productChange({ e2e: skipped, 'e2e-evidence': skipped, 'detection-corpus': skipped }),
  );
  assert.equal(passed, false, output);
  assert.match(output, /E2E_RESULT was 'skipped' \(want success\)/);
});

for (const lane of browserLanes) {
  for (const result of badResults) {
    test(`product change rejects ${lane} = '${result}' (mixed lane results)`, () => {
      const { passed, output } = runRequired(productChange({ [lane]: { result } }));
      assert.equal(passed, false, output);
      assert.match(output, new RegExp(`was '${result}' \\(want success\\)`));
    });
  }
  for (const result of ['cancelled', 'failure', '']) {
    test(`a same-tree proof still rejects ${lane} = '${result}'`, () => {
      const { passed, output } = runRequired(sameTreeChange({ [lane]: { result } }));
      assert.equal(passed, false, output);
      assert.match(output, new RegExp(`was '${result}' \\(want success or skipped\\)`));
    });
  }
}

for (const result of ['failure', 'cancelled', 'skipped']) {
  test(`a path filter that ended '${result}' is not trusted, even if it said false`, () => {
    const { passed, output } = runRequired(
      sameTreeChange({ changes: { result, outputs: { e2e: 'false', e2e_proof: `same-tree:${'a'.repeat(40)}` } } }),
    );
    assert.equal(passed, false, output);
    assert.match(output, /CHANGES_RESULT was/);
    assert.match(output, /untrusted \(path filter did not succeed\)/);
  });
}

for (const [label, changes] of [
  ['missing outputs', { result: 'success' }],
  ['missing e2e output', { result: 'success', outputs: {} }],
  ['empty e2e output', { result: 'success', outputs: { e2e: '' } }],
  ['malformed e2e output TRUE', { result: 'success', outputs: { e2e: 'TRUE' } }],
  ['malformed e2e output malformed', { result: 'success', outputs: { e2e: 'malformed' } }],
  ['malformed e2e output False', { result: 'success', outputs: { e2e: 'False' } }],
  ['malformed e2e output "false "', { result: 'success', outputs: { e2e: 'false ' } }],
  ['malformed e2e output 0', { result: 'success', outputs: { e2e: '0' } }],
]) {
  test(`${label}: fails closed with skipped browser lanes`, () => {
    const { passed, output } = runRequired(sameTreeChange({ changes }));
    assert.equal(passed, false, output);
    assert.match(output, /want true or false/);
  });
  test(`${label}: fails closed even when browser lanes succeeded`, () => {
    const { passed, output } = runRequired(productChange({ changes }));
    assert.equal(passed, false, output);
    assert.match(output, /want true or false/);
  });
}

for (const job of ['build', 'cli-smoke']) {
  for (const result of badResults) {
    for (const [kind, change] of [
      ['product', productChange],
      ['same-tree', sameTreeChange],
    ]) {
      test(`${kind} change still requires ${job} (node matrix / platform smoke) to succeed, rejecting '${result}'`, () => {
        const { passed, output } = runRequired(change({ [job]: { result } }));
        assert.equal(passed, false, output);
        assert.match(output, /was '.*' \(want success\)/);
      });
    }
  }
}

for (const [label, proof] of [
  ['missing', undefined],
  ['empty', ''],
  ['empty tree', 'same-tree:'],
  ['nonhex tree', 'same-tree:xyz'],
  ['run reason', 'run:tree-differs'],
  ['trailing text', `same-tree:${'a'.repeat(40)} extra`],
  ['uppercase tree', `same-tree:${'A'.repeat(40)}`],
  ['short tree', `same-tree:${'a'.repeat(39)}`],
  ['long SHA-1 tree', `same-tree:${'a'.repeat(41)}`],
  ['short SHA-256 tree', `same-tree:${'a'.repeat(63)}`],
  ['long SHA-256 tree', `same-tree:${'a'.repeat(65)}`],
  ['leading newline', `\nsame-tree:${'a'.repeat(40)}`],
  ['trailing newline', `same-tree:${'a'.repeat(40)}\n`],
]) {
  for (const [kind, fixture] of [
    ['skipped', sameTreeChange],
    ['successful', productChange],
  ]) {
    test(`false with ${label} proof rejects ${kind} browser lanes`, () => {
      const outputs = { e2e: 'false', ...(proof === undefined ? {} : { e2e_proof: proof }) };
      const { passed, output } = runRequired(fixture({ changes: { result: 'success', outputs } }));
      assert.equal(passed, false, output);
      assert.match(output, /Path decision 'false' without same-tree proof/);
    });
  }
}

for (const length of [40, 64]) {
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    test(`same-tree:${length}hex with changes ${JSON.stringify(result)} ${result === 'success' ? 'accepts' : 'rejects'} skipped lanes`, () => {
      const { passed, output } = runRequired(
        sameTreeChange({
          changes: { result, outputs: { e2e: 'false', e2e_proof: `same-tree:${'b'.repeat(length)}` } },
        }),
      );
      assert.equal(passed, result === 'success', output);
      if (result !== 'success') assert.match(output, /CHANGES_RESULT was/);
    });
  }
}

for (const proof of ['', 'run:tree-differs', 'malformed', `same-tree:${'a'.repeat(40)}`]) {
  for (const [kind, fixture, expected] of [
    ['skipped', sameTreeChange, false],
    ['successful', productChange, true],
  ]) {
    test(`true with ${JSON.stringify(proof)} proof ${expected ? 'accepts' : 'rejects'} ${kind} browser lanes`, () => {
      const { passed, output } = runRequired(
        fixture({ changes: { result: 'success', outputs: { e2e: 'true', e2e_proof: proof } } }),
      );
      assert.equal(passed, expected, output);
      if (!expected) assert.match(output, /E2E_RESULT was 'skipped' \(want success\)/);
    });
  }
}

const workflowNames = [
  'ci.yml',
  'action-dogfood.yml',
  'store-dogfood.yml',
  'styleproof-dogfood.yml',
  'phase1-advisory-dogfood.yml',
];
const expectedSteps = [
  '    steps:',
  '      - uses: actions/checkout@v7',
  '        with:',
  '          fetch-depth: 2',
  '      - id: decide',
  '        run: node scripts/browser-lanes.mjs --github',
].join('\n');

for (const name of workflowNames) {
  test(`${name}: changes checks out two commits and runs the shared tree decider without dependencies`, () => {
    const source = fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    const changes = source.match(/^ {2}changes:\n[\s\S]*?(?=\n {2}[\w-]+:)/m)?.[0];
    assert.ok(changes, `${name} has a changes job`);
    assert.doesNotMatch(source, /\n {4}paths:/, `${name} starts on every pull_request`);
    assert.equal(changes.split('run: node scripts/browser-lanes.mjs --github').length, 2);
    if (name !== 'ci.yml') {
      const sameRepository = 'github.event.pull_request.head.repo.full_name == github.repository';
      const gate =
        name === 'store-dogfood.yml'
          ? `\${{ !cancelled() && (github.event_name != 'pull_request' || (needs.changes.outputs.dogfood != 'false' && ${sameRepository})) }}`
          : name === 'phase1-advisory-dogfood.yml'
            ? "${{ !cancelled() && needs.changes.outputs.dogfood != 'false' }}"
            : `\${{ !cancelled() && needs.changes.outputs.dogfood != 'false' && ${sameRepository} }}`;
      assert.ok(source.includes('    needs: changes\n') && source.includes(`    if: ${gate}\n`), `${name} gate`);
    }
    assert.equal(changes.slice(changes.indexOf('    steps:')).trimEnd(), expectedSteps);
    const outputs = changes.match(/^ {4}outputs:\n([\s\S]*?)(?=^ {4}steps:)/m)?.[1];
    if (name === 'ci.yml') {
      assert.equal(
        outputs,
        '      e2e: ${{ steps.decide.outputs.lanes }}\n      e2e_proof: ${{ steps.decide.outputs.proof }}\n',
      );
    } else if (name === 'styleproof-dogfood.yml') {
      assert.equal(
        outputs,
        "      # This lane captures PR head and base, so equal merge/base trees cannot prove it redundant.\n      dogfood: 'true'\n",
      );
    } else {
      assert.equal(outputs, '      dogfood: ${{ steps.decide.outputs.lanes }}\n');
    }
  });
}

test('workflow decisions have no path-filter action or policy file', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const name of fs.readdirSync(directory)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const source = fs.readFileSync(new URL(name, directory), 'utf8');
    assert.doesNotMatch(source, /dorny\/paths-filter|path-filters\.yml/, name);
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.equal(fs.existsSync(path.join(root, '.github', 'path-filters.yml')), false);
});

test('ci.yml gates every browser lane on the tree decision and required reads its proof', () => {
  assert.match(ci, / {2}e2e:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, / {2}detection-corpus:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, /E2E_DECISION: \$\{\{ needs\.changes\.outputs\.e2e \}\}/);
  assert.match(ci, /E2E_PROOF: \$\{\{ needs\.changes\.outputs\.e2e_proof \}\}/);
});

test('live dogfood runs when an equal merge tree hides a different PR head tree', (t) => {
  const fixture = createFixture(t);
  const { directory, git } = fixture;
  git(['checkout', '-qb', 'base']);
  fs.writeFileSync(path.join(directory, 'color.css'), 'body { color: black; }\n');
  fs.writeFileSync(path.join(directory, 'layout.css'), 'body { padding: 0; }\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial fixture']);
  git(['checkout', '-qb', 'feature']);
  fs.writeFileSync(path.join(directory, 'color.css'), 'body { color: magenta; }\n');
  git(['add', '.']);
  git(['commit', '-qm', 'feature color']);
  fixture.head = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'base']);
  fs.writeFileSync(path.join(directory, 'color.css'), 'body { color: magenta; }\n');
  fs.writeFileSync(path.join(directory, 'layout.css'), 'body { padding: 8px; }\n');
  git(['add', '.']);
  git(['commit', '-qm', 'independently apply color and change layout']);
  fixture.base = git(['rev-parse', 'HEAD']);
  git(['merge', '--no-ff', '-m', 'merge feature', 'feature']);
  fixture.merge = git(['rev-parse', 'HEAD']);
  const baseTree = git(['rev-parse', `${fixture.base}^{tree}`]);
  assert.equal(git(['rev-parse', `${fixture.merge}^{tree}`]), baseTree);
  assert.notEqual(git(['rev-parse', `${fixture.head}^{tree}`]), baseTree);
  assert.deepEqual(
    git(['cat-file', 'commit', fixture.merge])
      .split('\n\n')[0]
      .split('\n')
      .filter((line) => line.startsWith('parent ')),
    [`parent ${fixture.base}`, `parent ${fixture.head}`],
  );
  const hosted = runHosted(fixture);
  assert.equal(hosted.status, 0, hosted.stderr);
  assert.deepEqual(hosted.decision, { lanes: false, proof: `same-tree:${baseTree}` });
  assert.deepEqual(hosted.output, { lanes: 'false', proof: `same-tree:${baseTree}` });
  const required = runRequired(
    sameTreeChange({
      changes: { result: 'success', outputs: { e2e: hosted.output.lanes, e2e_proof: hosted.output.proof } },
    }),
  );
  assert.equal(required.passed, true, required.output);
  const source = fs.readFileSync(new URL('../.github/workflows/styleproof-dogfood.yml', import.meta.url), 'utf8');
  const liveDecision = source.match(/^ {6}dogfood: '([^']+)'$/m)?.[1];
  assert.equal(liveDecision, 'true', 'the PR-head lane cannot borrow a merge-tree proof');
  assert.notEqual(liveDecision, 'false', 'the unchanged dogfood condition selects this lane');
  assert.match(source, /Capture declared surfaces at the PR head/);
  assert.match(source, /Capture declared surfaces at the PR base/);
});

test('docs/proof/new/report.png: the real tree decision makes required reject skipped browser proof', (t) => {
  const fixture = createContentFixture(t, fileChangeCase('legacy-required-proof', 'docs/proof/new/report.png'));
  const hosted = runHosted(fixture);
  assert.equal(hosted.status, 0, hosted.stderr);
  assert.deepEqual(hosted.output, { lanes: 'true', proof: 'run:tree-differs' });
  const required = runRequired(
    sameTreeChange({
      changes: { result: 'success', outputs: { e2e: hosted.output.lanes, e2e_proof: hosted.output.proof } },
    }),
  );
  assert.equal(required.passed, false, required.output);
  assert.match(required.output, /E2E_RESULT was 'skipped' \(want success\)/);
});
