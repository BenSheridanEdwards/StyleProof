import fs from 'node:fs';
import path from 'node:path';
import { importConfigRecord } from './config/load.js';

/** Leave two CPUs for the app server, while retaining at least Playwright's half-CPU default. */
export function defaultCaptureWorkers(cpus: number): number {
  return Math.max(Math.ceil(cpus / 2), cpus - 2);
}

async function configChoosesWorkers(args: readonly string[], cwd: string): Promise<boolean> {
  try {
    let configPath: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--config' || arg === '-c') configPath = args[++i];
      else if (arg.startsWith('--config=')) configPath = arg.slice('--config='.length);
      else if (arg.startsWith('-c')) configPath = arg.slice(2);
    }

    let location = path.resolve(cwd, configPath ?? '.');

    if (fs.statSync(location).isDirectory()) {
      const filename = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']
        .map((ext) => `playwright.config.${ext}`)
        .find((file) => fs.existsSync(path.join(location, file)));

      if (!filename) return false;
      location = path.join(location, filename);
    }

    const config = await importConfigRecord(location);

    return 'workers' in config;
  } catch {
    // An unreadable or unloadable config may choose workers; preserve the adopter's choice.
    return true;
  }
}

export async function selectCaptureWorkers(
  args: readonly string[],
  envWorkers: string | undefined,
  cpus: number,
  cwd: string,
): Promise<{ count: number; source: 'default' | 'STYLEPROOF_WORKERS' } | undefined> {
  if (args.some((arg) => arg === '--workers' || arg.startsWith('--workers=') || arg.startsWith('-j'))) {
    return undefined;
  }

  if (envWorkers !== undefined) {
    const count = Number(envWorkers);

    if (!/^\d+$/.test(envWorkers) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error('STYLEPROOF_WORKERS must be a positive integer');
    }

    return { count, source: 'STYLEPROOF_WORKERS' };
  }

  if (await configChoosesWorkers(args, cwd)) return undefined;

  return { count: defaultCaptureWorkers(cpus), source: 'default' };
}
