import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGithub, makeGit } from '../../scripts/browser-lanes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseCss = '.subject { color: black; background: white; }\n';
const changedCss = '.subject { color: magenta; background: black; }\n';
const html = (css) => `<style>${css}</style><p class="subject">Tree proof fixture</p>\n`;
const fileCase = (id, title, name, extra = {}) => ({ id, title, name, before: baseCss, after: changedCss, ...extra });

export const contentCases = [
  fileCase('C1', 'demo HTML CSS-only edit', 'docs/demo/report.html', {
    before: html(baseCss),
    after: html(changedCss),
  }),
  ...['\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085', '\t'].flatMap((term, i) =>
    [
      `docs/theme${term}.css`,
      `src/theme${term}.css`,
      `${term}theme.css`,
      `theme.css${term}`,
      `src/${term}/theme.css`,
    ].map((name, j) => fileCase(`C2-${i + 1}-${j + 1}`, `CSS filename ${JSON.stringify(name)}`, name)),
  ),
  ...['theme.css', '\t.css', '\u0001.css', '\u0085.css'].map((name, i) =>
    fileCase(`C2-extra-${i + 1}`, `CSS filename ${JSON.stringify(name)}`, name),
  ),
  ...['.agents\\theme.css', 'docs\\demo\\report.html', '.github\\ISSUE_TEMPLATE\\theme.css'].map((name, i) =>
    fileCase(`C3-${i + 1}`, `literal backslash ${JSON.stringify(name)}`, name),
  ),
  ...[false, true].map((initialized) => ({
    id: `C4-${initialized ? 'initialized' : 'uninitialized'}`,
    title: `gitmodules ignore=all, ${initialized ? 'initialized' : 'uninitialized'}`,
    gitlink: 'update',
    ignore: 'modules',
    initialized,
  })),
  ...['diff', 'local'].map((ignore) => ({
    id: `C5-${ignore}`,
    title: `${ignore} config ignores submodule`,
    gitlink: 'update',
    ignore,
  })),
  { id: 'C6-add', title: 'gitlink added without gitmodules', gitlink: 'add' },
  { id: 'C6-remove', title: 'gitlink removed', gitlink: 'remove' },
  fileCase('C7-bytes', 'non-UTF-8 filename', Buffer.from('7468656d65ff2e637373', 'hex'), { plumbingMerge: true }),
  fileCase('C7-unicode', 'NFC filename renamed to NFD', '\u00e9.css', {
    target: 'e\u0301.css',
    after: baseCss,
    plumbingMerge: true,
  }),
  fileCase('C7-long', '4096-byte path', `${'a/'.repeat(2045)}ab.css`, { plumbingMerge: true }),
  ...['-x.css', '!x.css', '#x.css', '*.css', '[a].css', '{a,b}.css', '"q".css', ' lead.css', 'trail.css '].map(
    (name, i) => fileCase(`C7-name-${i + 1}`, `special filename ${JSON.stringify(name)}`, name),
  ),
  fileCase('C8-exec', 'executable mode only', 'theme.css', { after: baseCss, afterMode: '100755' }),
  fileCase('C8-symlink', 'symlink retarget', 'theme.css', {
    before: 'black.css',
    after: 'magenta.css',
    beforeMode: '120000',
    afterMode: '120000',
  }),
  fileCase('C8-file-symlink', 'file becomes symlink', 'theme.css', { after: 'magenta.css', afterMode: '120000' }),
  { id: 'C8-file-gitlink', title: 'file becomes gitlink', gitlink: 'file' },
  fileCase('C8-directory', 'file becomes directory', 'theme.css', { target: 'theme.css/child.css' }),
  fileCase('C9-case', 'case-only rename', 'Theme.css', { target: 'theme.css', after: baseCss }),
  fileCase('C9-into-docs', 'rename into docs', 'theme.css', { target: 'docs/theme.css', after: baseCss }),
  fileCase('C9-out-of-docs', 'rename out of docs', 'docs/theme.css', { target: 'theme.css', after: baseCss }),
  fileCase('C9-remove', 'delete stylesheet', 'theme.css', { remove: true }),
  fileCase('C10-attributes', 'attributes-only change', '.gitattributes', {
    before: '*.css text\n',
    after: '*.css -diff\n',
  }),
  fileCase('C10-lfs', 'LFS pointer change', 'theme.css', {
    before: `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 12\n`,
    after: `version https://git-lfs.github.com/spec/v1\noid sha256:${'2'.repeat(64)}\nsize 12\n`,
  }),
  ...['-diff', 'binary'].map((attribute) =>
    fileCase(`C10-${attribute}`, `${attribute} stylesheet change`, 'theme.css', { attributes: `*.css ${attribute}\n` }),
  ),
  fileCase('C10-drivers', 'external diff and textconv cannot hide changed CSS', 'theme.css', {
    attributes: '*.css diff=empty\n',
    drivers: true,
  }),
  fileCase('C11-readme', 'README-only change', 'README.md', { before: '# Example\n', after: '# Updated example\n' }),
  fileCase('C11-changelog', 'CHANGELOG-only change', 'CHANGELOG.md', {
    before: '# Changes\n',
    after: '# Changes\nNew release.\n',
  }),
];

export function createFixture(t, options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-tree-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, 'repo');
  fs.mkdirSync(directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (args, opts = {}) => {
    const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8', ...opts });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout;
  };
  git(['init', '-q', ...(options.format ? [`--object-format=${options.format}`] : [])]);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Tree fixture']);
  git(['config', 'commit.gpgSign', 'false']);
  const blob = (contents) => git(['hash-object', '-w', '--stdin'], { input: contents });
  const setEntry = (name, mode, contents) => {
    const oid = mode === '160000' ? contents : blob(contents);
    const record = Buffer.concat([Buffer.from(`${mode} ${oid}\t`), Buffer.from(name), Buffer.from([0])]);
    git(['update-index', '--add', '-z', '--index-info'], { input: record });
  };
  const removeEntry = (name) => {
    const record = Buffer.concat([
      Buffer.from(`0 ${'0'.repeat(options.format === 'sha256' ? 64 : 40)}\t`),
      Buffer.from(name),
      Buffer.from([0]),
    ]);
    git(['update-index', '-z', '--index-info'], { input: record });
  };
  const commit = (parents = [], message = 'fixture') =>
    git(['commit-tree', git(['write-tree']), ...parents.flatMap((oid) => ['-p', oid]), '-m', message]);
  return { workspace, directory, git, env, blob, setEntry, removeEntry, commit };
}

export function createContentFixture(t, row) {
  const fixture = createFixture(t);
  const { git, setEntry, removeEntry, commit, workspace } = fixture;
  setEntry('fixture.txt', '100644', 'stable tree fixture\n');
  if (row.gitlink) {
    const child = path.join(workspace, 'child');
    fs.mkdirSync(child);
    const childGit = (args, input) => {
      const result = spawnSync('git', args, { cwd: child, env: fixture.env, encoding: 'utf8', input });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    childGit(['init', '-q']);
    childGit(['config', 'user.email', 'fixture@example.test']);
    childGit(['config', 'user.name', 'Tree fixture']);
    childGit(['config', 'commit.gpgSign', 'false']);
    for (const css of [baseCss, changedCss]) {
      fs.writeFileSync(path.join(child, 'theme.css'), css);
      childGit(['add', 'theme.css']);
      childGit(['commit', '-qm', css === baseCss ? 'base css' : 'changed css']);
    }
    fixture.childBase = childGit(['rev-parse', 'HEAD^']);
    fixture.childHead = childGit(['rev-parse', 'HEAD']);
    if (row.gitlink === 'file') setEntry('styles', '100644', baseCss);
    else if (row.gitlink !== 'add') setEntry('styles', '160000', fixture.childBase);
    if (row.ignore)
      setEntry(
        '.gitmodules',
        '100644',
        `[submodule "styles"]\n\tpath = styles\n\turl = ${child}\n${row.ignore === 'modules' ? '\tignore = all\n' : ''}`,
      );
    if (row.ignore === 'diff') git(['config', 'diff.ignoreSubmodules', 'all']);
    if (row.ignore === 'local') git(['config', 'submodule.styles.ignore', 'all']);
    fixture.base = commit([], 'base');
    if (row.gitlink === 'remove' || row.gitlink === 'file') removeEntry('styles');
    if (row.gitlink !== 'remove') setEntry('styles', '160000', fixture.childHead);
    fixture.head = commit([fixture.base], 'changed gitlink');
  } else {
    if (row.attributes) setEntry('.gitattributes', '100644', row.attributes);
    setEntry(row.name, row.beforeMode ?? '100644', row.before ?? baseCss);
    fixture.base = commit([], 'base');
    if (row.remove || row.target) removeEntry(row.name);
    if (!row.remove) setEntry(row.target ?? row.name, row.afterMode ?? '100644', row.after ?? changedCss);
    fixture.head = commit([fixture.base], 'changed content');
    if (row.drivers) {
      git(['config', 'diff.external', 'true']);
      git(['config', 'diff.empty.textconv', 'true']);
    }
  }
  fixture.baseTree = git(['rev-parse', `${fixture.base}^{tree}`]);
  fixture.headTree = git(['rev-parse', `${fixture.head}^{tree}`]);
  assert.notEqual(fixture.baseTree, fixture.headTree, row.id);
  if (row.plumbingMerge) {
    // These paths are legal tree bytes but cannot all be checked out on every supported filesystem.
    fixture.merge = commit([fixture.base, fixture.head], 'merge raw byte paths');
    git(['update-ref', 'refs/heads/base', fixture.merge]);
    git(['symbolic-ref', 'HEAD', 'refs/heads/base']);
  } else {
    git(['read-tree', fixture.base]);
    git(['checkout', '-q', '-B', 'base', fixture.base]);
    git(['merge', '--no-ff', '-m', 'merge fixture', fixture.head]);
    fixture.merge = git(['rev-parse', 'HEAD']);
  }
  if (row.initialized) git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
  assert.equal(git(['rev-parse', `${fixture.merge}^{tree}`]), fixture.headTree);
  return fixture;
}

export function runHosted(fixture, options = {}) {
  const eventName = options.eventName ?? 'pull_request';
  const sha = options.sha ?? fixture.merge;
  const event = options.event ?? { pull_request: { base: { sha: fixture.base } } };
  const eventPath = path.join(fixture.workspace, 'event.json');
  const outputPath = path.join(fixture.workspace, 'output.txt');
  fs.writeFileSync(eventPath, options.rawEvent ?? JSON.stringify(event));
  fs.writeFileSync(outputPath, '');
  const env = {
    ...fixture.env,
    ...options.env,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_SHA: sha,
    GITHUB_EVENT_PATH: options.eventPath ?? eventPath,
    GITHUB_OUTPUT: options.outputPath ?? outputPath,
  };
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/browser-lanes.mjs'), '--github'], {
    cwd: fixture.directory,
    env,
    encoding: 'utf8',
  });
  const output = Object.fromEntries(
    fs
      .readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  const decision = decideGithub({ eventName, sha, event, git: makeGit(fixture.directory) });
  return { decision, output, status: result.status, stderr: result.stderr };
}

export function fileChangeCase(id, name, title = name) {
  return fileCase(id, title, name);
}

export const legacyPathCases = [
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

export function trackedBrowserCases() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const tracked = listed.stdout.split('\0');
  const specs = tracked.filter((file) => file.endsWith('.e2e.spec.ts'));
  assert.ok(specs.length > 0);
  const imports = new Set();
  for (const entry of specs.concat(
    'test/helpers.mjs',
    'test/phase1-foundation-harness-lib.ts',
    'bench/detection-rate.mjs',
  )) {
    for (const [, imported] of fs
      .readFileSync(path.join(root, entry), 'utf8')
      .matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.join(path.posix.dirname(entry), imported);
      const source =
        !tracked.includes(target) && target.endsWith('.js') && tracked.includes(target.slice(0, -3) + '.ts')
          ? target.slice(0, -3) + '.ts'
          : target;
      assert.ok(fs.existsSync(path.join(root, source)), `${entry} imports existing ${source}`);
      imports.add(source);
    }
  }
  const sourceCase = (id, name) => {
    const before = fs.readFileSync(path.join(root, name));
    return fileCase(id, name, name, {
      before,
      after: Buffer.concat([before, Buffer.from('\n// browser lane proof fixture change\n')]),
    });
  };
  return {
    specs: specs.map((name, i) => sourceCase(`tracked-spec-${i + 1}`, name)),
    imports: [...imports].sort().map((name, i) => sourceCase(`browser-import-${i + 1}`, name)),
  };
}
