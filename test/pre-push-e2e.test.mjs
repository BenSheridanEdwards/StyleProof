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
import { chromiumInstalled, collectPrePushFiles, shouldRunStagedE2e } from '../scripts/pre-push-e2e.mjs';
import { needsBrowserLanes } from '../scripts/ci-path-filters.mjs';

const hook = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');

test('shouldRunStagedE2e matches capture/diff/report/engine and README-only changes', () => {
  assert.equal(shouldRunStagedE2e(['README.md', 'CONTRIBUTING.md']), true);
  assert.equal(shouldRunStagedE2e(['src/capture.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/capture/browser.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/diff.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/report.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/report/html.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/runner.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/runner/browser.ts']), true);
  assert.equal(shouldRunStagedE2e(['src/config.ts', 'package.json']), true);
  assert.equal(shouldRunStagedE2e(['src/capture.ts.bak']), true);
});

test('chromiumInstalled is true only when the resolved executable exists', () => {
  assert.equal(chromiumInstalled({ executablePath: undefined, existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '', existsSync: () => true }), false);
  assert.equal(chromiumInstalled({ executablePath: '/missing/chrome', existsSync: () => false }), false);
  assert.equal(chromiumInstalled({ executablePath: '/present/chrome', existsSync: () => true }), true);
});

test('collectPrePushFiles unions staged paths with push-range diffs', () => {
  assert.deepEqual(
    collectPrePushFiles({
      stagedFiles: ['README.md', 'src/capture.ts'],
      pushRanges: [],
    }),
    ['README.md', 'src/capture.ts'],
  );
  assert.deepEqual(
    collectPrePushFiles({
      stagedFiles: ['README.md'],
      pushRanges: [{ remoteOid: '0'.repeat(40), localOid: 'a'.repeat(40) }],
    }),
    null,
  );
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

test('local selection shares the hosted browser policy, including fixtures and e2e-only changes', () => {
  for (const file of [
    'test/fixtures/theme.css',
    'example/demo/index.html',
    'test/served-rules.e2e.spec.ts',
    'playwright.config.ts',
    'styles/theme.scss',
    'new-surface.custom',
    'test\\fixtures\\theme.css',
  ]) {
    assert.equal(shouldRunStagedE2e([file]), true, file);
  }
  for (const file of ['README.md', 'docs/demo/report.html', 'test/report.test.mjs', '.github/path-filters.yml']) {
    assert.equal(shouldRunStagedE2e([file]), needsBrowserLanes([file]), file);
  }
  assert.equal(shouldRunStagedE2e(null), true, 'unknown inventory must run');
  assert.equal(shouldRunStagedE2e([]), false, 'a proven empty diff may skip');
});

test('collector distinguishes deletion and empty diffs from unknown or malformed ranges', () => {
  assert.deepEqual(collectPrePushFiles({ stagedFiles: [], pushRanges: [] }), []);
  assert.deepEqual(
    collectPrePushFiles({ stagedFiles: [], pushRanges: [{ remoteOid: 'a'.repeat(40), localOid: '0'.repeat(40) }] }),
    [],
  );
  assert.equal(collectPrePushFiles({ stagedFiles: [], readStdin: false }), null);
  for (const range of [
    { remoteOid: 'main', localOid: 'a'.repeat(40) },
    { remoteOid: 'a'.repeat(40), localOid: '' },
    { remoteOid: '0'.repeat(40), localOid: '0'.repeat(40) },
    { remoteOid: '0'.repeat(40), localOid: 'a'.repeat(64) },
    { remoteOid: '0'.repeat(40), localOid: 'g'.repeat(40) },
  ]) {
    assert.throws(() => collectPrePushFiles({ stagedFiles: [], pushRanges: [range] }), /OID|object/i);
  }
  assert.equal(
    collectPrePushFiles({ stagedFiles: [], pushRanges: [{ remoteOid: '0'.repeat(64), localOid: 'a'.repeat(64) }] }),
    null,
  );
});

function fixture(t, { browser = true, npmExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'styleproof-pre-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  for (const file of ['scripts/pre-push-e2e.mjs', 'scripts/ci-path-filters.mjs', '.github/path-filters.yml']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  write('.gitignore', 'node_modules/\nfake-bin/\nnpm-args\nchrome\n');
  write('node_modules/@playwright/test/package.json', '{"type":"module","exports":"./index.mjs"}');
  write(
    'node_modules/@playwright/test/index.mjs',
    `export const chromium = { executablePath: () => ${JSON.stringify(join(root, 'chrome'))} };\n`,
  );
  if (browser) write('chrome', 'browser presence fixture; never executed');
  write('fake-bin/npm', `#!/bin/sh\nprintf '%s\\n' "$@" > npm-args\nexit ${npmExit}\n`);
  chmodSync(join(root, 'fake-bin/npm'), 0o755);
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
  const run = (input = '', extraEnv = {}) => {
    rmSync(join(root, 'npm-args'), { force: true });
    return spawnSync(process.execPath, ['scripts/pre-push-e2e.mjs'], {
      cwd: root,
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}`, ...extraEnv },
    });
  };
  const pushed = (localOid = base, remoteOid = base, localRef = 'HEAD') =>
    `${localRef} ${localOid} refs/heads/test ${remoteOid}\n`;
  const npmArgs = () => (existsSync(join(root, 'npm-args')) ? readFileSync(join(root, 'npm-args'), 'utf8') : null);
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
      'import { collectPrePushFiles } from "./scripts/pre-push-e2e.mjs"; ' +
        'console.log(JSON.stringify(collectPrePushFiles({ pushRanges: [] })));',
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
  assert.equal(collected.status, 0, collected.stderr);
  assert.deepEqual(JSON.parse(collected.stdout).sort(), files.sort());
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
        'import { collectPrePushFiles } from "./scripts/pre-push-e2e.mjs"; ' +
          `console.log(JSON.stringify(collectPrePushFiles({ stagedFiles: [], pushRanges: [{ remoteOid: ${JSON.stringify(base)}, localOid: ${JSON.stringify(head)} }] })));`,
      ],
      { cwd: f.root, encoding: 'utf8' },
    );
    assert.equal(collected.status, 0, collected.stderr);
    assert.deepEqual(JSON.parse(collected.stdout), [file]);
    assert.deepEqual(Buffer.from(JSON.parse(collected.stdout)[0]), Buffer.from(file));
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

test('empty or malformed shared policy aborts the real hook process, including an empty diff', (t) => {
  const f = fixture(t);
  for (const text of ['', 'lanes:\n', "lanes:\n  - '**'\n", "lanes:\n  - '!README.md'\n"]) {
    f.write('.github/path-filters.yml', text);
    const head = f.commit();
    const result = f.run(f.pushed(head, head));
    assert.equal(result.status, 1, JSON.stringify(text) + result.stdout + result.stderr);
    assert.match(result.stderr, /lanes/);
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
  assert.match(missingRange.stderr, /git diff .*failed/i);
  f.write('fake-bin/git', '#!/bin/sh\necho "fixture Git failed" >&2\nexit 69\n');
  chmodSync(join(f.root, 'fake-bin/git'), 0o755);
  const brokenGit = f.run(f.pushed());
  assert.equal(brokenGit.status, 1, brokenGit.stdout + brokenGit.stderr);
  assert.match(brokenGit.stderr, /fixture Git failed/);
  assert.equal(f.npmArgs(), null);
});
