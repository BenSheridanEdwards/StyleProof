import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AncestorBaselineError,
  DEFAULT_ANCESTOR_WALK_LIMIT,
  captureRelevantChangedPaths,
  changedPathsBetween,
  listFirstParentAncestors,
  planAncestorBaselineReuse,
  repoRelativePath,
} from '../dist/ancestor-baseline.js';
import {
  BASELINE_PROVENANCE_FILE,
  MAP_MANIFEST,
  isMapFile,
  listMapStoreBundleShas,
  readBaselineProvenance,
  writeBaselineProvenance,
} from '../dist/map-store.js';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, tmpDirs, writeCapture } from './helpers.mjs';

// ── Nearest-ancestor baseline reuse (#367, conservative variant) ────────────────
// The reuse rule must be wrong only in the safe direction: reuse fires ONLY when
// no path changed since the stored ancestor is capture-relevant, and every error
// or doubt yields a full-capture verdict — never a throw, never a broken baseline.

/** A scratch git repo with a `commit(files, message) → sha` helper. */
function gitFixtureRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'styleproof@example.test');
  git('config', 'user.name', 'StyleProof Test');
  const commit = (files, message) => {
    for (const [file, contents] of Object.entries(files)) {
      const full = path.join(repo, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return { repo, commit };
}

test('captureRelevantChangedPaths: capture harness, configs, and package manifests are always relevant', () => {
  const relevant = captureRelevantChangedPaths({
    changedPaths: [
      'e2e/styleproof.spec.ts',
      'e2e/fixtures/login-state.ts',
      'playwright.styleproof.config.ts',
      'playwright.config.mjs',
      'styleproof.config.json',
      'packages/widgets/styleproof.config.json',
      'package-lock.json',
      'packages/widgets/package.json',
      'docs/notes.md',
      '.github/workflows/deploy.yml',
    ],
    spec: 'e2e/styleproof.spec.ts',
    sourceRoots: ['src'],
  });
  assert.deepEqual(relevant, [
    'e2e/styleproof.spec.ts',
    'e2e/fixtures/login-state.ts',
    'playwright.styleproof.config.ts',
    'playwright.config.mjs',
    'styleproof.config.json',
    'packages/widgets/styleproof.config.json',
    'package-lock.json',
    'packages/widgets/package.json',
  ]);
});

test('captureRelevantChangedPaths: declared source roots gate app changes; spellings cannot dodge the gate', () => {
  const relevant = captureRelevantChangedPaths({
    changedPaths: ['./src/pages/Home.tsx', 'styles//tokens.css', 'README.md'],
    spec: 'e2e/styleproof.spec.ts',
    sourceRoots: ['src', './styles'],
  });
  assert.deepEqual(relevant, ['./src/pages/Home.tsx', 'styles//tokens.css']);
});

test("repoRelativePath: a subdirectory consumer's spec and roots compare against repo-root git paths", () => {
  const repo = path.resolve('/repo');
  const web = path.join(repo, 'packages', 'web');
  assert.equal(repoRelativePath(repo, web, 'src'), 'packages/web/src');
  assert.equal(repoRelativePath(repo, web, 'e2e/styleproof.spec.ts'), 'packages/web/e2e/styleproof.spec.ts');
  assert.equal(repoRelativePath(repo, web, path.join(repo, 'e2e', 'styleproof.spec.ts')), 'e2e/styleproof.spec.ts');
  assert.equal(repoRelativePath(repo, repo, 'src'), 'src', 'a root consumer is unchanged');
  assert.equal(repoRelativePath(repo, web, '../..'), '', 'the repository root itself bounds nothing');
  assert.equal(repoRelativePath(repo, web, '../../..'), '', 'outside the repository bounds nothing');
  // The re-anchored paths now gate a subdirectory app change that git names from the root.
  assert.deepEqual(
    captureRelevantChangedPaths({
      changedPaths: ['packages/web/src/app.css', 'packages/web/e2e/fixtures.ts', 'docs/notes.md'],
      spec: repoRelativePath(repo, web, 'e2e/styleproof.spec.ts'),
      sourceRoots: [repoRelativePath(repo, web, 'src')],
    }),
    ['packages/web/src/app.css', 'packages/web/e2e/fixtures.ts'],
  );
});

test('captureRelevantChangedPaths: NO declared roots fails closed — every changed path is relevant', () => {
  const changedPaths = ['docs/notes.md', 'README.md'];
  assert.deepEqual(
    captureRelevantChangedPaths({ changedPaths, spec: 'e2e/styleproof.spec.ts', sourceRoots: [] }),
    changedPaths,
    'opting in without declaring app source roots must never widen reuse',
  );
  assert.deepEqual(
    captureRelevantChangedPaths({ changedPaths, spec: 'e2e/styleproof.spec.ts', sourceRoots: ['.'] }),
    changedPaths,
    'a root meaning "the whole repo" bounds nothing and fails closed too',
  );
});

test('listFirstParentAncestors: nearest first, excludes the commit itself, honors the bound', () => {
  const root = mkTmp('styleproof-ancestor-walk-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    const first = commit({ 'src/app.css': 'a{}' }, 'test: first');
    const second = commit({ 'docs/notes.md': 'one' }, 'test: second');
    const third = commit({ 'docs/notes.md': 'two' }, 'test: third');
    assert.deepEqual(listFirstParentAncestors({ sha: third, cwd: repo }), [second, first]);
    assert.deepEqual(listFirstParentAncestors({ sha: third, cwd: repo, limit: 1 }), [second]);
    assert.equal(DEFAULT_ANCESTOR_WALK_LIMIT, 50);
    assert.throws(
      () => listFirstParentAncestors({ sha: 'f'.repeat(40), cwd: repo }),
      AncestorBaselineError,
      'an unresolvable SHA is a loud walk error, for the planner to absorb',
    );
  } finally {
    rmTmp(root);
  }
});

test('planAncestorBaselineReuse: reuses the nearest stored ancestor when only irrelevant paths changed', () => {
  const root = mkTmp('styleproof-ancestor-reuse-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    const stored = commit({ 'src/app.css': 'a{}', 'e2e/styleproof.spec.ts': '// spec' }, 'test: stored ancestor');
    commit({ 'docs/notes.md': 'one' }, 'test: docs one');
    const base = commit({ 'docs/notes.md': 'two', 'README.md': 'readme' }, 'test: docs two');
    const plan = planAncestorBaselineReuse({
      requestedSha: base,
      availableShas: new Set([stored]),
      spec: 'e2e/styleproof.spec.ts',
      sourceRoots: ['src'],
      cwd: repo,
    });
    assert.deepEqual(plan, { decision: 'reuse', ancestorSha: stored, ancestorDepth: 2, changedPathCount: 2 });
  } finally {
    rmTmp(root);
  }
});

test('planAncestorBaselineReuse: a capture-relevant change since the stored ancestor forces a full capture', () => {
  const root = mkTmp('styleproof-ancestor-relevant-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    const stored = commit({ 'src/app.css': 'a{}', 'e2e/styleproof.spec.ts': '// spec' }, 'test: stored ancestor');
    const base = commit({ 'src/app.css': 'a{color:red}', 'docs/notes.md': 'one' }, 'test: app change');
    const plan = planAncestorBaselineReuse({
      requestedSha: base,
      availableShas: new Set([stored]),
      spec: 'e2e/styleproof.spec.ts',
      sourceRoots: ['src'],
      cwd: repo,
    });
    assert.equal(plan.decision, 'capture');
    assert.equal(plan.reasonCode, 'ancestor_relevant_changes');
    assert.match(plan.reason, /1 of 2 path\(s\)/);
    assert.match(plan.reason, /src\/app\.css/);
  } finally {
    rmTmp(root);
  }
});

for (const extension of ['ts', 'mjs', 'js', 'json']) {
  for (const directory of ['', 'packages/widgets/']) {
    const config = `${directory}styleproof.config.${extension}`;
    test(`planAncestorBaselineReuse: changing ${config} outside source roots forces capture`, () => {
      const root = mkTmp('styleproof-ancestor-config-');
      try {
        const { repo, commit } = gitFixtureRepo(root);
        const initialConfig = { coverage: { strict: false } };
        const changedConfig = { coverage: { strict: true } };
        const prefix = extension === 'json' ? '' : 'export default ';
        const stored = commit(
          {
            'src/app.css': 'a{}',
            'e2e/styleproof.spec.ts': '// spec',
            [config]: prefix + JSON.stringify(initialConfig),
          },
          'test: stored config',
        );
        const base = commit({ [config]: prefix + JSON.stringify(changedConfig) }, 'test: config change');
        const plan = planAncestorBaselineReuse({
          requestedSha: base,
          availableShas: new Set([stored]),
          spec: 'e2e/styleproof.spec.ts',
          sourceRoots: ['src'],
          cwd: repo,
        });
        assert.equal(plan.decision, 'capture');
        assert.equal(plan.reasonCode, 'ancestor_relevant_changes');
        assert.ok(plan.reason.includes(config));
      } finally {
        rmTmp(root);
      }
    });
  }
}

test('planAncestorBaselineReuse: config creation, deletion, and format migration force capture', () => {
  const root = mkTmp('styleproof-ancestor-config-lifecycle-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    const first = commit({ 'src/app.css': 'a{}', 'e2e/styleproof.spec.ts': '// spec' }, 'test: no config');
    const created = commit(
      { 'styleproof.config.ts': 'export default { coverage: { strict: true } };' },
      'test: create config',
    );
    fs.renameSync(path.join(repo, 'styleproof.config.ts'), path.join(repo, 'styleproof.config.mjs'));
    const migrated = commit({}, 'test: migrate config');
    fs.unlinkSync(path.join(repo, 'styleproof.config.mjs'));
    const deleted = commit({}, 'test: delete config');
    for (const [stored, requested] of [
      [first, created],
      [created, migrated],
      [migrated, deleted],
    ]) {
      const plan = planAncestorBaselineReuse({
        requestedSha: requested,
        availableShas: new Set([stored]),
        spec: 'e2e/styleproof.spec.ts',
        sourceRoots: ['src'],
        cwd: repo,
      });
      assert.equal(plan.decision, 'capture');
      assert.equal(plan.reasonCode, 'ancestor_relevant_changes');
    }
  } finally {
    rmTmp(root);
  }
});

// Quotes and control characters are valid POSIX filenames, but unavailable on Windows.
const quotedSourceNames = [
  'src/café.css',
  ...(process.platform === 'win32' ? [] : ['src/quoted"name.css', 'src/tab\tname.css', 'src/new\nline.css']),
];
for (const file of quotedSourceNames) {
  test(`planAncestorBaselineReuse: Git-quoted source ${JSON.stringify(file)} forces capture`, () => {
    const root = mkTmp('styleproof-ancestor-quoted-');
    try {
      const { repo, commit } = gitFixtureRepo(root);
      execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: repo });
      const stored = commit({ [file]: 'body{color:black}', 'e2e/styleproof.spec.ts': '// spec' }, 'test: source');
      const base = commit({ [file]: 'body{color:red}' }, 'test: restyle');
      const plan = planAncestorBaselineReuse({
        requestedSha: base,
        availableShas: new Set([stored]),
        spec: 'e2e/styleproof.spec.ts',
        sourceRoots: ['src'],
        cwd: repo,
      });
      assert.equal(plan.decision, 'capture', 'a real source edit must not reuse an older capture');
      assert.equal(plan.reasonCode, 'ancestor_relevant_changes');
      assert.deepEqual(changedPathsBetween({ ancestorSha: stored, sha: base, cwd: repo }), [file]);
      fs.unlinkSync(path.join(repo, file));
      const deleted = commit({}, 'test: remove source');
      assert.equal(
        planAncestorBaselineReuse({
          requestedSha: deleted,
          availableShas: new Set([base]),
          spec: 'e2e/styleproof.spec.ts',
          sourceRoots: ['src'],
          cwd: repo,
        }).decision,
        'capture',
        'a source deletion must remain capture-relevant',
      );
    } finally {
      rmTmp(root);
    }
  });
}

test('planAncestorBaselineReuse: identical-content renames into and out of source roots force capture', () => {
  const root = mkTmp('styleproof-ancestor-rename-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    execFileSync('git', ['config', 'diff.renames', 'true'], { cwd: repo });
    const stored = commit({ 'src/app.css': 'body{color:black}', 'e2e/styleproof.spec.ts': '// spec' }, 'test: source');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.renameSync(path.join(repo, 'src/app.css'), path.join(repo, 'docs/app.css'));
    const movedOut = commit({}, 'test: move source out');
    fs.renameSync(path.join(repo, 'docs/app.css'), path.join(repo, 'src/app.css'));
    const movedIn = commit({}, 'test: move source back');
    for (const [ancestorSha, sha] of [
      [stored, movedOut],
      [movedOut, movedIn],
    ]) {
      assert.equal(
        planAncestorBaselineReuse({
          requestedSha: sha,
          availableShas: new Set([ancestorSha]),
          spec: 'e2e/styleproof.spec.ts',
          sourceRoots: ['src'],
          cwd: repo,
        }).decision,
        'capture',
        'the source side of a rename must remain capture-relevant',
      );
      assert.deepEqual(changedPathsBetween({ ancestorSha, sha, cwd: repo }).sort(), ['docs/app.css', 'src/app.css']);
    }
  } finally {
    rmTmp(root);
  }
});

test('planAncestorBaselineReuse: no stored ancestor within the walk → full capture', () => {
  const root = mkTmp('styleproof-ancestor-none-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    commit({ 'src/app.css': 'a{}' }, 'test: first');
    const base = commit({ 'docs/notes.md': 'one' }, 'test: second');
    const plan = planAncestorBaselineReuse({
      requestedSha: base,
      availableShas: new Set(['f'.repeat(40)]),
      spec: 'e2e/styleproof.spec.ts',
      sourceRoots: ['src'],
      cwd: repo,
    });
    assert.equal(plan.decision, 'capture');
    assert.equal(plan.reasonCode, 'ancestor_none_stored');
    assert.match(plan.reason, /no stored bundle among the 1 nearest first-parent ancestor\(s\)/);
  } finally {
    rmTmp(root);
  }
});

test('planAncestorBaselineReuse: FAIL-SAFE — a walk error yields a capture verdict, never a throw', () => {
  const notARepo = mkTmp('styleproof-ancestor-norepo-');
  try {
    const plan = planAncestorBaselineReuse({
      requestedSha: 'a'.repeat(40),
      availableShas: new Set(['a'.repeat(40)]),
      spec: 'e2e/styleproof.spec.ts',
      sourceRoots: ['src'],
      cwd: notARepo,
    });
    assert.equal(plan.decision, 'capture');
    assert.equal(plan.reasonCode, 'ancestor_error');
    assert.match(plan.reason, /rev-list/);
  } finally {
    rmTmp(notARepo);
  }
});

test('changedPathsBetween: names the tree diff and fails loud on an unresolvable commit', () => {
  const root = mkTmp('styleproof-ancestor-diff-');
  try {
    const { repo, commit } = gitFixtureRepo(root);
    const first = commit({ 'src/app.css': 'a{}' }, 'test: first');
    const second = commit({ 'docs/notes.md': 'one' }, 'test: second');
    assert.deepEqual(changedPathsBetween({ ancestorSha: first, sha: second, cwd: repo }), ['docs/notes.md']);
    assert.throws(
      () => changedPathsBetween({ ancestorSha: 'f'.repeat(40), sha: second, cwd: repo }),
      AncestorBaselineError,
    );
  } finally {
    rmTmp(root);
  }
});

// ── Map-store listing + provenance sidecar ──────────────────────────────────────

/** Stand up a bare remote whose `styleproof-maps` branch holds one bundle per
 *  entry of `seededShas`, and a consumer repo pointing at it (same shape as the
 *  map-store test fixture). */
function seedMapStoreWithShas(root, seededShas, compatibilityKey) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const consumer = path.join(root, 'consumer');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', remote, seed);
  git(seed, 'checkout', '-q', '-b', 'styleproof-maps');
  git(seed, 'config', 'user.email', 'styleproof@example.test');
  git(seed, 'config', 'user.name', 'StyleProof Test');
  fs.writeFileSync(path.join(seed, 'README.md'), '# maps\n');
  for (const seededSha of seededShas) {
    const bundle = path.join(seed, seededSha, compatibilityKey);
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'home@1280.json'), '{"seeded":true}\n');
    fs.writeFileSync(
      path.join(bundle, MAP_MANIFEST),
      JSON.stringify({
        version: 1,
        packageVersion: 'test',
        sha: seededSha,
        dirty: false,
        spec: 'styleproof.spec.ts',
        specHash: 'test',
        platform: 'linux',
        arch: 'x64',
        nodeMajor: '22',
        screenshots: false,
        har: false,
        compatibilityKey,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'styleproof-maps');
  git(root, '--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true');
  fs.mkdirSync(consumer);
  git(consumer, 'init', '-q', '-b', 'main');
  git(consumer, 'remote', 'add', 'origin', remote);
  return { consumer };
}

test('listMapStoreBundleShas: lists the stored bundle SHAs without downloading any map blob', () => {
  const root = mkTmp('styleproof-store-list-');
  const previousAttempts = process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS;
  process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS = '1';
  try {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const { consumer } = seedMapStoreWithShas(root, [first, second], 'deadbeefdeadbeef');
    assert.deepEqual([...listMapStoreBundleShas({ cwd: consumer })].sort(), [first, second]);
  } finally {
    if (previousAttempts === undefined) delete process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS;
    else process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS = previousAttempts;
    rmTmp(root);
  }
});

test('listMapStoreBundleShas: a missing map store branch is an EMPTY listing, not a fault', () => {
  const root = mkTmp('styleproof-store-list-nobranch-');
  try {
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
    const remote = path.join(root, 'remote.git');
    const consumer = path.join(root, 'consumer');
    git(root, 'init', '--bare', '-q', remote);
    fs.mkdirSync(consumer);
    git(consumer, 'init', '-q', '-b', 'main');
    git(consumer, 'remote', 'add', 'origin', remote);
    assert.deepEqual([...listMapStoreBundleShas({ cwd: consumer })], []);
  } finally {
    rmTmp(root);
  }
});

test('baseline provenance sidecar: round-trips, and never reads as a phantom surface map', () => {
  const dir = mkTmp('styleproof-provenance-');
  try {
    const provenance = {
      version: 1,
      baseline: 'ancestor-reuse',
      requestedSha: 'b'.repeat(40),
      restoredSha: 'a'.repeat(40),
      ancestorDepth: 1,
      changedPathCount: 3,
      sourceRoots: ['src'],
    };
    writeBaselineProvenance(dir, provenance);
    assert.deepEqual(readBaselineProvenance(dir), provenance);
    assert.equal(isMapFile(BASELINE_PROVENANCE_FILE), false, 'the sidecar must never count as a surface map');
    assert.equal(readBaselineProvenance(mkTmp('styleproof-provenance-empty-')), null);
  } finally {
    rmTmp(dir);
  }
});

test('report: an ancestor-reused baseline is stated in report.md and report.json — no silent reuse', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  try {
    const map = makeMap({ elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } } });
    writeCapture(beforeDir, 'home@1280', map, null);
    writeCapture(afterDir, 'home@1280', map, null);
    writeBaselineProvenance(beforeDir, {
      version: 1,
      baseline: 'ancestor-reuse',
      requestedSha: 'b'.repeat(40),
      restoredSha: 'a'.repeat(40),
      ancestorDepth: 1,
      changedPathCount: 2,
      sourceRoots: ['src'],
    });
    const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
    const reportMarkdown = fs.readFileSync(result.reportMdPath, 'utf8');
    assert.match(
      reportMarkdown,
      /\*\*Baseline\*\* — ♻ restored from nearest ancestor `aaaaaaaaaaaa` of base `bbbbbbbbbbbb`/,
    );
    assert.match(reportMarkdown, /2 path\(s\) changed between them, none capture-relevant/);
    const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    assert.equal(reportJson.baselineProvenance.baseline, 'ancestor-reuse');
    assert.equal(reportJson.baselineProvenance.restoredSha, 'a'.repeat(40));
    assert.equal(reportJson.baselineProvenance.changedPathCount, 2);
  } finally {
    rmTmp(root);
  }
});

test('report: without a provenance sidecar the report bytes carry no Baseline line (default unchanged)', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  try {
    const map = makeMap({ elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } } });
    writeCapture(beforeDir, 'home@1280', map, null);
    writeCapture(afterDir, 'home@1280', map, null);
    const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
    assert.doesNotMatch(fs.readFileSync(result.reportMdPath, 'utf8'), /\*\*Baseline\*\*/);
    assert.equal('baselineProvenance' in JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')), false);
  } finally {
    rmTmp(root);
  }
});
