import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function playwrightLaunch(args, options) {
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
  return {
    command: cli ? process.execPath : process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
    args: cli ? [cli, ...args] : args,
    options: childOptions,
    failure,
    cwd,
  };
}

function explainLaunchFailure(result, launch) {
  const { failure, cwd } = launch;
  // Windows batch shims report EINVAL; invalid arguments can too.
  // Preserve diagnostics naming both lookup locations.
  const missing = result.error?.code === 'ENOENT';
  const batchShim = process.platform === 'win32' && result.error?.code === 'EINVAL';
  if ((!missing && !batchShim) || !failure) return result;
  return {
    ...result,
    error: new Error(
      `PATH Playwright failed: ${result.error.message?.split('\n')[0] ?? result.error.code}; ${failure.code === 'MODULE_NOT_FOUND' ? `@playwright/test is not installed in ${cwd}` : `project CLI failed in ${cwd}: ${failure.code}: ${failure.message}`}`,
    ),
  };
}

export function projectPlaywright(args, options = {}) {
  const launch = playwrightLaunch(args, options);
  return explainLaunchFailure(spawnSync(launch.command, launch.args, launch.options), launch);
}

/** Stream capture output and forward interrupts while Playwright is running. */
export function projectPlaywrightAsync(args, options, onOutput) {
  const launch = playwrightLaunch(args, options);
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ['inherit', 'pipe', 'pipe'] });
    let interruptedSignal;
    const interrupt = () => {
      interruptedSignal = 'SIGINT';
      child.kill('SIGINT');
    };
    const terminate = () => {
      interruptedSignal = 'SIGTERM';
      // Playwright tears down its managed webServer on SIGINT.
      child.kill('SIGINT');
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.stdout.setEncoding('utf8').on('data', (chunk) => onOutput('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => onOutput('stderr', chunk));
    let error;
    child.on('error', (cause) => {
      error = cause;
    });
    child.on('close', (status, signal) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      resolve(explainLaunchFailure({ status, signal, error, interruptedSignal }, launch));
    });
  });
}
