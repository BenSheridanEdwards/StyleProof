import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function projectPlaywright(args, options = {}) {
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const result = spawnSync(command, args, options);
  // Windows batch shims report EINVAL; invalid arguments can too.
  // Preserve fallback diagnostics if retrying cannot run the CLI.
  const missing = result.error?.code === 'ENOENT';
  const batchShim = process.platform === 'win32' && result.error?.code === 'EINVAL';
  if (!missing && !batchShim) return result;
  const cwd = options.cwd ?? process.cwd();
  let failure;
  try {
    const cli = createRequire(path.join(cwd, 'package.json')).resolve('@playwright/test/cli');
    const fallback = spawnSync(process.execPath, [cli, ...args], options);
    if (!fallback.error) return fallback;
    failure = fallback.error;
  } catch (error) {
    failure = error;
  }
  return {
    ...result,
    error: new Error(
      `PATH Playwright failed: ${result.error.message?.split('\n')[0] ?? result.error.code}; ${failure.code === 'MODULE_NOT_FOUND' ? `@playwright/test is not installed in ${cwd}` : `project CLI failed in ${cwd}: ${failure.code}: ${failure.message}`}`,
    ),
  };
}
