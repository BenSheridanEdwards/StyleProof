import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Staged / pushed paths that should trigger local Playwright e2e on pre-push.
 * "engine" = `src/runner` (Playwright capture runner). Spec #773 option 3.
 */
export const E2E_PATH_PATTERNS = [
  /^src\/capture(\/|\.ts$)/,
  /^src\/diff\.ts$/,
  /^src\/report(\/|\.ts$)/,
  /^src\/runner(\/|\.ts$)/,
];

/** True when any path hits capture / diff / report / engine (runner). */
export function shouldRunStagedE2e(files) {
  return files.some((file) => {
    const normalized = file.replaceAll('\\', '/');
    return E2E_PATH_PATTERNS.some((re) => re.test(normalized));
  });
}

/** Chromium present if Playwright resolves an executable path that exists on disk. */
export function chromiumInstalled({ executablePath, existsSync = fs.existsSync } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) return false;
  return existsSync(executablePath);
}

function gitLines(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function usableOid(oid) {
  return typeof oid === 'string' && oid.length > 0 && !/^0+$/.test(oid);
}

function filesForPushRange({ remoteOid, localOid }) {
  if (!usableOid(remoteOid) || !usableOid(localOid)) return [];
  return gitLines('diff', '--name-only', `${remoteOid}..${localOid}`);
}

function parsePushRangesFromStdin(stdinText) {
  const ranges = [];
  for (const line of stdinText.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [, localOid, , remoteOid] = parts;
    ranges.push({ remoteOid, localOid });
  }
  return ranges;
}

/** Staged index paths plus files in each remote..local push range from pre-push stdin. */
export function collectPrePushFiles({ stagedFiles, pushRanges, readStdin }) {
  const staged = stagedFiles ?? gitLines('diff', '--cached', '--name-only');
  const ranges = pushRanges ?? (readStdin ? parsePushRangesFromStdin(fs.readFileSync(0, 'utf8')) : []);
  const pushed = ranges.flatMap(filesForPushRange);
  return [...new Set([...staged, ...pushed])];
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
    console.log('  › staged e2e — skipped (no capture/diff/report/engine paths in staged or pushed files)');
    return;
  }

  const executablePath = await resolveChromiumPath();
  if (!chromiumInstalled({ executablePath })) {
    console.warn('  ⚠ Playwright Chromium not installed — skipping staged e2e.');
    console.warn('    Install it (`npx playwright install chromium`) for pre-push browser checks;');
    console.warn('    the e2e CI workflow still gates every push.');
    return;
  }

  console.log('  › staged e2e (capture/diff/report/engine paths changed)');
  const result = spawnSync('npm', ['run', 'test:e2e'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
