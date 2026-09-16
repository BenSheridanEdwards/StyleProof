// Pre-push hook installation and activation reporting. Git resolves exactly one
// pre-push hook; this module says whether the generated one is it, and activates it
// (core.hooksPath=.githooks) only when nothing else already owns that slot.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultHookPathState,
  generatedPathState,
  isExecutableFile,
  readRegularTextFile,
  writeFileSafe,
} from './files.mjs';

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const inactive = (hookPath, why) => console.warn(`generated ${hookPath} is inactive: ${why}`);

export const hookFilePath = () => path.join(fs.existsSync('.husky') ? '.husky' : '.githooks', 'pre-push');

function hookConfigScope() {
  const listed = git(['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return undefined;
  const worktrees = listed.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
  if (worktrees <= 1) return { flag: '--local', label: 'local repository' };
  const enabled = git(['config', '--bool', '--get', 'extensions.worktreeConfig']);
  return enabled.status === 0 && enabled.stdout.trim() === 'true'
    ? { flag: '--worktree', label: 'current worktree' }
    : undefined;
}

function huskyShimProblem(state, executable) {
  if (state.kind === 'missing') return 'that active shim does not exist';
  if (state.kind === 'symlink') return 'that active shim is a symlink';
  if (state.kind !== 'file') return `that active shim is ${state.kind}`;
  return executable ? 'the active shim is outside Husky' : 'that active shim is not executable';
}

function reportHuskyHookStatus({ hookPath, configuredPath, activeHookPath, activeHookAbsolute }) {
  const huskyRoot = path.resolve('.husky');
  const activeState = generatedPathState(activeHookAbsolute);
  const executable = activeState.kind === 'file' && isExecutableFile(activeHookAbsolute);
  if (activeHookAbsolute.startsWith(`${huskyRoot}${path.sep}`) && executable) {
    console.log(`  Husky manages hook activation via core.hooksPath=${configuredPath}`);
    return;
  }
  const reason = huskyShimProblem(activeState, executable);
  inactive(
    hookPath,
    `Git resolves pre-push to ${activeHookPath}; ${reason}; core.hooksPath left unchanged for Husky to manage`,
  );
}

function reportMatchingHookStatus({ hookPath, configuredPath, activeHookAbsolute, managed }) {
  const activeState = generatedPathState(activeHookAbsolute);
  if (!managed && activeState.kind !== 'file' && activeState.kind !== 'missing') {
    console.warn(`unmanaged ${hookPath} (left unchanged; hook destination is ${activeState.kind})`);
    return;
  }
  if (activeState.kind !== 'file' || !isExecutableFile(activeHookAbsolute)) {
    inactive(
      hookPath,
      `Git resolves pre-push there, but the hook ${activeState.kind === 'missing' ? 'does not exist' : 'is not executable'}`,
    );
    return;
  }
  console.log(
    managed
      ? `  ${hookPath} is active via core.hooksPath=${configuredPath}`
      : `  repository-owned ${hookPath} is active; StyleProof left it unchanged`,
  );
}

function activateGeneratedHook(hookPath, generatedHookAbsolute) {
  const scope = hookConfigScope();
  if (!scope) {
    inactive(
      hookPath,
      'multiple linked worktrees require worktree-scoped Git config; enable it explicitly with: ' +
        'git config extensions.worktreeConfig true && git config --worktree core.hooksPath .githooks',
    );
    return;
  }
  if (git(['config', scope.flag, 'core.hooksPath', '.githooks']).status === 0) {
    const verified = git(['rev-parse', '--git-path', 'hooks/pre-push']);
    const verifiedPath = verified.status === 0 ? path.resolve(verified.stdout.trim()) : undefined;
    if (verifiedPath === generatedHookAbsolute && isExecutableFile(generatedHookAbsolute)) {
      console.log(`  activated ${hookPath} for the ${scope.label} via core.hooksPath=.githooks`);
      return;
    }
    git(['config', scope.flag, '--unset', 'core.hooksPath']);
  }
  inactive(hookPath, 'could not set worktree-safe core.hooksPath');
}

function handleUnconfiguredHook({ hookPath, generatedHookAbsolute, activate, managed }) {
  if (!managed) {
    const state = generatedPathState(generatedHookAbsolute);
    if (state.kind !== 'file')
      console.warn(`unmanaged ${hookPath} (left unchanged; hook destination is ${state.kind})`);
    else console.warn(`repository-owned ${hookPath} was left unchanged and inactive; StyleProof did not activate it`);
    return;
  }
  if (!isExecutableFile(generatedHookAbsolute)) {
    inactive(hookPath, 'the hook is not executable; refresh it with: styleproof-init --hook');
    return;
  }
  if (!activate) {
    console.warn(
      `generated ${hookPath} is inactive in this checkout; activate with: git config --local core.hooksPath .githooks`,
    );
    return;
  }
  activateGeneratedHook(hookPath, generatedHookAbsolute);
}

function reportUnconfigured({
  hookPath,
  activeHookPath,
  activeHookAbsolute,
  generatedHookAbsolute,
  activate,
  managed,
}) {
  const activeState = defaultHookPathState(activeHookAbsolute);
  if (activeState.kind === 'missing') {
    handleUnconfiguredHook({ hookPath, generatedHookAbsolute, activate, managed });
  } else if (activeState.kind === 'file' && isExecutableFile(activeHookAbsolute)) {
    inactive(
      hookPath,
      `existing active hook at ${activeHookPath} was left unchanged; integrate styleproof-prepush there or explicitly run: git config --local core.hooksPath .githooks`,
    );
  } else {
    inactive(
      hookPath,
      `default hook at ${activeHookPath} is ${activeState.kind} or not a readable executable; core.hooksPath left unchanged`,
    );
  }
}

export function reportOrActivateHook(hookDir, hookPath, { activate = true, managed = true } = {}) {
  const worktree = git(['rev-parse', '--is-inside-work-tree']);
  if (worktree.status !== 0 || worktree.stdout.trim() !== 'true') {
    console.warn(
      `generated ${hookPath} is inactive outside a Git worktree; after git init run: git config --local core.hooksPath .githooks`,
    );
    return;
  }
  const configured = git(['config', '--get', 'core.hooksPath']);
  const active = git(['rev-parse', '--git-path', 'hooks/pre-push']);
  if (active.status !== 0) return inactive(hookPath, "could not resolve Git's active pre-push hook path");
  const activeHookPath = active.stdout.trim();
  if (!activeHookPath || /[\r\n]/.test(activeHookPath))
    return inactive(hookPath, 'Git returned an ambiguous active pre-push hook path');
  const activeHookAbsolute = path.resolve(activeHookPath);
  const generatedHookAbsolute = path.resolve(hookPath);
  const configuredPath = configured.stdout.trim();

  if (hookDir === '.husky')
    return reportHuskyHookStatus({ hookPath, configuredPath, activeHookPath, activeHookAbsolute });
  if (activeHookAbsolute === generatedHookAbsolute)
    return reportMatchingHookStatus({ hookPath, configuredPath, activeHookAbsolute, managed });
  if (configured.status !== 0 && configured.status !== 1) return inactive(hookPath, 'could not read core.hooksPath');
  if (configured.status === 1)
    return reportUnconfigured({
      hookPath,
      activeHookPath,
      activeHookAbsolute,
      generatedHookAbsolute,
      activate,
      managed,
    });
  inactive(
    hookPath,
    `core.hooksPath is ${configuredPath} (active hook: ${activeHookPath}); left unchanged. If you intend to replace it, run: git config --local core.hooksPath .githooks`,
  );
}

/** Write the hook (only forcing when asked), then report or activate it. */
export function installPrePushHook(contents, { force = false } = {}) {
  const hookPath = hookFilePath();
  const hook = writeFileSafe(hookPath, contents, { force });
  if (hook.wrote) {
    fs.chmodSync(hookPath, 0o755);
    console.log(
      `${hook.exists ? 'refreshed' : 'created'} ${hookPath} (pre-push capture → publish via styleproof-prepush; maps never land on the PR branch)`,
    );
  } else if (hook.unmanaged) {
    console.log(`unmanaged ${hookPath} (left unchanged; generated destination is unsafe or non-regular)`);
  } else {
    console.log(`${hookPath} already exists — left untouched (refresh it with: styleproof-init --hook)`);
  }
  const managed = readRegularTextFile(hookPath) === contents;
  reportOrActivateHook(path.dirname(hookPath), hookPath, { activate: managed, managed });
  return { ...hook, hookPath };
}
