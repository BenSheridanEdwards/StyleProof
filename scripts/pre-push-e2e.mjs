import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { browserLanesRequired, makeGit, treeOf } from './browser-lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Chromium present if Playwright resolves an executable path that exists on disk. */
export function chromiumInstalled({ executablePath, existsSync = fs.existsSync } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) return false;
  return existsSync(executablePath);
}

function gitOutput(git, ...args) {
  const result = git(args);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error ?? 'Git command failed'}`);
  }
  return result.stdout;
}

function validOid(oid) {
  return typeof oid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid);
}

function proofForPushRange({ remoteOid, localOid }, git) {
  if (!validOid(remoteOid) || !validOid(localOid) || remoteOid.length !== localOid.length) {
    throw new Error('Invalid pre-push object IDs: expected full, matching-format Git OIDs');
  }
  if (/^0+$/.test(localOid)) {
    if (/^0+$/.test(remoteOid)) throw new Error('Invalid pre-push object IDs: both OIDs are zero');
    return { kind: 'deleted' }; // Deleting a ref introduces no new tree to check.
  }
  if (/^0+$/.test(remoteOid)) return { kind: 'unknown', reason: 'no remote base' };
  const remoteTree = treeOf(git, remoteOid);
  const localTree = treeOf(git, localOid);
  return remoteTree === localTree ? { kind: 'same-tree', tree: localTree } : { kind: 'differs' };
}

function parsePushRange(line, git) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 4) throw new Error('Invalid pre-push record: expected four fields');
  const [localRef, localOid, remoteRef, remoteOid] = parts;
  if (!validOid(remoteOid) || !validOid(localOid) || remoteOid.length !== localOid.length) {
    throw new Error('Invalid pre-push object IDs: expected full, matching-format Git OIDs');
  }
  if (/^0+$/.test(localOid) && /^0+$/.test(remoteOid)) {
    throw new Error('Invalid pre-push object IDs: both OIDs are zero');
  }
  if (!remoteRef.startsWith('refs/')) throw new Error('Invalid pre-push destination ref: expected a full ref');
  gitOutput(git, 'check-ref-format', remoteRef);
  if (/^0+$/.test(localOid)) {
    if (localRef !== '(delete)') throw new Error('Invalid pre-push deletion ref');
  } else {
    const resolved = gitOutput(git, 'rev-parse', '--verify', '--end-of-options', localRef).trim();
    if (resolved.toLowerCase() !== localOid.toLowerCase()) throw new Error('Invalid pre-push local ref/OID pair');
  }
  return { remoteOid, localOid };
}

function parsePushRangesFromStdin(stdinText, git) {
  if (typeof stdinText !== 'string' || !stdinText.trim()) return null;
  return stdinText
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parsePushRange(line, git));
}

function stagedProof(git) {
  try {
    const stagedTree = gitOutput(git, 'write-tree').trim().toLowerCase();
    if (!validOid(stagedTree)) return { kind: 'unknown', reason: 'invalid index tree' };
    const headTree = treeOf(git, 'HEAD');
    const crossCheck = git(['diff-index', '--cached', '--quiet', '--ignore-submodules=none', 'HEAD', '--']);
    if (crossCheck.ok && stagedTree === headTree) return { kind: 'same-tree', tree: stagedTree };
    if (crossCheck.status === 1 && stagedTree !== headTree) return { kind: 'differs' };
    return { kind: 'unknown', reason: 'index cross-check failed or disagreed' };
  } catch {
    return { kind: 'unknown', reason: 'index tree unavailable' };
  }
}

/** Raw pushed and staged tree proofs. Unknown metadata or index state always runs. */
export function collectPrePushProofs({ stdinText, git = makeGit(ROOT) } = {}) {
  const ranges = parsePushRangesFromStdin(stdinText, git);
  const pushed =
    ranges === null
      ? [{ kind: 'unknown', reason: 'no push records' }]
      : ranges.map((range) => proofForPushRange(range, git));
  return [...pushed, stagedProof(git)];
}

async function resolveChromiumPath() {
  try {
    const playwright = await import('@playwright/test');
    return playwright.chromium.executablePath();
  } catch {
    return undefined;
  }
}

async function main() {
  const stdinText = process.stdin.isTTY ? undefined : fs.readFileSync(0, 'utf8');
  const proofs = collectPrePushProofs({ stdinText });
  const reasons = proofs
    .map((proof) => (proof.kind === 'unknown' ? `unknown: ${proof.reason}` : proof.kind))
    .join(', ');
  if (!browserLanesRequired(proofs)) {
    console.log(`  › pre-push e2e — skipped (tree proofs: ${reasons})`);
    return;
  }

  const executablePath = await resolveChromiumPath();
  if (!chromiumInstalled({ executablePath })) {
    throw new Error('Playwright Chromium not installed. Run `npx playwright install chromium` before pushing.');
  }

  console.log(`  › pre-push e2e (tree proofs: ${reasons})`);
  const result = spawnSync('npm', ['run', 'test:e2e', '--', '--workers=4'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
