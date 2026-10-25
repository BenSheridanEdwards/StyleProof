import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserLanesRequired, decideGithub, makeGit, parentsOf, treeOf } from '../scripts/browser-lanes.mjs';
import {
  contentCases,
  createContentFixture,
  createFixture,
  fileChangeCase,
  runHosted,
} from './helpers/browser-lanes-fixtures.mjs';
import { runRequired, sameTreeChange } from './helpers/ci-required.mjs';
import { assertHosted } from './helpers/hosted-browser-lanes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tree = 'a'.repeat(40);
const same = { kind: 'same-tree', tree };
const deleted = { kind: 'deleted' };

for (const [name, proofs, expected] of [
  ['empty', [], true],
  ['null', null, true],
  ['undefined', undefined, true],
  ['object', {}, true],
  ['unknown', [{ kind: 'unknown' }], true],
  ['differs', [{ kind: 'differs' }], true],
  ['same tree', [same], false],
  ['deleted', [deleted], false],
  ['same and deleted', [same, deleted], false],
  ['same and unknown', [same, { kind: 'unknown' }], true],
  ['deleted and differs', [deleted, { kind: 'differs' }], true],
  ['missing tree', [{ kind: 'same-tree' }], true],
  ['short tree', [{ kind: 'same-tree', tree: 'abc' }], true],
  ['sparse proofs', new Array(1), true],
  ['null proof', [null], true],
  ['SHA256 tree', [{ kind: 'same-tree', tree: 'b'.repeat(64) }], false],
])
  test(`pure browserLanesRequired: ${name}`, () => assert.equal(browserLanesRequired(proofs), expected));

test('literal backslashes and line terminators never exempt a changed Git filename', (t) => {
  for (const name of ['docs\\setup.md', 'src\\diff.ts', '.agents\\nested\\theme.css'])
    assertHosted(createContentFixture(t, fileChangeCase('literal', name)));
  assert.ok(contentCases.filter((row) => row.id.startsWith('C2-')).length >= 39);
  assert.equal(contentCases.filter((row) => row.id.startsWith('C3-')).length, 3);
});

test('the shared decider uses only Node builtins and never enumerates paths', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/browser-lanes.mjs'), 'utf8');
  for (const [, module] of source.matchAll(/from ['"]([^'"]+)['"]/g)) assert.ok(module.startsWith('node:'), module);
  assert.doesNotMatch(source, /['"](?:diff|ls-files)['"]/);
  assert.doesNotMatch(source, /ci-path-filters|path-filters\.yml|picomatch/);
});

const identityRepositories = new Map();

function identityFixture(t, { format, reverted = false } = {}) {
  const fixture = createFixture(t, { format });
  const key = JSON.stringify([format ?? 'sha1', Boolean(reverted)]);
  const prepared = identityRepositories.get(key);
  if (prepared) {
    // Copy only pre-merge setup. Every fixture owns its objects, refs and index.
    fs.cpSync(prepared.directory, fixture.directory, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fixture.base = prepared.base;
    fixture.head = prepared.head;
  } else {
    fixture.setEntry('theme.css', '100644', 'body { color: black; }');
    fixture.base = fixture.commit([], 'base');
    if (reverted) {
      fixture.setEntry('theme.css', '100644', 'body { color: magenta; }');
      const changed = fixture.commit([fixture.base], 'change');
      fixture.git(['read-tree', fixture.base]);
      fixture.head = fixture.commit([changed], 'revert change');
    } else fixture.head = fixture.commit([fixture.base], 'empty PR');
    fixture.git(['read-tree', fixture.base]);
    fixture.git(['checkout', '-q', '-B', 'main', fixture.base]);
    const template = createFixture({ after: (cleanup) => process.once('exit', cleanup) }, { format });
    fs.cpSync(fixture.directory, template.directory, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    identityRepositories.set(key, { directory: template.directory, base: fixture.base, head: fixture.head });
  }
  fixture.git(['merge', '--no-ff', '-m', 'merge identical tree', fixture.head]);
  fixture.merge = fixture.git(['rev-parse', 'HEAD']);
  return fixture;
}

for (const variant of [{}, { reverted: true }, { format: 'sha256' }]) {
  test(`H M1: identical merge tree carries positive proof ${JSON.stringify(variant)}`, (t) => {
    const fixture = identityFixture(t, variant);
    const result = assertHosted(fixture, false);
    assert.equal(result.output.proof, `same-tree:${fixture.git(['rev-parse', `${fixture.base}^{tree}`])}`);
  });
}

for (const eventName of ['push', 'workflow_dispatch', 'unrecognized_event', '', undefined, 'push\nlanes=false']) {
  test(`H M2: event ${JSON.stringify(eventName)} runs without Git or event payload`, (t) => {
    const decision = decideGithub({ eventName, git: () => assert.fail('non-PR event must not consult Git') });
    assert.equal(decision.lanes, true);
    assert.match(decision.proof, /^run:event-[a-z_]+$/);
    const fixture = identityFixture(t);
    const result = runHosted(fixture, {
      eventName: eventName ?? 'unknown',
      rawEvent: '{',
      env: { GIT_DIR: '/does-not-exist' },
    });
    assert.equal(result.status, 0);
    assert.equal(result.output.lanes, 'true');
  });
}

for (const shape of ['checkout-mismatch', 'one-parent', 'three-parents', 'wrong-base-parent']) {
  test(`H M3: ${shape} requires browsers`, (t) => {
    const fixture = identityFixture(t);
    const options = {};
    if (shape === 'checkout-mismatch') options.sha = fixture.head;
    if (shape === 'one-parent') fixture.merge = fixture.commit([fixture.base], 'one parent');
    if (shape === 'three-parents') {
      const other = fixture.commit([fixture.base], 'third parent');
      fixture.merge = fixture.commit([fixture.base, fixture.head, other], 'three parents');
    }
    if (shape === 'wrong-base-parent') fixture.merge = fixture.commit([fixture.head, fixture.base], 'reverse parents');
    fixture.git(['update-ref', 'refs/heads/main', fixture.merge]);
    assertHosted(fixture, true, options);
  });
}

for (const base of [undefined, null, '', 'a'.repeat(7), {}, [], 42]) {
  test(`H M4: missing or invalid base ${JSON.stringify(base)} requires browsers`, (t) => {
    const fixture = identityFixture(t);
    assertHosted(fixture, true, { event: { pull_request: { base: { sha: base } } } });
  });
}

test('H M4: fetch-depth 1 with a missing parent requires browsers', (t) => {
  const fixture = identityFixture(t);
  const clone = path.join(fixture.workspace, 'shallow');
  const result = spawnSync('git', ['clone', '--depth=1', pathToFileURL(fixture.directory).href, clone], {
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  fixture.directory = clone;
  const absent = spawnSync('git', ['cat-file', '-e', fixture.base], { cwd: clone, env: fixture.env });
  assert.notEqual(absent.status, 0);
  assertHosted(fixture);
});

for (const failure of ['malformed-json', 'missing-event-file']) {
  test(`H M4: ${failure} CLI emits run decision`, (t) => {
    const fixture = identityFixture(t);
    const result = runHosted(
      fixture,
      failure === 'malformed-json' ? { rawEvent: '{' } : { eventPath: path.join(fixture.workspace, 'missing.json') },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.output, { lanes: 'true', proof: 'run:event-error' });
    assert.equal(
      runRequired(
        sameTreeChange({
          changes: { result: 'success', outputs: { e2e: result.output.lanes, e2e_proof: result.output.proof } },
        }),
      ).passed,
      false,
    );
  });
}

for (const mutation of ['commit-replacement', 'tree-replacement', 'grafts']) {
  test(`H M5: ${mutation} cannot disguise changed raw content`, (t) => {
    const fixture = createContentFixture(t, contentCases[0]);
    if (mutation === 'commit-replacement') fixture.git(['replace', fixture.merge, fixture.base]);
    if (mutation === 'tree-replacement') fixture.git(['replace', fixture.headTree, fixture.baseTree]);
    if (mutation === 'grafts')
      fs.writeFileSync(
        path.join(fixture.directory, '.git/info/grafts'),
        `${fixture.merge} ${fixture.head} ${fixture.base}\n`,
      );
    assertHosted(fixture);
    assert.deepEqual(parentsOf(makeGit(fixture.directory), fixture.merge), [fixture.base, fixture.head]);
  });
}

for (const variable of [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_SHALLOW_FILE',
]) {
  test(`H M6: inherited ${variable} cannot redirect raw object reads`, (t) => {
    const fixture = createContentFixture(t, contentCases[0]);
    const clean = identityFixture(t);
    const value =
      variable === 'GIT_INDEX_FILE'
        ? path.join(clean.directory, '.git/index')
        : variable === 'GIT_WORK_TREE'
          ? clean.directory
          : variable === 'GIT_OBJECT_DIRECTORY'
            ? path.join(clean.directory, '.git/objects')
            : variable === 'GIT_SHALLOW_FILE'
              ? path.join(clean.workspace, 'absent-shallow')
              : path.join(clean.directory, '.git');
    const result = runHosted(fixture, { env: { [variable]: value } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.output, { lanes: 'true', proof: 'run:tree-differs' });
    const original = process.env[variable];
    try {
      process.env[variable] = value;
      assert.equal(treeOf(makeGit(fixture.directory), fixture.merge), fixture.headTree);
      assert.deepEqual(parentsOf(makeGit(fixture.directory), fixture.merge), [fixture.base, fixture.head]);
    } finally {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    }
  });
}

test('raw object helpers reject malformed Git output and untrusted commit identifiers', () => {
  for (const stdout of ['', 'abc', `${tree}\n${tree}`, `fatal: ${tree}`])
    assert.throws(() => treeOf(() => ({ ok: true, stdout }), 'HEAD'));
  assert.throws(() => treeOf(() => ({ ok: false, stdout: tree }), 'HEAD'));
  assert.throws(() => parentsOf(() => assert.fail('invalid identifier must not invoke Git'), '--help'));
  assert.throws(() => parentsOf(() => ({ ok: true, stdout: `tree ${tree}\nparent abc\n\nmessage` }), tree));
  assert.deepEqual(
    parentsOf(() => ({ ok: true, stdout: `tree ${tree}\n\nparent ${tree}\n` }), tree),
    [],
  );
  assert.equal(
    decideGithub({
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: tree } } },
      git: () => {
        throw new Error('unexpected');
      },
    }).lanes,
    true,
  );
});

test('Git environment discovery failure cannot become an identity proof', (t) => {
  const fixture = identityFixture(t);
  const git = makeGit(path.join(fixture.workspace, 'missing-directory'));
  assert.equal(git(['rev-parse', 'HEAD']).ok, false);
  assert.equal(
    decideGithub({
      eventName: 'pull_request',
      sha: fixture.merge,
      event: { pull_request: { base: { sha: fixture.base } } },
      git,
    }).lanes,
    true,
  );
});

test('unwritable GITHUB_OUTPUT fails the hosted job instead of producing a skip', (t) => {
  const fixture = identityFixture(t);
  const result = runHosted(fixture, { outputPath: fixture.directory });
  assert.notEqual(result.status, 0);
  assert.equal(result.output.lanes, undefined);
});

test('H M4: a missing tree object in a partial repository cannot authorize a skip', (t) => {
  const fixture = identityFixture(t);
  const oid = fixture.git(['rev-parse', `${fixture.base}^{tree}`]);
  fs.unlinkSync(path.join(fixture.directory, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  assertHosted(fixture);
});

test('H M4: unborn HEAD cannot authorize a skip', (t) => {
  const fixture = identityFixture(t);
  fixture.git(['symbolic-ref', 'HEAD', 'refs/heads/unborn']);
  assertHosted(fixture);
});

test('malformed hosted decision arguments never throw or authorize a skip', () => {
  for (const options of [
    null,
    undefined,
    42,
    '',
    [],
    {
      get eventName() {
        throw new Error('metadata failure');
      },
    },
  ]) {
    assert.equal(decideGithub(options).lanes, true);
  }
});

test('identity fixture templates keep objects, refs, config and index independent', (t) => {
  const first = identityFixture(t);
  const existing = identityFixture(t);
  const tree = first.git(['rev-parse', `${first.base}^{tree}`]);
  first.setEntry('private.css', '100644', 'body { color: purple; }');
  first.git(['config', 'fixture.private', 'changed']);
  first.git(['update-ref', 'refs/heads/private-fixture', first.head]);
  const object = path.join(first.directory, '.git/objects', tree.slice(0, 2), tree.slice(2));
  fs.chmodSync(object, 0o644);
  fs.writeFileSync(object, 'corrupt only this fixture object\n');
  assert.throws(() => first.git(['cat-file', '-p', tree]), /git cat-file/);
  const fresh = identityFixture(t);
  for (const fixture of [existing, fresh]) {
    assert.equal(fixture.git(['cat-file', '-t', tree]), 'tree');
    assert.equal(fixture.git(['write-tree']), tree);
    assert.doesNotMatch(fixture.git(['config', '--list']), /fixture\.private/);
    assert.equal(fixture.git(['for-each-ref', '--format=%(refname)', 'refs/heads/private-fixture']), '');
    assert.deepEqual(parentsOf(makeGit(fixture.directory), fixture.merge), [fixture.base, fixture.head]);
  }
});
