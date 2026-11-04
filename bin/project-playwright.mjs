import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function projectPlaywright(args, options = {}) {
  const env = options.env ?? process.env;
  const childOptions =
    args[0] === 'test'
      ? {
          ...options,
          env: {
            ...env,
            NODE_OPTIONS:
              `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(fileURLToPath(new URL('./config-warnings.cjs', import.meta.url)))}`.trim(),
          },
        }
      : options;
  const cwd = options.cwd ?? process.cwd();
  let cli;
  let failure;
  try {
    cli = createRequire(path.join(cwd, 'package.json')).resolve('@playwright/test/cli');
  } catch (error) {
    failure = error;
  }
  if (cli) return spawnSync(process.execPath, [cli, ...args], childOptions);
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const result = spawnSync(command, args, childOptions);
  // Windows batch shims report EINVAL; invalid arguments can too.
  // Preserve diagnostics naming both lookup locations.
  const missing = result.error?.code === 'ENOENT';
  const batchShim = process.platform === 'win32' && result.error?.code === 'EINVAL';
  if (!missing && !batchShim) return result;
  return {
    ...result,
    error: new Error(
      `PATH Playwright failed: ${result.error.message?.split('\n')[0] ?? result.error.code}; ${failure.code === 'MODULE_NOT_FOUND' ? `@playwright/test is not installed in ${cwd}` : `project CLI failed in ${cwd}: ${failure.code}: ${failure.message}`}`,
    ),
  };
}
