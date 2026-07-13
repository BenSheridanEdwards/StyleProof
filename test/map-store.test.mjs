import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  assertCompatibleMapDirs,
  BROWSER_BUILD_SIDECAR,
  currentGitSha,
  manifestlessError,
  manifestlessSide,
  MAP_MANIFEST,
  publishMapBundle,
  readMapManifest,
  restoreMapBundle,
  workingTreeDirty,
  writeBrowserBuildSidecar,
  writeCaptureManifest,
  writeMapManifest,
} from '../dist/map-store.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

test('currentGitSha binds pull-request captures to the real head, not the merge commit', () => {
  const dir = mkTmp('styleproof-event-');
  const headSha = 'b'.repeat(40);
  try {
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: headSha } } }));
    assert.equal(
      currentGitSha(dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_SHA: 'a'.repeat(40),
      }),
      headSha,
    );
    assert.equal(
      currentGitSha(dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_SHA: 'a'.repeat(40),
        STYLEPROOF_SHA: 'c'.repeat(40),
      }),
      'c'.repeat(40),
      'an explicit StyleProof override wins over GitHub event metadata',
    );
  } finally {
    rmTmp(dir);
  }
});

// The event head must label ONLY the synthetic-merge checkout. A job that checks
// out any other tree (the base branch on a cache miss) keeps that tree's own SHA —
// otherwise a base-tree map uploads under the head's store key and every later
// restore of the "head" map diffs base-vs-base: a false green.
test('currentGitSha labels a non-head checkout with its own HEAD, not the event head', () => {
  const dir = mkTmp('styleproof-basecheckout-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'styleproof@example.test');
    git('config', 'user.name', 'StyleProof Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    const eventPath = path.join(dir, 'event.json');
    const headSha = 'b'.repeat(40);
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: headSha } } }));
    const env = {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: 'a'.repeat(40), // the synthetic merge commit — NOT what's checked out
    };
    assert.equal(currentGitSha(dir, env), baseSha, 'a base-branch checkout keeps its own SHA');
    assert.equal(
      currentGitSha(dir, { ...env, GITHUB_SHA: baseSha }),
      headSha,
      'a checkout of the synthetic GITHUB_SHA itself is relabeled to the real head',
    );
  } finally {
    rmTmp(dir);
  }
});

test('currentGitSha rejects a malformed explicit override instead of mislabeling', () => {
  const dir = mkTmp('styleproof-badsha-');
  try {
    assert.throws(
      () => currentGitSha(dir, { STYLEPROOF_SHA: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40) }),
      /not a commit SHA/,
    );
  } finally {
    rmTmp(dir);
  }
});

/** Write a manifest into `dir`, overriding defaults with `overrides`. */
function manifestDir(overrides = {}) {
  const dir = mkTmp('styleproof-manifest-');
  const manifest = {
    version: 1,
    packageVersion: 'test',
    sha: 'a'.repeat(40),
    dirty: false,
    spec: 'e2e/styleproof.spec.ts',
    specHash: 'test',
    platform: 'linux',
    arch: 'x64',
    nodeMajor: '20',
    screenshots: true,
    har: false,
    compatibilityKey: 'deadbeefdeadbeef',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, MAP_MANIFEST), JSON.stringify(manifest, null, 2));
  return dir;
}

test('workingTreeDirty: ignorePrefix skips the map output dir but still catches a source edit', () => {
  const repo = mkTmp('styleproof-dirty-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v1');
    fs.mkdirSync(path.join(repo, '.styleproof/maps/current'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.styleproof/maps/current/home@1280.json'), '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    assert.equal(workingTreeDirty(repo), false, 'clean tree');

    // A capture rewrites the map output — ignored by prefix, so still "clean".
    fs.writeFileSync(path.join(repo, '.styleproof/maps/current/home@1280.json'), '{"changed":1}');
    assert.equal(workingTreeDirty(repo), true, 'map write dirties the raw tree');
    assert.equal(workingTreeDirty(repo, '.styleproof/maps/current'), false, 'but is skipped by ignorePrefix');

    // A real source edit during the capture window is NOT skipped.
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v2');
    assert.equal(workingTreeDirty(repo, '.styleproof/maps/current'), true, 'source edit still caught');
  } finally {
    rmTmp(repo);
  }
});

test('publishMapBundle ignores hook-exported Git repository variables and leaves the caller non-bare', () => {
  const root = mkTmp('styleproof-hook-env-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'consumer');
  const capture = path.join(repo, '.styleproof/maps/current');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  const previousGitDirectory = process.env.GIT_DIR;
  const previousGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    fs.mkdirSync(repo);
    git(root, 'init', '--bare', '-q', remote);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'styleproof@example.test');
    git(repo, 'config', 'user.name', 'StyleProof Test');
    git(repo, 'remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'export default {};\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial consumer');

    fs.mkdirSync(capture, { recursive: true });
    fs.writeFileSync(path.join(capture, 'home@1280.json'), '{}');
    writeMapManifest({
      dir: capture,
      spec: 'styleproof.spec.ts',
      sha: git(repo, 'rev-parse', 'HEAD'),
      screenshots: false,
      dirty: false,
      cwd: repo,
    });

    // Git exports these while running hooks. Child Git commands aimed at the
    // temporary map-store checkout must not inherit them and mutate this repo.
    process.env.GIT_DIR = path.join(repo, '.git');
    process.env.GIT_WORK_TREE = repo;
    assert.doesNotThrow(() => publishMapBundle({ dir: capture, cwd: repo }));
    assert.equal(git(repo, 'config', '--bool', 'core.bare'), 'false');
    assert.match(git(root, '--git-dir', remote, 'show-ref', 'refs/heads/styleproof-maps'), /styleproof-maps/);
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
    if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousGitWorkTree;
    rmTmp(root);
  }
});

test('publishMapBundle reuses actions checkout v7 included HTTP authentication for the isolated clone and push', () => {
  const root = mkTmp('styleproof-checkout-auth-');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'consumer');
  const seed = path.join(root, 'seed');
  const capture = path.join(repo, '.styleproof/maps/current');
  const shimDirectory = path.join(root, 'bin');
  const invocationLog = path.join(root, 'git-invocations.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, stdio: 'pipe' }).toString().trim();
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.STYLEPROOF_TEST_REAL_GIT;
  const previousInvocationLog = process.env.STYLEPROOF_TEST_GIT_LOG;
  const previousMapStoreToken = process.env.STYLEPROOF_MAP_STORE_TOKEN;
  const checkoutExtraHeaderKey = ['http.https:', '', 'github.com', '.extraheader'].join('/');
  const checkoutCredentialsFile = path.join(root, 'checkout-credentials.config');
  try {
    fs.mkdirSync(repo);
    git(root, 'init', '--bare', '-q', remote);
    git(root, 'clone', '-q', remote, seed);
    git(seed, 'checkout', '-q', '-b', 'styleproof-maps');
    git(seed, 'config', 'user.email', 'styleproof@example.test');
    git(seed, 'config', 'user.name', 'StyleProof Test');
    fs.writeFileSync(path.join(seed, 'README.md'), '# StyleProof maps\n');
    fs.mkdirSync(path.join(seed, 'unseen-sha', 'unseen-compatibility'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'unseen-sha', 'unseen-compatibility', 'keep.txt'), 'keep\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed map store');
    git(seed, 'push', '-q', 'origin', 'styleproof-maps');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'styleproof@example.test');
    git(repo, 'config', 'user.name', 'StyleProof Test');
    git(
      root,
      'config',
      '--file',
      checkoutCredentialsFile,
      checkoutExtraHeaderKey,
      'AUTHORIZATION: basic fake-checkout-token',
    );
    git(repo, 'config', '--local', 'includeIf.gitdir:/github/workspace/.git.path', checkoutCredentialsFile);
    git(repo, 'remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(repo, 'styleproof.spec.ts'), 'export default {};\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial consumer');

    fs.mkdirSync(capture, { recursive: true });
    fs.writeFileSync(path.join(capture, 'home@1280.json'), '{}');
    writeMapManifest({
      dir: capture,
      spec: 'styleproof.spec.ts',
      sha: git(repo, 'rev-parse', 'HEAD'),
      screenshots: false,
      dirty: false,
      cwd: repo,
    });

    fs.mkdirSync(shimDirectory);
    const gitShim = path.join(shimDirectory, 'git');
    fs.writeFileSync(
      gitShim,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STYLEPROOF_TEST_GIT_LOG"\nexec "$STYLEPROOF_TEST_REAL_GIT" "$@"\n',
    );
    fs.chmodSync(gitShim, 0o755);
    process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ''}`;
    process.env.STYLEPROOF_TEST_REAL_GIT = realGit;
    process.env.STYLEPROOF_TEST_GIT_LOG = invocationLog;

    assert.doesNotThrow(() => publishMapBundle({ dir: capture, cwd: repo }));
    const invocations = fs.readFileSync(invocationLog, 'utf8');
    assert.match(
      invocations,
      /config --includes --get-regexp \^http\\\.\.\*\\\.extraheader\$/,
      'the checkout credential lookup explicitly follows conditional includes',
    );
    assert.match(invocations, /config --local --get-regexp \^includeIf\\\..\*\\\.path\$/);
    assert.match(invocations, /config --file .*checkout-credentials\.config --get-regexp/);
    assert.match(
      invocations,
      /-c http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic fake-checkout-token clone -q --filter=blob:none --no-checkout/,
      'the initial isolated clone receives the checkout credential',
    );
    const publishedSha = git(repo, 'rev-parse', 'HEAD');
    assert.match(invocations, new RegExp(`sparse-checkout set ${publishedSha}`));
    assert.match(
      invocations,
      new RegExp(`add -A --sparse -- README.md ${publishedSha}/[a-f0-9]{16}`),
      'publishing stages only the selected bundle while the sparse index preserves every unseen bundle',
    );
    assert.match(
      invocations,
      /config --local http\.https:\/\/github\.com\/\.extraheader AUTHORIZATION: basic fake-checkout-token/,
      'the isolated checkout persists the credential for its later push',
    );
    assert.match(
      invocations,
      /-c http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic fake-checkout-token push -q origin HEAD:styleproof-maps/,
      'the push receives the checkout credential directly',
    );
    assert.equal(
      git(root, '--git-dir', remote, 'show', 'styleproof-maps:unseen-sha/unseen-compatibility/keep.txt'),
      'keep',
      'publishing preserves a bundle that was not part of the new capture',
    );

    process.env.STYLEPROOF_MAP_STORE_TOKEN = 'fake-workflow-token';
    fs.writeFileSync(invocationLog, '');
    assert.doesNotThrow(() => publishMapBundle({ dir: capture, cwd: repo }));
    const tokenInvocations = fs.readFileSync(invocationLog, 'utf8');
    const encodedWorkflowCredential = Buffer.from('x-access-token:fake-workflow-token').toString('base64');
    const workflowExtraHeaderKey = ['http.https:', '', 'github.com', '.extraheader'].join('/');
    assert.ok(
      tokenInvocations.includes(
        `-c ${workflowExtraHeaderKey}= -c ${workflowExtraHeaderKey}=AUTHORIZATION: basic ${encodedWorkflowCredential} clone`,
      ),
      'the explicit workflow token clears inherited checkout authentication before adding its header',
    );
    assert.ok(
      tokenInvocations.includes(`-c ${workflowExtraHeaderKey}=AUTHORIZATION: basic ${encodedWorkflowCredential} clone`),
      'the explicit workflow token takes precedence over checkout credentials',
    );
    assert.ok(
      tokenInvocations.includes(
        `-c ${workflowExtraHeaderKey}= -c ${workflowExtraHeaderKey}=AUTHORIZATION: basic ${encodedWorkflowCredential} push`,
      ),
      'the push receives the explicit workflow token directly after clearing inherited authentication',
    );
    assert.doesNotMatch(
      tokenInvocations,
      /fake-checkout-token/,
      'stale checkout credentials are not reused when the workflow supplies an explicit token',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.STYLEPROOF_TEST_REAL_GIT;
    else process.env.STYLEPROOF_TEST_REAL_GIT = previousRealGit;
    if (previousInvocationLog === undefined) delete process.env.STYLEPROOF_TEST_GIT_LOG;
    else process.env.STYLEPROOF_TEST_GIT_LOG = previousInvocationLog;
    if (previousMapStoreToken === undefined) delete process.env.STYLEPROOF_MAP_STORE_TOKEN;
    else process.env.STYLEPROOF_MAP_STORE_TOKEN = previousMapStoreToken;
    rmTmp(root);
  }
});

test('publishMapBundle preserves unseen bundles without downloading their blobs', () => {
  const root = mkTmp('styleproof-sparse-publish-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const consumer = path.join(root, 'consumer');
  const capture = path.join(consumer, '.styleproof/maps/current');
  const shimDirectory = path.join(root, 'bin');
  const transferLog = path.join(root, 'ssh-transfers.log');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  const unrelatedSha = 'b'.repeat(40);
  const unrelatedPayload = randomBytes(8 * 1024 * 1024);
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousTransferLog = process.env.STYLEPROOF_TEST_TRANSFER_LOG;

  try {
    git(root, 'init', '--bare', '-q', remote);
    git(root, 'clone', '-q', remote, seed);
    git(seed, 'checkout', '-q', '-b', 'styleproof-maps');
    git(seed, 'config', 'user.email', 'styleproof@example.test');
    git(seed, 'config', 'user.name', 'StyleProof Test');
    fs.writeFileSync(path.join(seed, 'README.md'), '# StyleProof maps\n');
    const unrelatedBundle = path.join(seed, unrelatedSha, 'unseen-compatibility');
    fs.mkdirSync(unrelatedBundle, { recursive: true });
    fs.writeFileSync(path.join(unrelatedBundle, 'unrelated.bin'), unrelatedPayload);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed large map store');
    git(seed, 'push', '-q', 'origin', 'styleproof-maps');
    git(root, '--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true');

    fs.mkdirSync(consumer);
    git(consumer, 'init', '-q', '-b', 'main');
    git(consumer, 'config', 'user.email', 'styleproof@example.test');
    git(consumer, 'config', 'user.name', 'StyleProof Test');
    git(consumer, 'remote', 'add', 'origin', `ssh://styleproof.test${remote}`);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(consumer, 'styleproof.spec.ts'), 'export default {};\n');
    git(consumer, 'add', '-A');
    git(consumer, 'commit', '-qm', 'consumer');

    fs.mkdirSync(capture, { recursive: true });
    fs.writeFileSync(path.join(capture, 'home@1280.json'), '{}');
    writeMapManifest({
      dir: capture,
      spec: 'styleproof.spec.ts',
      sha: git(consumer, 'rev-parse', 'HEAD'),
      screenshots: false,
      dirty: false,
      cwd: consumer,
    });

    fs.mkdirSync(shimDirectory);
    const sshShim = path.join(shimDirectory, 'ssh');
    fs.writeFileSync(
      sshShim,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const command = process.argv.at(-1);
const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] });
let bytes = 0;
process.stdin.pipe(child.stdin);
child.stdout.on('data', (chunk) => { bytes += chunk.length; process.stdout.write(chunk); });
child.on('close', (code) => {
  appendFileSync(process.env.STYLEPROOF_TEST_TRANSFER_LOG, command + '\\t' + bytes + '\\n');
  process.exit(code ?? 1);
});
`,
    );
    fs.chmodSync(sshShim, 0o755);
    process.env.GIT_SSH_COMMAND = sshShim;
    process.env.STYLEPROOF_TEST_TRANSFER_LOG = transferLog;

    publishMapBundle({ dir: capture, cwd: consumer });

    const uploadPackTransfer = fs
      .readFileSync(transferLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('git-upload-pack'));
    assert.ok(uploadPackTransfer, 'the test observed the map-store fetch');
    const transferredBytes = Number(uploadPackTransfer.split('\t').at(-1));
    assert.ok(
      transferredBytes < unrelatedPayload.length / 2,
      'publishing receives far less data than the unrelated bundle alone',
    );
    assert.equal(
      execFileSync(
        'git',
        ['--git-dir', remote, 'show', `styleproof-maps:${unrelatedSha}/unseen-compatibility/unrelated.bin`],
        { cwd: root, stdio: 'pipe', maxBuffer: unrelatedPayload.length * 2 },
      ).length,
      unrelatedPayload.length,
      'publishing preserves the unseen bundle',
    );
  } finally {
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousTransferLog === undefined) delete process.env.STYLEPROOF_TEST_TRANSFER_LOG;
    else process.env.STYLEPROOF_TEST_TRANSFER_LOG = previousTransferLog;
    rmTmp(root);
  }
});

test('restoreMapBundle retrieves only the requested SHA from a large map store', () => {
  const root = mkTmp('styleproof-sparse-restore-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const consumer = path.join(root, 'consumer');
  const restored = path.join(root, 'restored');
  const shimDirectory = path.join(root, 'bin');
  const invocationLog = path.join(root, 'git-invocations.log');
  const uploadLog = path.join(root, 'git-upload-pack.bin');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, stdio: 'pipe' }).toString().trim();
  const requestedSha = 'a'.repeat(40);
  const unrelatedSha = 'b'.repeat(40);
  const compatibilityKey = 'deadbeefdeadbeef';
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.STYLEPROOF_TEST_REAL_GIT;
  const previousInvocationLog = process.env.STYLEPROOF_TEST_GIT_LOG;
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousUploadLog = process.env.STYLEPROOF_TEST_UPLOAD_LOG;

  try {
    git(root, 'init', '--bare', '-q', remote);
    git(root, 'clone', '-q', remote, seed);
    git(seed, 'checkout', '-q', '-b', 'styleproof-maps');
    git(seed, 'config', 'user.email', 'styleproof@example.test');
    git(seed, 'config', 'user.name', 'StyleProof Test');

    const requestedBundle = path.join(seed, requestedSha, compatibilityKey);
    fs.mkdirSync(requestedBundle, { recursive: true });
    fs.writeFileSync(path.join(requestedBundle, 'home@1280.json'), '{"requested":true}\n');
    fs.writeFileSync(
      path.join(requestedBundle, MAP_MANIFEST),
      JSON.stringify({
        version: 1,
        packageVersion: 'test',
        sha: requestedSha,
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

    const unrelatedBundle = path.join(seed, unrelatedSha, compatibilityKey);
    fs.mkdirSync(unrelatedBundle, { recursive: true });
    const unrelatedPayload = randomBytes(8 * 1024 * 1024);
    fs.writeFileSync(path.join(unrelatedBundle, 'unrelated.bin'), unrelatedPayload);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed map store');
    git(seed, 'push', '-q', 'origin', 'styleproof-maps');
    git(root, '--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true');

    fs.mkdirSync(consumer);
    git(consumer, 'init', '-q', '-b', 'main');
    git(consumer, 'remote', 'add', 'origin', `ssh://styleproof.test${remote}`);

    fs.mkdirSync(shimDirectory);
    const gitShim = path.join(shimDirectory, 'git');
    fs.writeFileSync(
      gitShim,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STYLEPROOF_TEST_GIT_LOG"\nexec "$STYLEPROOF_TEST_REAL_GIT" "$@"\n',
    );
    fs.chmodSync(gitShim, 0o755);
    const sshShim = path.join(shimDirectory, 'ssh');
    fs.writeFileSync(
      sshShim,
      '#!/bin/sh\nfor argument do remote_command="$argument"; done\nsh -c "$remote_command" | tee -a "$STYLEPROOF_TEST_UPLOAD_LOG"\n',
    );
    fs.chmodSync(sshShim, 0o755);
    process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ''}`;
    process.env.STYLEPROOF_TEST_REAL_GIT = realGit;
    process.env.STYLEPROOF_TEST_GIT_LOG = invocationLog;
    process.env.GIT_SSH_COMMAND = sshShim;
    process.env.STYLEPROOF_TEST_UPLOAD_LOG = uploadLog;

    restoreMapBundle({ sha: requestedSha, outDir: restored, cwd: consumer });

    assert.equal(fs.readFileSync(path.join(restored, 'home@1280.json'), 'utf8'), '{"requested":true}\n');
    assert.equal(fs.existsSync(path.join(restored, 'unrelated.bin')), false);
    assert.ok(
      fs.statSync(uploadLog).size < unrelatedPayload.length / 2,
      'the remote sends far less data than the unrelated bundle alone',
    );
    const invocations = fs.readFileSync(invocationLog, 'utf8');
    assert.match(
      invocations,
      /clone -q --filter=blob:none --no-checkout --depth 1 --single-branch --branch styleproof-maps/,
      'restore clones tree metadata without checking out every cached bundle',
    );
    assert.match(invocations, new RegExp(`sparse-checkout set ${requestedSha}`));
    assert.match(invocations, /checkout -q styleproof-maps/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.STYLEPROOF_TEST_REAL_GIT;
    else process.env.STYLEPROOF_TEST_REAL_GIT = previousRealGit;
    if (previousInvocationLog === undefined) delete process.env.STYLEPROOF_TEST_GIT_LOG;
    else process.env.STYLEPROOF_TEST_GIT_LOG = previousInvocationLog;
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousUploadLog === undefined) delete process.env.STYLEPROOF_TEST_UPLOAD_LOG;
    else process.env.STYLEPROOF_TEST_UPLOAD_LOG = previousUploadLog;
    rmTmp(root);
  }
});

test('assertCompatibleMapDirs: differing browser build refuses to compare, naming both', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60', sha: 'b'.repeat(40) });
  const after = manifestDir({ browserVersion: '125.0.6422.60', sha: 'c'.repeat(40) });
  try {
    assert.throws(
      () => assertCompatibleMapDirs(before, after),
      (err) => {
        assert.match(err.message, /different runtime environments/);
        assert.match(err.message, /124\.0\.6367\.60/);
        assert.match(err.message, /125\.0\.6422\.60/);
        return true;
      },
    );
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: both sides missing browser build stay compatible', () => {
  const before = manifestDir();
  const after = manifestDir();
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: one side missing browser build stays compatible', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60' });
  const after = manifestDir(); // pre-field cached bundle
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('assertCompatibleMapDirs: same browser build compares clean', () => {
  const before = manifestDir({ browserVersion: '124.0.6367.60' });
  const after = manifestDir({ browserVersion: '124.0.6367.60' });
  try {
    assert.doesNotThrow(() => assertCompatibleMapDirs(before, after));
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

// A dir with a captured map but no manifest = a legacy committed-map bundle (v4 refuses).
function legacyMapDir() {
  const dir = mkTmp('styleproof-legacy-');
  writeCapture(dir, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  return dir;
}

test('manifestlessSide: both manifests present → null (guard is enforceable)', () => {
  const before = manifestDir();
  const after = manifestDir();
  try {
    assert.equal(manifestlessSide(before, after), null);
  } finally {
    rmTmp(before);
    rmTmp(after);
  }
});

test('manifestlessSide: names before / after / both for a legacy bundle (maps, no manifest)', () => {
  const withManifest = manifestDir();
  const legacy = legacyMapDir();
  const legacy2 = legacyMapDir();
  try {
    assert.equal(manifestlessSide(legacy, withManifest), 'before');
    assert.equal(manifestlessSide(withManifest, legacy), 'after');
    assert.equal(manifestlessSide(legacy, legacy2), 'both');
  } finally {
    rmTmp(withManifest);
    rmTmp(legacy);
    rmTmp(legacy2);
  }
});

test('manifestlessSide: a bare dir with no maps is NOT flagged (empty ≠ legacy bundle)', () => {
  // A dir with zero maps is "no baseline yet", owned by the base/head-missing guards —
  // not a legacy committed-map bundle. The manifest refusal must not swallow it.
  const withManifest = manifestDir();
  const bare = mkTmp('styleproof-bare-');
  try {
    assert.equal(manifestlessSide(bare, withManifest), null);
    assert.equal(manifestlessSide(withManifest, bare), null);
    assert.equal(manifestlessSide(bare, mkTmp('styleproof-bare-')), null);
  } finally {
    rmTmp(withManifest);
    rmTmp(bare);
  }
});

test('manifestlessError: names the side and points at re-capturing (v4 refuses)', () => {
  assert.match(manifestlessError('before'), /before carries no styleproof-manifest\.json/);
  assert.match(manifestlessError('after'), /after carries no styleproof-manifest\.json/);
  assert.match(manifestlessError('both'), /before and after carry no styleproof-manifest\.json/);
  assert.match(manifestlessError('both'), /unsupported since v4/);
  assert.match(manifestlessError('both'), /Re-capture with current StyleProof/);
});

test('writeCaptureManifest: stamps a compat manifest, degrading git fields outside a repo', () => {
  // A one-shot styleproof-capture output dir under a NON-git tmp path — the design-mockup
  // case. The manifest must still carry the fields the same-environment guard consumes.
  const dir = mkTmp('styleproof-capture-manifest-');
  try {
    // cwd = the tmp dir itself (not a git repo) so the git fields degrade.
    const manifest = writeCaptureManifest({ dir, screenshots: true, cwd: dir });
    // Git fields degrade gracefully (tmp dir is not a git repo).
    assert.equal(manifest.sha, 'uncommitted');
    assert.equal(manifest.dirty, true);
    // The comparability fields are present and real.
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.nodeMajor, process.versions.node.split('.')[0]);
    assert.match(manifest.compatibilityKey, /^[0-9a-f]{16}$/);
    assert.equal(manifest.screenshots, true);
    // And it round-trips through the reader, so a diff can pick it up on both sides.
    const read = readMapManifest(dir);
    assert.equal(read.compatibilityKey, manifest.compatibilityKey);
    // Two capture dirs stamped in the same environment are mutually compatible.
    const other = mkTmp('styleproof-capture-manifest-');
    try {
      writeCaptureManifest({ dir: other, screenshots: true, cwd: other });
      assert.doesNotThrow(() => assertCompatibleMapDirs(dir, other));
    } finally {
      rmTmp(other);
    }
  } finally {
    rmTmp(dir);
  }
});

test('writeBrowserBuildSidecar(undefined) CLEARS a stale sidecar so a version-less run stamps no browserVersion', () => {
  // Repro of the stale-fingerprint bug: a reused capture dir already holds a PRIOR
  // run's sidecar. This run records no browser version (handle unavailable / capture
  // test not reached). If the sidecar survived, writeMapManifest would fold the prior
  // build into this run's manifest and assertCompatibleMapDirs would trust it.
  const dir = mkTmp('styleproof-sidecar-');
  try {
    // A prior run left a sidecar behind.
    writeBrowserBuildSidecar(dir, '124.0.6367.60');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, BROWSER_BUILD_SIDECAR), 'utf8')).browserVersion,
      '124.0.6367.60',
    );
    // This run has no browser version → write-or-clear removes the stale sidecar.
    writeBrowserBuildSidecar(dir, undefined);
    assert.equal(fs.existsSync(path.join(dir, BROWSER_BUILD_SIDECAR)), false);
    // So the manifest this run writes carries NO browserVersion — no false fingerprint.
    const manifest = writeMapManifest({
      dir,
      spec: 'e2e/styleproof.spec.ts',
      sha: 'd'.repeat(40),
      screenshots: true,
      dirty: false,
    });
    assert.equal(manifest.browserVersion, undefined);
    assert.equal(readMapManifest(dir).browserVersion, undefined);
  } finally {
    rmTmp(dir);
  }
});
