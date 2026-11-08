import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capturePlaywrightConfig } from './runner/capture-server.js';

/** Leave two CPUs for the app server, while retaining at least Playwright's half-CPU default. */
export function defaultCaptureWorkers(cpus: number): number {
  return Math.max(Math.ceil(cpus / 2), cpus - 2);
}

async function configChoosesWorkers(args: readonly string[], cwd: string): Promise<boolean> {
  try {
    const location = capturePlaywrightConfig(args, cwd);
    if (!location) return false;

    // A cold checkout can have its own Playwright install; never import it into
    // the CLI process that already loaded the head's runner. Keep config logs
    // separate from the boolean returned on fd 3.
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--require',
        fileURLToPath(new URL('../bin/config-warnings.cjs', import.meta.url)),
        '--input-type=module',
        '-e',
        `import { writeFileSync } from 'node:fs';
         import { importConfigRecord } from ${JSON.stringify(new URL('./config/load.js', import.meta.url).href)};
         try {
           const config = await importConfigRecord(process.argv[1]);
           writeFileSync(3, String('workers' in config));
           process.exit(0);
         } catch {
           process.exit(1);
         }`,
        location,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit', 'pipe'] },
    );

    return result.error !== undefined || result.status !== 0 || result.output[3] !== 'false';
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
