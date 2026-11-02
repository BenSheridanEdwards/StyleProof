import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function projectPlaywright(args, options = {}) {
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const result = spawnSync(command, args, options);
  // Windows cannot directly spawn batch shims; Node reports EINVAL for them.
  const missing = result.error?.code === 'ENOENT';
  const batchShim = process.platform === 'win32' && result.error?.code === 'EINVAL';
  if (!missing && !batchShim) return result;
  const cwd = options.cwd ?? process.cwd();
  try {
    const cli = createRequire(path.join(cwd, 'package.json')).resolve('@playwright/test/cli');
    const fallback = spawnSync(process.execPath, [cli, ...args], options);
    if (!fallback.error) return fallback;
  } catch {
    // Report both locations searched below.
  }
  return {
    ...result,
    error: new Error(`Playwright could not be found on PATH or in the project's node_modules (searched ${cwd})`),
  };
}
