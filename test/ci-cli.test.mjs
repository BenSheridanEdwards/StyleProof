import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ciOutputLines, classifyRestoreExit, detectPackageManagerPlan } from '../dist/ci.js';
import {
  applySpecRefOverlay,
  assertSpecAtRef,
  normalizeRepoRelativeSpec,
  resolveSpecRefToSha,
  shouldApplySpecRefOverlay,
} from '../dist/ci-spec-ref.js';
import { CiWorktreeSession } from '../dist/ci-worktree.js';
import { workingTreeDirty } from '../dist/map-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

// styleproof-ci packages the workflow's restore → capture-on-miss → replay →
// publish bash. The decision rules the old init.test.mjs asserted against the
// generated bash are pinned here against the module instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const CI = path.join(here, '..', 'bin', 'styleproof-ci.mjs');

function runCi(args, env = {}, cwd) {
  const merged = { ...process.env, ...env };
  // The driver keys its CI guard on this exact variable.
  if (!('CI' in env)) delete merged.CI;
  return spawnSync(process.execPath, [CI, ...args], { encoding: 'utf8', env: merged, cwd });
}

function realGitPath() {
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, which.stderr);
  return which.stdout.trim();
}

/** Prepend a git wrapper on PATH for styleproof-ci subprocesses (setup still uses real git). */
function ciEnvWithGitWrapper(root, wrapperBody, env = {}) {
  const bin = path.join(root, 'git-bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
${wrapperBody}
exec "$STYLEPROOF_CI_REAL_GIT" "$@"
`;
  fs.writeFileSync(path.join(bin, 'git'), script);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return {
    ...env,
    STYLEPROOF_CI_REAL_GIT: realGitPath(),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

test('classifyRestoreExit: 0 hit, 4 genuine miss, anything else a loud fault', () => {
  assert.equal(classifyRestoreExit(0), 'hit');
  assert.equal(classifyRestoreExit(4), 'miss');
  // Neither 0 nor 4 is a PERSISTENT map-store/network fault (the restore CLI
  // already retried): fail loudly instead of silently paying a cold recapture.
  assert.equal(classifyRestoreExit(5), 'fault');
  assert.equal(classifyRestoreExit(1), 'fault');
  assert.equal(classifyRestoreExit(137), 'fault');
  assert.equal(classifyRestoreExit(null), 'fault', 'a killed child never reads as a verdict');
  assert.equal(classifyRestoreExit(undefined), 'fault');
});

test('ciOutputLines: the exact steps.maps.outputs.* contract the workflow bash emitted', () => {
  assert.deepEqual(ciOutputLines(true, true), [
    'base-hit=true',
    'head-hit=true',
    'capture-needed=false',
    'base-capture-failed=false',
  ]);
  assert.deepEqual(ciOutputLines(true, false), [
    'base-hit=true',
    'head-hit=false',
    'capture-needed=true',
    'base-capture-failed=false',
  ]);
  assert.deepEqual(ciOutputLines(false, false, true), [
    'base-hit=false',
    'head-hit=false',
    'capture-needed=true',
    'base-capture-failed=true',
  ]);
});

test('detectPackageManagerPlan: lockfile detection at RUN time, commands as argv (no shell)', () => {
  const root = mkTmp('styleproof-ci-pm-');
  try {
    // npm by default; its --no-save/--package-lock=false exact install dirties nothing.
    const npm = detectPackageManagerPlan(root);
    assert.equal(npm.name, 'npm');
    assert.deepEqual(npm.install, ['npm', 'ci']);
    assert.deepEqual(npm.installExactStyleProof('9.9.9'), [
      'npm',
      'install',
      '--no-save',
      '--package-lock=false',
      'styleproof@9.9.9',
    ]);
    assert.deepEqual(npm.packageMetadataFiles, []);

    fs.writeFileSync(path.join(root, 'yarn.lock'), '');
    const yarn = detectPackageManagerPlan(root);
    assert.equal(yarn.name, 'yarn');
    assert.deepEqual(yarn.install, ['npx', '-y', 'yarn@1.22.22', 'install', '--frozen-lockfile', '--non-interactive']);
    assert.ok(yarn.installExactStyleProof('9.9.9').includes('styleproof@9.9.9'));
    assert.deepEqual(yarn.packageMetadataFiles, ['package.json', 'yarn.lock']);

    // pnpm outranks yarn when both lockfiles exist.
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    const pnpm = detectPackageManagerPlan(root);
    assert.equal(pnpm.name, 'pnpm');
    assert.deepEqual(pnpm.installExactStyleProof('1.2.3'), [
      'pnpm',
      'add',
      '--save-dev',
      '--save-exact',
      'styleproof@1.2.3',
    ]);
    assert.deepEqual(pnpm.packageMetadataFiles, ['package.json', 'pnpm-lock.yaml']);

    // Yarn Berry: a .yarnrc.yml (or packageManager yarn@2+) must NOT get the
    // pinned yarn 1 — Berry repos refuse it / can't parse the lockfile. Corepack
    // reads the repo's own pin and provisions the right release.
    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    const berry = detectPackageManagerPlan(root);
    assert.equal(berry.name, 'yarn-berry');
    assert.deepEqual(berry.install, ['corepack', 'yarn', 'install', '--immutable']);
    assert.deepEqual(berry.installExactStyleProof('9.9.9'), [
      'corepack',
      'yarn',
      'add',
      '--dev',
      '--exact',
      'styleproof@9.9.9',
    ]);
    assert.deepEqual(berry.packageMetadataFiles, ['package.json', 'yarn.lock']);
    fs.rmSync(path.join(root, '.yarnrc.yml'));

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.5.0' }));
    assert.equal(detectPackageManagerPlan(root).name, 'yarn-berry');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@1.22.22' }));
    assert.equal(detectPackageManagerPlan(root).name, 'yarn', 'a yarn 1 pin keeps the classic plan');
    fs.rmSync(path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');

    // bun outranks everything; only the bun lockfile that actually exists is restored.
    fs.writeFileSync(path.join(root, 'bun.lockb'), '');
    const bun = detectPackageManagerPlan(root);
    assert.equal(bun.name, 'bun');
    assert.deepEqual(bun.install, ['bun', 'install', '--frozen-lockfile']);
    assert.deepEqual(bun.packageMetadataFiles, ['package.json', 'bun.lockb']);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: refuses to run outside CI without --force (it force-checkouts commits)', () => {
  const res = runCi(['--base', 'a'.repeat(40), '--head', 'b'.repeat(40)]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /refusing to run outside CI/);
  assert.match(res.stderr, /--force/);
});

test('styleproof-ci: usage errors exit 2', () => {
  assert.equal(runCi([]).status, 2, 'missing --base/--head');
  assert.match(runCi([]).stderr, /--base <sha> and --head <sha> are required/);
  assert.equal(runCi(['--base', 'x', '--head', 'y', '--nope']).status, 2, 'unknown flag');
});

test('styleproof-ci: --help documents --spec-ref', () => {
  const res = runCi(['--help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--spec-ref/);
  assert.match(res.stdout, /--spec <path>/);
});

test('styleproof-ci: --spec-ref requires a non-empty value', () => {
  const missing = runCi(['--base', 'x', '--head', 'y', '--spec-ref']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--spec-ref requires a non-empty git ref/);

  const empty = runCi(['--base', 'x', '--head', 'y', '--spec-ref=']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /--spec-ref requires a non-empty git ref/);
});

test('normalizeRepoRelativeSpec: rejects absolute and out-of-repo paths', () => {
  const root = mkTmp('styleproof-ci-spec-path-');
  try {
    assert.throws(() => normalizeRepoRelativeSpec('/etc/passwd', root), /--spec must be a relative path/);
    assert.throws(() => normalizeRepoRelativeSpec('../outside.spec.ts', root), /stay inside the repository/);
    assert.equal(normalizeRepoRelativeSpec('e2e/styleproof.spec.ts', root), 'e2e/styleproof.spec.ts');
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: invalid --spec-ref fails loudly before capture', () => {
  const root = mkTmp('styleproof-ci-bad-ref-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'consumer');
  const mapRoot = path.join(root, 'maps');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repo);
    git(root, ['init', '--bare', '-q', remote]);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'styleproof@example.test']);
    git(repo, ['config', 'user.name', 'StyleProof Test']);
    git(repo, ['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// head\n');
    git(repo, ['add', 'styleproof.spec.ts']);
    git(repo, ['commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);

    const bin = path.join(repo, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(bin, 'playwright'), '#!/bin/sh\nif [ "$1" = "install" ]; then exit 0; fi\nexit 0\n');
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    fs.chmodSync(path.join(bin, 'playwright'), 0o755);

    const missingRef = runCi(
      [
        '--base',
        base,
        '--head',
        head,
        '--spec',
        'styleproof.spec.ts',
        '--spec-ref',
        'not-a-real-ref',
        '--base-dir',
        mapRoot,
        '--force',
      ],
      { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' },
      repo,
    );
    assert.equal(missingRef.status, 2, missingRef.stderr);
    assert.match(missingRef.stderr, /could not resolve --spec-ref/);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), head, 'consumer checkout never visits --base');
    assert.equal(fs.readFileSync(path.join(repo, 'styleproof.spec.ts'), 'utf8'), '// head\n');
  } finally {
    rmTmp(root);
  }
});

test(
  'styleproof-ci: --spec-ref overlays head spec bytes for base capture and restores before head',
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-spec-ref-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const output = path.join(root, 'github-output');
    const pmLog = path.join(root, 'package-managers');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.mkdirSync(path.join(repo, 'tests', 'e2e'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'tests', 'e2e', 'styleproof.spec.ts'), 'SPEC_BYTES=BASE\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'base-app\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.writeFileSync(
        path.join(repo, 'tests', 'e2e', 'styleproof.spec.ts'),
        "import './head-only-fixture';\nSPEC_BYTES=HEAD\n",
      );
      fs.writeFileSync(path.join(repo, 'tests', 'e2e', 'head-only-fixture.ts'), 'HEAD_ONLY_FIXTURE=true\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'head-app\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: head']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\ngit rev-parse HEAD >> "$PM_LOG"\nexit 0\n');
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
if [ "$(git rev-parse HEAD)" = "$BASE_FAIL_SHA" ]; then exit 1; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
if [ -f tests/e2e/styleproof.spec.ts ]; then cp tests/e2e/styleproof.spec.ts "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-spec.ts"; fi
if [ -f tests/e2e/head-only-fixture.ts ]; then cp tests/e2e/head-only-fixture.ts "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-fixture.ts"; fi
if [ -f app.txt ]; then cp app.txt "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-app.txt"; fi
git status --porcelain > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/git-status.txt" || true
`,
      );
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      const result = runCi(
        [
          '--base',
          base,
          '--head',
          head,
          '--spec',
          'tests/e2e/styleproof.spec.ts',
          '--spec-ref',
          head,
          '--base-dir',
          mapRoot,
          '--force',
        ],
        {
          CI: '1',
          PM_LOG: pmLog,
          GITHUB_OUTPUT: output,
          STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1',
        },
        repo,
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
      assert.equal(
        fs.readFileSync(path.join(repo, 'tests', 'e2e', 'styleproof.spec.ts'), 'utf8'),
        "import './head-only-fixture';\nSPEC_BYTES=HEAD\n",
      );
      assert.equal(
        fs.readFileSync(path.join(mapRoot, 'base', 'captured-spec.ts'), 'utf8'),
        "import './head-only-fixture';\nSPEC_BYTES=HEAD\n",
      );
      assert.equal(
        fs.readFileSync(path.join(mapRoot, 'base', 'captured-fixture.ts'), 'utf8'),
        'HEAD_ONLY_FIXTURE=true\n',
        'cold base capture receives the head-only harness dependency',
      );
      assert.equal(fs.readFileSync(path.join(mapRoot, 'base', 'captured-app.txt'), 'utf8'), 'base-app\n');
      assert.match(
        fs.readFileSync(path.join(mapRoot, 'base', 'git-status.txt'), 'utf8'),
        /tests\/e2e\/head-only-fixture\.ts/,
        'the head-only file is physically present while dirtyAllow keeps the map publishable',
      );
      const installedAt = fs.readFileSync(pmLog, 'utf8').trim().split('\n');
      assert.equal(installedAt[0], base, 'base install runs at the base commit');
      assert.equal(installedAt.at(-1), head, 'head install runs at the head commit');
      assert.match(result.stderr, /overlaying 2 spec-harness file\(s\) from/);
    } finally {
      rmTmp(root);
    }
  },
);

test(
  'styleproof-ci: symbolic --spec-ref resolves in the consumer; base spawns prefer the worktree install',
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-symbolic-ref-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=BASE\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=HEAD\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: head']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      // The base-side install (cwd = the cold-base worktree) plants the worktree's
      // OWN playwright, marking captures "worktree". It must never clobber the
      // consumer's install, which marks captures "consumer".
      fs.writeFileSync(
        path.join(bin, 'npm'),
        `#!/bin/sh
if [ ! -f node_modules/.bin/playwright ]; then
  mkdir -p node_modules/.bin
  cat > node_modules/.bin/playwright <<'EOF'
#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
cp styleproof.spec.ts "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-spec.ts"
printf 'worktree' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/resolved-from.txt"
EOF
  chmod +x node_modules/.bin/playwright
fi
exit 0
`,
      );
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
cp styleproof.spec.ts "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-spec.ts"
printf 'consumer' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/resolved-from.txt"
`,
      );
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      // Symbolic HEAD: in the detached base worktree HEAD *is* --base, so before
      // the fix this silently overlaid the base's own spec (SPEC_BYTES=BASE).
      const result = runCi(
        [
          '--base',
          base,
          '--head',
          head,
          '--spec',
          'styleproof.spec.ts',
          '--spec-ref',
          'HEAD',
          '--base-dir',
          mapRoot,
          '--force',
        ],
        { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' },
        repo,
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stderr, new RegExp(`--spec-ref HEAD resolved to ${head}`));
      assert.equal(
        fs.readFileSync(path.join(mapRoot, 'base', 'captured-spec.ts'), 'utf8'),
        'SPEC_BYTES=HEAD\n',
        'symbolic HEAD means the CONSUMER head, not the base worktree HEAD',
      );
      assert.equal(
        fs.readFileSync(path.join(mapRoot, 'base', 'resolved-from.txt'), 'utf8'),
        'worktree',
        'base capture resolves playwright from the worktree install first',
      );
      assert.equal(
        fs.readFileSync(path.join(mapRoot, 'head', 'resolved-from.txt'), 'utf8'),
        'consumer',
        'head capture keeps resolving from the consumer install',
      );
    } finally {
      rmTmp(root);
    }
  },
);

test(
  "styleproof-ci: the HEAD commit's styleproof.config.json governs the run, not the invoking checkout",
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-head-config-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      // Base: spec at old.spec.ts, config points there.
      fs.writeFileSync(path.join(repo, 'old.spec.ts'), '// old spec\n');
      fs.writeFileSync(path.join(repo, 'styleproof.config.json'), '{"spec":"old.spec.ts"}\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      // Head: the spec MOVED via config alone — no --spec flag anywhere.
      git(repo, ['mv', 'old.spec.ts', 'new.spec.ts']);
      fs.writeFileSync(path.join(repo, 'styleproof.config.json'), '{"spec":"new.spec.ts"}\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: head moves the spec']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);
      // The invoking checkout sits at BASE — the stand-in for the PR merge
      // commit the workflow checks out, which is NOT the head.
      git(repo, ['checkout', '-q', base]);

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
`,
      );
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      const result = runCi(
        ['--base', base, '--head', head, '--base-dir', mapRoot, '--force'],
        { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' },
        repo,
      );
      // Before the fix, config was read from the pre-checkout tree (base here):
      // spec resolved to old.spec.ts, which the head no longer has — exit 2.
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
      assert.ok(fs.existsSync(path.join(mapRoot, 'head', 'home@900.json')));
    } finally {
      rmTmp(root);
    }
  },
);

test('CiWorktreeSession: construction prunes stale worktree registrations from a prior hard kill', () => {
  const root = mkTmp('styleproof-ci-prune-');
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'styleproof@example.test']);
    git(['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'test: one']);
    // A prior run's worktree whose scratch dir a SIGKILL left deleted but registered.
    const stale = path.join(root, 'stale-wt');
    git(['worktree', 'add', '--detach', stale, 'HEAD']);
    fs.rmSync(stale, { recursive: true, force: true });
    assert.match(git(['worktree', 'list']), /stale-wt/);

    const session = new CiWorktreeSession(repo, path.join(root, 'scratch'));
    try {
      assert.doesNotMatch(git(['worktree', 'list']), /stale-wt/, 'session start reclaims the residue');
    } finally {
      session.dispose();
    }
  } finally {
    rmTmp(root);
  }
});

test('resolveSpecRefToSha: resolves refs in the given checkout, rejects the unresolvable', () => {
  const root = mkTmp('styleproof-ci-resolve-ref-');
  try {
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'styleproof@example.test']);
    git(['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'test: one']);
    const sha = git(['rev-parse', 'HEAD']);
    assert.equal(resolveSpecRefToSha('HEAD', root), sha);
    assert.equal(resolveSpecRefToSha('main', root), sha);
    assert.equal(resolveSpecRefToSha(sha, root), sha, 'an explicit SHA resolves to itself');
    assert.throws(() => resolveSpecRefToSha('no-such-ref', root), /could not resolve --spec-ref no-such-ref/);
  } finally {
    rmTmp(root);
  }
});

test(
  'styleproof-ci: base capture failure still restores spec-ref overlay before head capture',
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-spec-ref-restore-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const probe = path.join(root, 'spec-ref-probe.txt');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=BASE\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=HEAD\n');
      git(repo, ['add', 'styleproof.spec.ts']);
      git(repo, ['commit', '-qm', 'head']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
if [ "$(git rev-parse HEAD)" = "$BASE_FAIL_SHA" ]; then
  mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
  if [ -f styleproof.spec.ts ] && [ -n "$SPEC_REF_PROBE" ]; then cp styleproof.spec.ts "$SPEC_REF_PROBE"; fi
  exit 1
fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
`,
      );
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      const result = runCi(
        [
          '--base',
          base,
          '--head',
          head,
          '--spec',
          'styleproof.spec.ts',
          '--spec-ref',
          head,
          '--base-dir',
          mapRoot,
          '--force',
        ],
        {
          CI: '1',
          BASE_FAIL_SHA: base,
          SPEC_REF_PROBE: probe,
          STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1',
          STYLEPROOF_SUPPRESS_PLATFORM_WARNING: '1',
        },
        repo,
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(fs.readFileSync(path.join(repo, 'styleproof.spec.ts'), 'utf8'), 'SPEC_BYTES=HEAD\n');
      assert.equal(
        fs.readFileSync(probe, 'utf8'),
        'SPEC_BYTES=HEAD\n',
        'base capture saw the overlaid head spec bytes before failure cleanup',
      );
      assert.ok(fs.existsSync(path.join(mapRoot, 'head', 'home@900.json')));
    } finally {
      rmTmp(root);
    }
  },
);

test('shouldApplySpecRefOverlay: only overlays when the base tree already has the spec', () => {
  assert.equal(shouldApplySpecRefOverlay(true, 'head-sha'), true);
  assert.equal(shouldApplySpecRefOverlay(false, 'head-sha'), false);
  assert.equal(shouldApplySpecRefOverlay(true, ''), false);
});

test('applySpecRefOverlay: missing spec at ref is a usage error', () => {
  const root = mkTmp('styleproof-ci-missing-spec-at-ref-');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'styleproof.spec.ts'), '// only on main\n');
    git(root, ['add', 'styleproof.spec.ts']);
    git(root, ['commit', '-qm', 'main']);
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', '--orphan', 'base']);
    fs.writeFileSync(path.join(root, 'styleproof.spec.ts'), '// base tree\n');
    git(root, ['add', 'styleproof.spec.ts']);
    git(root, ['commit', '-qm', 'base']);
    git(root, ['checkout', '-q', 'main']);
    assert.throws(
      () => assertSpecAtRef('missing.spec.ts', head, root),
      /--spec missing\.spec\.ts is missing at --spec-ref/,
    );
    assert.throws(
      () => applySpecRefOverlay({ spec: 'missing.spec.ts', specRef: head, cwd: root }),
      /missing at --spec-ref/,
    );
  } finally {
    rmTmp(root);
  }
});

test('applySpecRefOverlay: resolves a cwd-relative spec when run from a repo subdirectory', () => {
  // The consumer regression shape: `working-directory: hud` + `--spec tests/e2e/….spec.ts`.
  // Bare `<rev>:<path>` resolves from the repo ROOT, so the overlay reported a
  // spec that exists as "missing at --spec-ref". Every lookup must use git's
  // cwd-relative `<rev>:./<path>` form instead.
  const root = mkTmp('styleproof-ci-spec-ref-subdir-');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    const specAbs = path.join(root, 'hud', 'tests', 'e2e', 'styleproof.spec.ts');
    const headOnlyFixture = path.join(root, 'hud', 'tests', 'e2e', 'head-only-fixture.ts');
    fs.mkdirSync(path.dirname(specAbs), { recursive: true });
    fs.writeFileSync(specAbs, '// base spec\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'base']);
    fs.writeFileSync(specAbs, "import './head-only-fixture';\n// head spec\n");
    fs.writeFileSync(headOnlyFixture, 'export const headOnlyFixture = true;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'head']);
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'HEAD~1']);

    const subdir = path.join(root, 'hud');
    const overlay = applySpecRefOverlay({ spec: 'tests/e2e/styleproof.spec.ts', specRef: head, cwd: subdir });
    assert.equal(
      fs.readFileSync(specAbs, 'utf8'),
      "import './head-only-fixture';\n// head spec\n",
      'overlays the head bytes',
    );
    assert.equal(fs.readFileSync(headOnlyFixture, 'utf8'), 'export const headOnlyFixture = true;\n');
    assert.deepEqual(overlay.dirtyAllow, ['hud/tests/e2e']);
    assert.equal(
      workingTreeDirty(subdir, overlay.dirtyAllow),
      false,
      'cwd-relative dirty allowances cover head-only harness files when the CLI runs from a repo subdirectory',
    );
    overlay.restore();
    assert.equal(fs.readFileSync(specAbs, 'utf8'), '// base spec\n', 'restore returns the base bytes');
    assert.equal(fs.existsSync(headOnlyFixture), false, 'restore removes head-only harness files');
    const status = git(root, ['status', '--porcelain']);
    assert.equal(status, '', 'no assume-unchanged residue after restore');
  } finally {
    rmTmp(root);
  }
});

test('applySpecRefOverlay: includes head-only files beside the spec and restores the base harness', () => {
  const root = mkTmp('styleproof-ci-spec-ref-harness-');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'styleproof@example.test']);
    git(root, ['config', 'user.name', 'StyleProof Test']);
    const harnessDirectory = path.join(root, 'tests', 'e2e');
    const spec = path.join(harnessDirectory, 'styleproof.spec.ts');
    const existingFixture = path.join(harnessDirectory, 'existing-fixture.ts');
    const headOnlyFixture = path.join(harnessDirectory, 'head-only-fixture.ts');
    const baseApplication = path.join(root, 'src', 'application.ts');
    fs.mkdirSync(harnessDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(baseApplication), { recursive: true });
    fs.writeFileSync(spec, "import './existing-fixture';\n");
    fs.writeFileSync(existingFixture, 'export const fixture = "base";\n');
    fs.writeFileSync(baseApplication, 'export const application = "base";\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'test: base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(spec, "import './existing-fixture';\nimport './head-only-fixture';\n");
    fs.writeFileSync(existingFixture, 'export const fixture = "head";\n');
    fs.writeFileSync(headOnlyFixture, 'export const headOnlyFixture = true;\n');
    fs.writeFileSync(baseApplication, 'export const application = "head";\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'test: head']);
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', base]);

    const overlay = applySpecRefOverlay({ spec: 'tests/e2e/styleproof.spec.ts', specRef: head, cwd: root });
    assert.equal(fs.readFileSync(existingFixture, 'utf8'), 'export const fixture = "head";\n');
    assert.equal(fs.readFileSync(headOnlyFixture, 'utf8'), 'export const headOnlyFixture = true;\n');
    assert.equal(
      fs.readFileSync(baseApplication, 'utf8'),
      'export const application = "base";\n',
      'application code stays pinned to the base commit',
    );
    assert.deepEqual(overlay.dirtyAllow, ['tests/e2e']);
    assert.equal(workingTreeDirty(root, overlay.dirtyAllow), false, 'the deliberate harness overlay stays publishable');

    overlay.restore();
    assert.equal(fs.readFileSync(spec, 'utf8'), "import './existing-fixture';\n");
    assert.equal(fs.readFileSync(existingFixture, 'utf8'), 'export const fixture = "base";\n');
    assert.equal(fs.existsSync(headOnlyFixture), false, 'head-only harness files are removed');
    assert.equal(git(root, ['status', '--porcelain']), '', 'restore leaves no index or worktree residue');
  } finally {
    rmTmp(root);
  }
});

test(
  'styleproof-ci: a base capture failure degrades to a bare baseline while head stays fail-closed',
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-degraded-base-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const output = path.join(root, 'github-output');
    const pmLog = path.join(root, 'package-managers');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// capture fixture\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'base\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.rmSync(path.join(repo, 'pnpm-lock.yaml'));
      fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'head\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: head']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\ngit rev-parse HEAD >> "$PM_LOG"\nexit 0\n');
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\ngit rev-parse HEAD >> "$PM_LOG"\nexit 0\n');
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
if [ "$(git rev-parse HEAD)" = "$BASE_FAIL_SHA" ]; then
  # Leave map debris behind the failure: an untolerated failure with maps on
  # disk must be discarded, never kept as a lying "partial baseline".
  mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
  printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
  exit 1
fi
if [ -n "$HEAD_FAIL_SHA" ] && [ "$(git rev-parse HEAD)" = "$HEAD_FAIL_SHA" ]; then exit 1; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
`,
      );
      fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      const result = runCi(
        ['--base', base, '--head', head, '--spec', 'styleproof.spec.ts', '--base-dir', mapRoot],
        {
          CI: '1',
          BASE_FAIL_SHA: base,
          PM_LOG: pmLog,
          GITHUB_OUTPUT: output,
          STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1',
        },
        repo,
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head, 'the consumer checkout is restored to the PR head');
      assert.deepEqual(
        fs.readdirSync(path.join(mapRoot, 'base')),
        [],
        'partial base output is replaced by a bare baseline',
      );
      assert.ok(fs.existsSync(path.join(mapRoot, 'head', 'home@900.json')));
      assert.ok(fs.existsSync(path.join(mapRoot, 'head', 'styleproof-manifest.json')));
      const outputs = fs.readFileSync(output, 'utf8');
      assert.match(outputs, /base-hit=false/);
      assert.match(outputs, /head-hit=false/);
      assert.match(outputs, /capture-needed=true/);
      assert.match(outputs, /base-capture-failed=true/);
      assert.match(result.stderr, /surface map\(s\) on disk but no publishable manifest — discarding the debris/);
      assert.match(result.stderr, /base capture failed .* continuing with a bare baseline/);
      const installedAt = fs.readFileSync(pmLog, 'utf8').trim().split('\n');
      assert.ok(installedAt.includes(base), 'the base commit uses its pnpm lockfile');
      assert.equal(installedAt.at(-1), head, 'the head commit re-detects and uses its npm lockfile');

      // Repeat without the newly published cache and make the head fail too. The
      // degraded base remains useful evidence, but a missing head is never publishable.
      git(repo, ['push', '-q', 'origin', '--delete', 'styleproof-maps']);
      const failedOutput = path.join(root, 'failed-github-output');
      const headFailure = runCi(
        ['--base', base, '--head', head, '--spec', 'styleproof.spec.ts', '--base-dir', mapRoot],
        {
          CI: '1',
          BASE_FAIL_SHA: base,
          HEAD_FAIL_SHA: head,
          GITHUB_OUTPUT: failedOutput,
          PM_LOG: pmLog,
          STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1',
        },
        repo,
      );
      assert.equal(headFailure.status, 1, headFailure.stderr + headFailure.stdout);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.existsSync(failedOutput), false, 'a failed head capture emits no successful map verdict');
    } finally {
      rmTmp(root);
    }
  },
);

test(
  'styleproof-ci: consumer dirty files outside the spec are not masked by base worktrees',
  { timeout: 30_000 },
  () => {
    const root = mkTmp('styleproof-ci-dirty-');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'consumer');
    const mapRoot = path.join(root, 'maps');
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      git(root, ['init', '--bare', '-q', remote]);
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'styleproof@example.test']);
      git(repo, ['config', 'user.name', 'StyleProof Test']);
      git(repo, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// capture\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// capture head\n');
      git(repo, ['add', 'styleproof.spec.ts']);
      git(repo, ['commit', '-qm', 'head']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);
      fs.writeFileSync(path.join(repo, 'local-only.txt'), 'keep-me\n');

      const bin = path.join(repo, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(
        path.join(bin, 'playwright'),
        `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
mkdir -p "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR"
printf '{}' > "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/home@900.json"
`,
      );
      fs.chmodSync(path.join(bin, 'npm'), 0o755);
      fs.chmodSync(path.join(bin, 'playwright'), 0o755);

      const result = runCi(
        ['--base', base, '--head', head, '--spec', 'styleproof.spec.ts', '--base-dir', mapRoot, '--force'],
        { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' },
        repo,
      );
      assert.equal(result.status, 2, 'head capture stays fail-closed on a dirty consumer tree');
      assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
      assert.equal(
        fs.readFileSync(path.join(repo, 'local-only.txt'), 'utf8'),
        'keep-me\n',
        'untracked local edits are not masked by base worktrees',
      );
      assert.equal(
        git(repo, ['worktree', 'list', '--porcelain'])
          .split('\n')
          .filter((line) => line.startsWith('worktree ')).length,
        1,
        'ephemeral worktrees are removed after a successful run',
      );
    } finally {
      rmTmp(root);
    }
  },
);

test('styleproof-ci: invalid --base SHA fails loudly before capture', () => {
  const root = mkTmp('styleproof-ci-bad-base-');
  const repo = path.join(root, 'consumer');
  try {
    fs.mkdirSync(repo);
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'styleproof@example.test']);
    git(repo, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const bad = runCi(
      ['--base', 'not-a-real-base', '--head', head, '--base-dir', path.join(root, 'maps'), '--force'],
      { CI: '1' },
      repo,
    );
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /could not resolve/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: invalid --head SHA fails loudly before capture', () => {
  const root = mkTmp('styleproof-ci-bad-head-');
  const repo = path.join(root, 'consumer');
  try {
    fs.mkdirSync(repo);
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'styleproof@example.test']);
    git(repo, ['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    const bad = runCi(
      ['--base', base, '--head', 'not-a-real-head', '--base-dir', path.join(root, 'maps'), '--force'],
      { CI: '1' },
      repo,
    );
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /could not resolve/);
    assert.doesNotMatch(bad.stderr, /UnhandledPromiseRejection|throw err at/i);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: mid-run worktree add failure exits 2 and removes ephemeral worktrees', () => {
  const root = mkTmp('styleproof-ci-wt-add-fail-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'consumer');
  try {
    fs.mkdirSync(repo);
    const git = (cwd, args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(root, ['init', '--bare', '-q', remote]);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'styleproof@example.test']);
    git(repo, ['config', 'user.name', 'StyleProof Test']);
    git(repo, ['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// probe\n');
    git(repo, ['add', 'README.md', 'styleproof.spec.ts']);
    git(repo, ['commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'head\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);

    const wrapper = `case "$*" in
  *worktree\\ add*probe-head*)
    echo "deliberate probe-head worktree add failure" >&2
    exit 1
    ;;
esac
`;
    const result = runCi(
      [
        '--base',
        base,
        '--head',
        head,
        '--spec',
        'styleproof.spec.ts',
        '--base-dir',
        path.join(root, 'maps'),
        '--force',
      ],
      ciEnvWithGitWrapper(root, wrapper, { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' }),
      repo,
    );
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /could not create a detached worktree/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|Error:.*\n\s+at /);
    assert.equal(
      git(repo, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      1,
      'ephemeral worktrees are removed after a mid-run worktree fault',
    );
  } finally {
    rmTmp(root);
  }
});

test('styleproof-ci: mid-run cold-base worktree add failure exits 2 after cleanup', { timeout: 30_000 }, () => {
  const root = mkTmp('styleproof-ci-cold-wt-fail-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'consumer');
  const mapRoot = path.join(root, 'maps');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repo);
    git(root, ['init', '--bare', '-q', remote]);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'styleproof@example.test']);
    git(repo, ['config', 'user.name', 'StyleProof Test']);
    git(repo, ['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), '// capture fixture\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
    fs.writeFileSync(path.join(repo, 'app.txt'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'test: base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'head\n');
    git(repo, ['add', 'app.txt']);
    git(repo, ['commit', '-qm', 'test: head']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);

    const wrapper = `case "$*" in
  *worktree\\ add*cold-base*)
    echo "deliberate cold-base worktree add failure" >&2
    exit 1
    ;;
esac
`;
    const result = runCi(
      ['--base', base, '--head', head, '--spec', 'styleproof.spec.ts', '--base-dir', mapRoot],
      ciEnvWithGitWrapper(root, wrapper, { CI: '1', STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS: '1' }),
      repo,
    );
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /could not create a detached worktree/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|Error:.*\n\s+at /);
    assert.equal(
      git(repo, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      1,
      'ephemeral worktrees are removed after a mid-run worktree fault',
    );
  } finally {
    rmTmp(root);
  }
});
