import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { chromiumInstalled, collectPrePushProofs } from '../scripts/pre-push-e2e.mjs';
import { browserLanesRequired, makeGit } from '../scripts/browser-lanes.mjs';
import {
  contentCases,
  createContentFixture,
  createFixture,
  fileChangeCase,
  legacyPathCases,
  trackedBrowserCases,
} from './helpers/browser-lanes-fixtures.mjs';

const hook = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');

test('local tree proofs require browsers for capture/diff/report/engine and README-only changes', (t) => {
  const f = fixture(t);
  for (const file of [
    'README.md',
    'CONTRIBUTING.md',
    'src/capture.ts',
    'src/capture/browser.ts',
    'src/diff.ts',
    'src/report.ts',
    'src/report/html.ts',
    'src/runner.ts',
    'src/runner/browser.ts',
    'src/config.ts',
    'package.json',
    'src/capture.ts.bak',
  ]) {
    f.write(file, file === 'package.json' ? '{"private":true}' : 'changed fixture');
    f.git('add', file);
    const proofs = collectPrePushProofs({ stdinText: f.pushed(), git: makeGit(f.root) });
    assert.equal(browserLanesRequired(proofs), true, file);
    assert.equal(proofs.at(-1).kind, 'differs', file);
    const result = f.run(f.pushed());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n', file);
    f.git('read-tree', f.base);
  }
});

test('chromiumInstalled is true only when the resolved executable exists', () => {
  assert.equal(chromiumInstalled({ executablePath: undefined, existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '', existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '/missing/chrome', existsSync: () => false }), false);
  assert.equal(chromiumInstalled({ executablePath: '/present/chrome', existsSync: () => true }), true);
});

test('collector retains both staged and pushed tree proofs', (t) => {
  const f = fixture(t);
  f.write('README.md', 'A pushed change');
  const head = f.commit();
  f.write('src/capture.ts', 'A staged change');
  f.git('add', 'src/capture.ts');
  assert.deepEqual(collectPrePushProofs({ stdinText: f.pushed(head, f.base), git: makeGit(f.root) }), [
    { kind: 'differs' },
    { kind: 'differs' },
  ]);
  const firstPush = collectPrePushProofs({ stdinText: f.pushed(head, '0'.repeat(40)), git: makeGit(f.root) });
  assert.equal(firstPush[0].kind, 'unknown');
  assert.equal(firstPush[1].kind, 'differs');
  assert.equal(browserLanesRequired(firstPush), true);
});

test('pre-push runs unit tests then the staged e2e gate', () => {
  const syntax = spawnSync('sh', ['-n', '.husky/pre-push'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(hook, /npm test/);
  assert.match(hook, /scripts\/pre-push-e2e\.mjs/);
});

test('pre-push still fails closed when unit tests fail before e2e', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'styleproof-contributor-hook-'));
  try {
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/bin/sh\necho "fake npm $*"\nexit 17\n');
    chmodSync(npm, 0o755);
    const result = spawnSync('sh', ['.husky/pre-push'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /pre-push-e2e/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('pre-push e2e gate explains how to repair missing Chromium without skipping', () => {
  const script = readFileSync(new URL('../scripts/pre-push-e2e.mjs', import.meta.url), 'utf8');
  assert.match(script, /Playwright Chromium not installed/);
  assert.doesNotMatch(script, /skipping staged e2e/);
  assert.match(script, /npx playwright install chromium/);
  assert.match(hook, /scripts\/pre-push-e2e\.mjs/);
});

test('local selection shares the hosted tree policy, including fixtures and e2e-only changes', (t) => {
  const f = fixture(t);
  for (const file of [
    'test/fixtures/theme.css',
    'example/demo/index.html',
    'test/served-rules.e2e.spec.ts',
    'playwright.config.ts',
    'styles/theme.scss',
    'new-surface.custom',
    'test\\fixtures\\theme.css',
    'README.md',
    'docs/demo/report.html',
    'test/report.test.mjs',
    '.github/path-filters.yml',
  ]) {
    f.write(file, 'fixture');
    const head = f.commit();
    const proofs = collectPrePushProofs({ stdinText: f.pushed(head, f.base), git: makeGit(f.root) });
    assert.equal(browserLanesRequired(proofs), true, file);
    const result = f.run(f.pushed(head, f.base));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n', file);
  }
  assert.equal(browserLanesRequired(collectPrePushProofs({ git: makeGit(f.root) })), true);
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(
    browserLanesRequired(collectPrePushProofs({ stdinText: f.pushed(head, head), git: makeGit(f.root) })),
    false,
  );
});

test('collector distinguishes deletion and same trees from unknown or malformed records', (t) => {
  const f = fixture(t);
  const git = makeGit(f.root);
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  assert.deepEqual(collectPrePushProofs({ stdinText: f.pushed(), git }), [
    { kind: 'same-tree', tree },
    { kind: 'same-tree', tree },
  ]);
  assert.deepEqual(collectPrePushProofs({ stdinText: f.pushed('0'.repeat(40), f.base, '(delete)'), git }), [
    { kind: 'deleted' },
    { kind: 'same-tree', tree },
  ]);
  assert.equal(collectPrePushProofs({ git })[0].kind, 'unknown');
  for (const [remote, local] of [
    ['main', f.base],
    [f.base, ''],
    ['0'.repeat(40), '0'.repeat(40)],
    ['0'.repeat(40), 'a'.repeat(64)],
    ['0'.repeat(40), 'g'.repeat(40)],
  ]) {
    assert.throws(() => collectPrePushProofs({ stdinText: f.pushed(local, remote), git }), /OID|object|record/i);
  }
});

function localProcess(root, { browser = true, npmExit = 0 } = {}) {
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  for (const file of ['scripts/pre-push-e2e.mjs', 'scripts/browser-lanes.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  write('node_modules/@playwright/test/package.json', '{"type":"module","exports":"./index.mjs"}');
  write(
    'node_modules/@playwright/test/index.mjs',
    `export const chromium = { executablePath: () => ${JSON.stringify(join(root, 'chrome'))} };\n`,
  );
  if (browser) write('chrome', 'browser presence fixture; never executed');
  write('fake-bin/npm', `#!/bin/sh\nprintf '%s\\n' "$@" > npm-args\nexit ${npmExit}\n`);
  chmodSync(join(root, 'fake-bin/npm'), 0o755);
  const run = (input = '', extraEnv = {}) => {
    rmSync(join(root, 'npm-args'), { force: true });
    return spawnSync(process.execPath, ['scripts/pre-push-e2e.mjs'], {
      cwd: root,
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}`, ...extraEnv },
    });
  };
  const npmArgs = () => (existsSync(join(root, 'npm-args')) ? readFileSync(join(root, 'npm-args'), 'utf8') : null);
  return { root, write, run, npmArgs };
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'styleproof-pre-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { write, run, npmArgs } = localProcess(root, options);
  write('.gitignore', 'node_modules/\nfake-bin/\nnpm-args\nchrome\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=StyleProof Tests', '-c', 'user.email=tests@example.test', 'commit', '-m', 'test: fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const base = commit();
  const pushed = (localOid = base, remoteOid = base, localRef = 'HEAD') =>
    `${localRef} ${localOid} refs/heads/test ${remoteOid}\n`;
  return { root, write, git, commit, base, run, pushed, npmArgs };
}

test('a first push with a clean index runs all browser tests with at most four workers', (t) => {
  const f = fixture(t);
  f.write('styles/deleted.css', 'body { color: red }');
  f.commit();
  f.git('rm', 'styles/deleted.css');
  f.write('README.md', 'Only prose remains in this new branch.');
  const head = f.commit();
  const result = f.run(f.pushed(head, '0'.repeat(40)));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('missing push stdin runs the browser gate instead of pretending the diff is empty', (t) => {
  const f = fixture(t);
  for (const input of ['', '\n \t\n']) {
    const result = f.run(input);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  }
});

test('verified empty and deletion-only ranges may skip', (t) => {
  const f = fixture(t);
  f.write('README.md', 'Prose');
  const head = f.commit();
  for (const input of [
    f.pushed(head, head),
    f.pushed('0'.repeat(40), head, '(delete)'),
    f.pushed(f.base, f.base, 'HEAD~'),
    f.pushed(head, head, head),
  ]) {
    const result = f.run(input);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /skipped/);
    assert.equal(f.npmArgs(), null);
  }
});

test('a README-only push runs the full browser gate', (t) => {
  const f = fixture(t);
  f.write('README.md', 'Prose');
  const head = f.commit();
  const result = f.run(f.pushed(head, f.base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('a known range retains the old style path when renamed to a documentation path', (t) => {
  const f = fixture(t);
  f.write('old theme.css', 'body { color: red }');
  const base = f.commit();
  f.git('mv', 'old theme.css', 'README.md');
  const head = f.commit();
  const result = f.run(f.pushed(head, base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('multiple push records cannot hide unknown, browser-changing, or malformed later records', (t) => {
  const f = fixture(t);
  f.write('README.md', 'Prose');
  const docs = f.commit();
  f.write('theme.css', 'body { color: red }');
  const head = f.commit();
  const safe = f.pushed(docs, f.base, 'HEAD~');
  for (const second of [
    f.pushed(head, '0'.repeat(40)).replace('refs/heads/test', 'refs/heads/new'),
    f.pushed(head, docs).replace('refs/heads/test', 'refs/heads/theme'),
  ]) {
    for (const first of [safe, f.pushed(docs, docs, 'HEAD~')]) {
      const result = f.run(first + second);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
    }
  }
  const malformed = f.run(safe + 'malformed second record\n');
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.equal(f.npmArgs(), null);
});

test('annotated tags work for both known ranges and unknown first pushes', (t) => {
  const f = fixture(t);
  f.git('-c', 'user.name=StyleProof Tests', '-c', 'user.email=tests@example.test', 'tag', '-a', 'v1', '-m', 'fixture');
  const tag = f.git('rev-parse', 'refs/tags/v1');
  assert.notEqual(tag, f.base, 'the annotated tag has its own object ID');
  for (const [remote, runs] of [
    [f.base, false],
    ['0'.repeat(40), true],
  ]) {
    const result = f.run(f.pushed(tag, remote, 'refs/tags/v1').replace('refs/heads/test', 'refs/tags/v1'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), runs ? 'run\ntest:e2e\n--\n--workers=4\n' : null);
  }
});

test('staged paths preserve literal spaces, line terminators and backslashes', (t) => {
  const f = fixture(t);
  const files = [
    ' README.md',
    'README.md\nCHANGELOG.md',
    'README.md ',
    '.agents\\theme.css',
    ...['\n', '\r', '\u2028', '\u2029'].map((term) => `docs/theme${term}.css`),
  ];
  for (const file of files) f.write(file, 'fixture');
  f.git('add', '.');
  const collected = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import { collectPrePushProofs } from "./scripts/pre-push-e2e.mjs"; ' +
        `console.log(JSON.stringify(collectPrePushProofs({ stdinText: ${JSON.stringify(f.pushed())} })));`,
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(JSON.parse(collected.stdout).at(-1).kind, 'differs');
  assert.notEqual(f.git('write-tree'), f.git('rev-parse', 'HEAD^{tree}'));
  const result = f.run(f.pushed());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

for (const file of [
  '.agents\\theme.css',
  '.github\\ISSUE_TEMPLATE\\theme.css',
  ...['\n', '\r', '\u2028', '\u2029'].map((term) => `docs/theme${term}.css`),
]) {
  test(`a CSS-only push of ${JSON.stringify(file)} preserves the Git filename and runs browsers`, (t) => {
    const f = fixture(t);
    f.write(file, 'body { color: red }');
    const base = f.commit();
    f.write(file, 'body { color: blue }');
    const head = f.commit();
    const collected = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import { collectPrePushProofs } from "./scripts/pre-push-e2e.mjs"; ' +
          `console.log(JSON.stringify(collectPrePushProofs({ stdinText: ${JSON.stringify(f.pushed(head, base))} })));`,
      ],
      { cwd: f.root, encoding: 'utf8' },
    );
    assert.equal(collected.status, 0, collected.stderr);
    assert.equal(JSON.parse(collected.stdout)[0].kind, 'differs');
    assert.notEqual(f.git('rev-parse', `${head}^{tree}`), f.git('rev-parse', `${base}^{tree}`));
    const result = f.run(f.pushed(head, base));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  });
}

test('a Git type-change record still runs browsers', (t) => {
  const f = fixture(t);
  f.write('theme.css', 'body { color: red }');
  const base = f.commit();
  rmSync(join(f.root, 'theme.css'));
  symlinkSync('other.css', join(f.root, 'theme.css'));
  const head = f.commit();
  assert.equal(f.git('diff', '--name-status', base, head), 'T\ttheme.css');
  const result = f.run(f.pushed(head, base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

function submoduleFixture(t, ignoreSource) {
  const f = fixture(t);
  f.write('.gitignore', readFileSync(join(f.root, '.gitignore'), 'utf8') + 'child-source/\n');
  f.git('init', '-q', 'child-source');
  const childGit = (...args) => f.git('-C', 'child-source', ...args);
  const commitChild = () => {
    childGit('add', 'theme.css');
    childGit(
      '-c',
      'user.name=StyleProof Tests',
      '-c',
      'user.email=tests@example.test',
      'commit',
      '-s',
      '-m',
      'test: child style change',
    );
    return childGit('rev-parse', 'HEAD');
  };
  f.write('child-source/theme.css', 'body { color: red }\n');
  const childBase = commitChild();
  f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'styles', './child-source', 'palette');
  if (ignoreSource === '.gitmodules') {
    f.git('config', '--file', '.gitmodules', 'submodule.styles.ignore', 'all');
  } else {
    f.git('config', ignoreSource, 'all');
  }
  const base = f.commit();
  f.write('child-source/theme.css', 'body { color: blue }\n');
  const childHead = commitChild();
  f.git('-C', 'palette', 'fetch', 'origin');
  f.git('-C', 'palette', 'checkout', '-q', childHead);
  f.git('update-index', '--cacheinfo', `160000,${childHead},palette`);
  const childPatch = childGit('diff', childBase, childHead, '--', 'theme.css');
  assert.match(childPatch, /-body \{ color: red \}/);
  assert.match(childPatch, /\+body \{ color: blue \}/);
  return { ...f, base };
}

for (const ignoreSource of ['.gitmodules', 'diff.ignoreSubmodules', 'submodule.styles.ignore']) {
  for (const inventory of ['staged', 'pushed']) {
    test(`${ignoreSource} cannot hide a ${inventory} CSS submodule update from browsers`, (t) => {
      const f = submoduleFixture(t, ignoreSource);
      const head = inventory === 'pushed' ? f.commit() : f.base;
      const range = inventory === 'pushed' ? [f.base, head] : ['--cached'];
      assert.equal(f.git('diff', '--name-only', '--no-renames', '-z', ...range), '');
      assert.equal(
        f.git('diff', '--ignore-submodules=none', '--name-only', '--no-renames', '-z', ...range),
        'palette\0',
      );
      const result = f.run(f.pushed(head, f.base));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /skipped/);
      assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
    });
  }
}

for (const replacedObject of ['commit', 'tree']) {
  for (const inventory of ['staged', 'pushed']) {
    test(`a replacement ${replacedObject} cannot hide a ${inventory} CSS change from browsers`, (t) => {
      const f = fixture(t);
      f.write('theme.css', 'body { color: red }\n');
      const base = f.commit();
      f.write('theme.css', 'body { color: blue }\n');
      const head = f.commit();
      const baseObject = replacedObject === 'tree' ? f.git('rev-parse', `${base}^{tree}`) : base;
      const headObject = replacedObject === 'tree' ? f.git('rev-parse', `${head}^{tree}`) : head;
      let input;
      let range;
      if (inventory === 'staged') {
        f.git('checkout', '-q', base);
        f.write('theme.css', 'body { color: blue }\n');
        f.git('add', 'theme.css');
        f.git('replace', baseObject, headObject);
        range = ['--cached'];
        input = f.pushed(base, base);
      } else {
        f.git('branch', 'pushed-style', head);
        f.git('checkout', '-q', base);
        f.git('replace', headObject, baseObject);
        range = [base, head];
        input = f.pushed(head, base, 'refs/heads/pushed-style');
      }
      assert.equal(f.git('diff', '--ignore-submodules=none', '--name-only', '-z', ...range), '');
      assert.equal(
        f.git('--no-replace-objects', 'diff', '--ignore-submodules=none', '--name-only', '-z', ...range),
        'theme.css\0',
      );
      const result = f.run(input);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /skipped/);
      assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
    });
  }
}

test('missing or malformed shared decider aborts the real hook process, including equal trees', (t) => {
  const f = fixture(t);
  for (const contents of [null, 'export function {']) {
    if (contents === null) rmSync(join(f.root, 'scripts/browser-lanes.mjs'));
    else f.write('scripts/browser-lanes.mjs', contents);
    const head = f.commit();
    const result = f.run(f.pushed(head, head));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
    assert.equal(f.npmArgs(), null);
  }
});

test('selected browser tests fail closed when Chromium is missing', (t) => {
  const f = fixture(t, { browser: false });
  f.write('src/capture.ts', 'export {};');
  f.git('add', '.');
  const result = f.run(f.pushed());
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Playwright Chromium not installed/);
  assert.match(result.stderr, /npx playwright install chromium/);
  assert.doesNotMatch(result.stdout + result.stderr, /skipping|skipped/);
  assert.equal(f.npmArgs(), null);
});

test('browser-test failures propagate without changing the full-suite invocation', (t) => {
  const f = fixture(t, { npmExit: 23 });
  f.write('src/capture.ts', 'export {};');
  f.git('add', '.');
  const result = f.run(f.pushed());
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('malformed push metadata fails rather than returning a docs-only success', (t) => {
  const f = fixture(t);
  for (const input of [
    'not a push range\n',
    f.pushed() + 'extra\n',
    f.pushed().trimEnd() + ' extra\n',
    f.pushed('not-an-oid'),
    f.pushed(f.base, 'short'),
    f.pushed('0'.repeat(40), f.base),
    f.pushed(f.base, f.base, '(delete)'),
    f.pushed().replace('refs/heads/test', 'refs/heads/bad..name'),
    f.pushed().replace('refs/heads/test', 'heads/test'),
    f.pushed(f.base, f.base, 'refs/heads/missing'),
    f.pushed('a'.repeat(40), f.base),
    f.pushed('0'.repeat(40), '0'.repeat(40), '(delete)'),
    f.pushed('a'.repeat(64), '0'.repeat(40)),
    f.pushed('g'.repeat(40), '0'.repeat(40)),
  ]) {
    const result = f.run(input);
    assert.equal(result.status, 1, `${JSON.stringify(input)}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Invalid|git .*failed/i);
    assert.equal(f.npmArgs(), null);
  }
});

test('Git failures abort both staged and push-range inventory collection', (t) => {
  const f = fixture(t);
  const missingRange = f.run(f.pushed(f.base, 'a'.repeat(40)));
  assert.equal(missingRange.status, 1, missingRange.stdout + missingRange.stderr);
  assert.match(missingRange.stderr, /git|tree/i);
  f.write('fake-bin/git', '#!/bin/sh\necho "fixture Git failed" >&2\nexit 69\n');
  chmodSync(join(f.root, 'fake-bin/git'), 0o755);
  const brokenGit = f.run(f.pushed());
  assert.equal(brokenGit.status, 1, brokenGit.stdout + brokenGit.stderr);
  assert.match(brokenGit.stderr, /fixture Git failed/);
  assert.equal(f.npmArgs(), null);
});

for (const row of [
  ...contentCases,
  ...legacyPathCases.flatMap(([title, files], i) =>
    files.map((name, j) => ({
      ...fileChangeCase(`legacy-${i + 1}-${j + 1}`, name, title),
      ...(name === 'package.json' ? { before: '{"description":"base"}', after: '{"description":"changed"}' } : {}),
    })),
  ),
  ...trackedBrowserCases().specs,
  ...trackedBrowserCases().imports,
]) {
  test(`L ${row.id}: ${row.title} invokes the full browser gate`, (t) => {
    const f = createContentFixture(t, row);
    const process = localProcess(f.directory, { npmExit: 37 });
    const result = process.run(`${f.head} ${f.head} refs/heads/pushed ${f.base}\n`);
    assert.notEqual(f.baseTree, f.headTree, 'the real root trees differ');
    assert.equal(result.status, 37, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /skipped/);
    assert.equal(process.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  });
}

test('M5: grafted parents cannot hide a pushed or staged CSS tree change', (t) => {
  const f = fixture(t, { npmExit: 37 });
  f.write('theme.css', 'body { color: black }');
  const base = f.commit();
  f.write('theme.css', 'body { color: magenta }');
  const head = f.commit();
  f.write('.git/info/grafts', `${head}\n${base} ${head}\n`);
  for (const input of [f.pushed(head, base), f.pushed(head, head)]) {
    if (input === f.pushed(head, head)) {
      f.write('theme.css', 'body { color: yellow }');
      f.git('add', 'theme.css');
    }
    const result = f.run(input);
    assert.equal(result.status, 37, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  }
});

for (const variable of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
  test(`M6: leaked ${variable} cannot hide the canonical staged CSS tree`, (t) => {
    const f = fixture(t, { npmExit: 37 });
    f.write('theme.css', 'body { color: black }');
    const base = f.commit();
    const clean = fixture(t);
    // A real clone has the same object IDs and clean index, so ref validation alone cannot catch the leak.
    const other = join(clean.root, 'clean-clone');
    f.git('clone', '-q', f.root, other);
    const savedIndex = join(clean.root, 'saved-index');
    copyFileSync(join(f.root, '.git/index'), savedIndex);
    f.write('theme.css', 'body { color: magenta }');
    f.git('add', 'theme.css');
    assert.notEqual(f.git('write-tree'), f.git('rev-parse', 'HEAD^{tree}'));
    const value = variable === 'GIT_INDEX_FILE' ? savedIndex : variable === 'GIT_DIR' ? join(other, '.git') : other;
    const result = f.run(f.pushed(base, base), { [variable]: value });
    assert.equal(result.status, 37, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  });
}

test('M6: core.worktree and diff.relative cannot hide a staged CSS tree', (t) => {
  const f = fixture(t, { npmExit: 37 });
  f.write('theme.css', 'body { color: black }');
  const base = f.commit();
  f.write('theme.css', 'body { color: magenta }');
  f.git('add', 'theme.css');
  f.git('config', 'core.worktree', dirname(f.root));
  f.git('config', 'diff.relative', 'true');
  assert.notEqual(f.git('write-tree'), f.git('rev-parse', 'HEAD^{tree}'));
  const result = f.run(f.pushed(base, base));
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('M10: an ignored stdin descriptor still requires browser verification', (t) => {
  const f = fixture(t, { npmExit: 37 });
  const result = spawnSync(process.execPath, ['scripts/pre-push-e2e.mjs'], {
    cwd: f.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${join(f.root, 'fake-bin')}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('M11: deletion plus a changed tree or a first push still requires browsers', (t) => {
  const f = fixture(t, { npmExit: 37 });
  f.write('theme.css', 'body { color: magenta }');
  const head = f.commit();
  const deletion = f.pushed('0'.repeat(40), f.base, '(delete)');
  for (const remote of [f.base, '0'.repeat(40)]) {
    const result = f.run(deletion + f.pushed(head, remote).replace('refs/heads/test', 'refs/heads/changed'));
    assert.equal(result.status, 37, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
  }
});

test('M12: a tag pointing at a blob blocks a known comparison and runs on first push', (t) => {
  const f = fixture(t, { npmExit: 37 });
  const blob = f.git('rev-parse', 'HEAD:.gitignore');
  f.git(
    '-c',
    'user.name=StyleProof Tests',
    '-c',
    'user.email=tests@example.test',
    'tag',
    '-a',
    'blob',
    blob,
    '-m',
    'blob tag',
  );
  const tag = f.git('rev-parse', 'refs/tags/blob');
  for (const [remote, expected] of [
    [f.base, 1],
    ['0'.repeat(40), 37],
  ]) {
    const result = f.run(f.pushed(tag, remote, 'refs/tags/blob'));
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.equal(f.npmArgs(), expected === 37 ? 'run\ntest:e2e\n--\n--workers=4\n' : null);
  }
});

test('M14: a real shallow clone with a missing remote object blocks rather than skipping', (t) => {
  const f = fixture(t);
  f.write('theme.css', 'body { color: magenta }');
  const head = f.commit();
  const shallow = join(f.root, 'shallow');
  f.git('clone', '-q', '--depth=1', `file://${f.root}`, shallow);
  const p = localProcess(shallow, { npmExit: 37 });
  const missing = spawnSync('git', ['cat-file', '-e', f.base], { cwd: shallow, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  const result = p.run(`HEAD ${head} refs/heads/test ${f.base}\n`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(p.npmArgs(), null);
});

test('M15: an unmerged index cannot supply a same-tree proof', (t) => {
  const f = fixture(t, { npmExit: 37 });
  const blob = f.git('rev-parse', 'HEAD:.gitignore');
  const result = spawnSync('git', ['update-index', '--index-info'], {
    cwd: f.root,
    input: `100644 ${blob} 1\ttheme.css\n100644 ${blob} 2\ttheme.css\n100644 ${blob} 3\ttheme.css\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const proofs = collectPrePushProofs({ stdinText: f.pushed(), git: makeGit(f.root) });
  assert.equal(proofs.at(-1).kind, 'unknown');
  const run = f.run(f.pushed());
  assert.equal(run.status, 37, run.stdout + run.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('M15: an unborn HEAD with staged CSS requires browsers', (t) => {
  const f = createFixture(t);
  const p = localProcess(f.directory, { npmExit: 37 });
  f.setEntry('theme.css', '100644', 'body { color: magenta }');
  const result = p.run('');
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(p.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('M16: missing Chromium blocks changed, first-push, and unknown-stdin paths', (t) => {
  const f = fixture(t, { browser: false });
  f.write('theme.css', 'body { color: magenta }');
  const head = f.commit();
  for (const input of [f.pushed(head, f.base), f.pushed(head, '0'.repeat(40)), '', '\n']) {
    const result = f.run(input);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Playwright Chromium not installed/);
    assert.equal(f.npmArgs(), null);
  }
});

test('M17: the full shell hook propagates e2e exit 37 after unit success', (t) => {
  const f = fixture(t);
  f.write('.husky/pre-push', hook);
  f.write('fake-bin/npm', '#!/bin/sh\nprintf "%s\\n" "$*" >> npm-args\nif [ "$1" = test ]; then exit 0; fi\nexit 37\n');
  chmodSync(join(f.root, 'fake-bin/npm'), 0o755);
  const head = f.commit();
  const result = spawnSync('sh', ['.husky/pre-push'], {
    cwd: f.root,
    input: f.pushed(head, '0'.repeat(40)),
    env: { ...process.env, PATH: `${join(f.root, 'fake-bin')}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'test\nrun test:e2e -- --workers=4\n');
});

test('M7: distinct commits with an identical root tree may skip with a clean index', (t) => {
  const f = fixture(t);
  f.git(
    '-c',
    'user.name=StyleProof Tests',
    '-c',
    'user.email=tests@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'test: metadata only',
  );
  const head = f.git('rev-parse', 'HEAD');
  assert.notEqual(head, f.base);
  assert.equal(f.git('rev-parse', `${head}^{tree}`), f.git('rev-parse', `${f.base}^{tree}`));
  const result = f.run(f.pushed(head, f.base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped/);
  assert.equal(f.npmArgs(), null);
});

test('M12: an annotated tag with a changed target tree runs browsers', (t) => {
  const f = fixture(t, { npmExit: 37 });
  f.write('theme.css', 'body { color: magenta }');
  const head = f.commit();
  f.git(
    '-c',
    'user.name=StyleProof Tests',
    '-c',
    'user.email=tests@example.test',
    'tag',
    '-a',
    'changed',
    head,
    '-m',
    'changed tag',
  );
  const tag = f.git('rev-parse', 'refs/tags/changed');
  const result = f.run(f.pushed(tag, f.base, 'refs/tags/changed'));
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});

test('M13: full SHA-256 records retain same-tree and first-push behavior but reject mixed formats', (t) => {
  const f = createFixture(t, { format: 'sha256' });
  const p = localProcess(f.directory, { npmExit: 37 });
  f.setEntry('theme.css', '100644', 'body { color: black }');
  const base = f.commit();
  f.git(['update-ref', 'refs/heads/test', base]);
  f.git(['symbolic-ref', 'HEAD', 'refs/heads/test']);
  assert.equal(base.length, 64);
  for (const [remote, expected] of [
    [base, 0],
    ['0'.repeat(64), 37],
    ['0'.repeat(40), 1],
  ]) {
    const result = p.run(`HEAD ${base} refs/heads/test ${remote}\n`);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.equal(p.npmArgs(), expected === 37 ? 'run\ntest:e2e\n--\n--workers=4\n' : null);
  }
});

test('M15: deletion-only metadata cannot hide an actual staged CSS tree change', (t) => {
  const f = fixture(t, { npmExit: 37 });
  f.write('theme.css', 'body { color: magenta }');
  f.git('add', 'theme.css');
  const result = f.run(f.pushed('0'.repeat(40), f.base, '(delete)'));
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(f.npmArgs(), 'run\ntest:e2e\n--\n--workers=4\n');
});
