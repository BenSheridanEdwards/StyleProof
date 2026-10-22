import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { needsBrowserLanes } from './ci-path-filters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Unknown inventories run; known paths use the same browser policy as CI. */
export function shouldRunStagedE2e(files) {
  return files === null || needsBrowserLanes(files);
}

/** Chromium present if Playwright resolves an executable path that exists on disk. */
export function chromiumInstalled({ executablePath, existsSync = fs.existsSync } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) return false;
  return existsSync(executablePath);
}

function gitOutput(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function gitPaths(...args) {
  return gitOutput('diff', '--name-only', '--no-renames', '-z', ...args)
    .split('\0')
    .filter(Boolean);
}

function validOid(oid) {
  return typeof oid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid);
}

function filesForPushRange({ remoteOid, localOid }) {
  if (!validOid(remoteOid) || !validOid(localOid) || remoteOid.length !== localOid.length) {
    throw new Error('Invalid pre-push object IDs: expected full, matching-format Git OIDs');
  }
  if (/^0+$/.test(localOid)) {
    if (/^0+$/.test(remoteOid)) throw new Error('Invalid pre-push object IDs: both OIDs are zero');
    return []; // Deleting a ref introduces no new tree to check.
  }
  if (/^0+$/.test(remoteOid)) return null; // A new ref has no known remote comparison tree.
  return gitPaths(`${remoteOid}..${localOid}`);
}

function parsePushRange(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 4) throw new Error('Invalid pre-push record: expected four fields');
  const [localRef, localOid, remoteRef, remoteOid] = parts;
  if (!remoteRef.startsWith('refs/')) throw new Error('Invalid pre-push destination ref: expected a full ref');
  gitOutput('check-ref-format', remoteRef);
  if (/^0+$/.test(localOid)) {
    if (localRef !== '(delete)') throw new Error('Invalid pre-push deletion ref');
  } else {
    const resolved = gitOutput('rev-parse', '--verify', '--end-of-options', localRef).trim();
    if (resolved.toLowerCase() !== localOid.toLowerCase()) throw new Error('Invalid pre-push local ref/OID pair');
  }
  return { remoteOid, localOid };
}

function parsePushRangesFromStdin(stdinText) {
  if (!stdinText.trim()) return null;
  return stdinText
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parsePushRange);
}

/** Staged and pushed paths, or null when the push inventory cannot be known. */
export function collectPrePushFiles({ stagedFiles, pushRanges, readStdin }) {
  const staged = stagedFiles ?? gitPaths('--cached');
  const ranges = pushRanges ?? (readStdin ? parsePushRangesFromStdin(fs.readFileSync(0, 'utf8')) : null);
  if (ranges === null) return null;
  const pushed = ranges.map(filesForPushRange);
  if (pushed.includes(null)) return null;
  return [...new Set([...staged, ...pushed.flat()])];
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
  const files = collectPrePushFiles({ readStdin: !process.stdin.isTTY });
  if (!shouldRunStagedE2e(files)) {
    console.log('  › pre-push e2e — skipped (all staged and pushed paths are browser-safe)');
    return;
  }

  const executablePath = await resolveChromiumPath();
  if (!chromiumInstalled({ executablePath })) {
    throw new Error('Playwright Chromium not installed. Run `npx playwright install chromium` before pushing.');
  }

  console.log('  › pre-push e2e (browser paths changed or push inventory unknown)');
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
