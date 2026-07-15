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
  shouldApplySpecRefOverlay,
} from '../dist/ci-spec-ref.js';
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
    assert.throws(() => normalizeRepoRelativeSpec('/etc/passwd', root), /--spec must be a repo-relative path/);
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
    assert.equal(git(repo, ['rev-parse', 'HEAD']), base, 'cold-path spec-ref failure exits before head checkout');
    assert.equal(fs.readFileSync(path.join(repo, 'styleproof.spec.ts'), 'utf8'), '// base\n');
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
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=BASE\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.styleproof/\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'base-app\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'test: base']);
      const base = git(repo, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'SPEC_BYTES=HEAD\n');
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
if [ -f styleproof.spec.ts ]; then cp styleproof.spec.ts "$STYLEPROOF_BASEDIR/$STYLEMAP_DIR/captured-spec.ts"; fi
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
          'styleproof.spec.ts',
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
      assert.equal(fs.readFileSync(path.join(repo, 'styleproof.spec.ts'), 'utf8'), 'SPEC_BYTES=HEAD\n');
      assert.equal(fs.readFileSync(path.join(mapRoot, 'base', 'captured-spec.ts'), 'utf8'), 'SPEC_BYTES=HEAD\n');
      assert.equal(fs.readFileSync(path.join(mapRoot, 'base', 'captured-app.txt'), 'utf8'), 'base-app\n');
      assert.equal(fs.readFileSync(path.join(mapRoot, 'base', 'git-status.txt'), 'utf8').trim(), '');
      const installedAt = fs.readFileSync(pmLog, 'utf8').trim().split('\n');
      assert.equal(installedAt[0], base, 'base install runs at the base commit');
      assert.equal(installedAt.at(-1), head, 'head install runs at the head commit');
      assert.match(result.stderr, /overlaying styleproof\.spec\.ts from/);
    } finally {
      rmTmp(root);
    }
  },
);

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
if [ "$(git rev-parse HEAD)" = "$BASE_FAIL_SHA" ]; then exit 1; fi
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
