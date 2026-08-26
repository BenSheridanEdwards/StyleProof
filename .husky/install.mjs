import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { stdout } from 'node:process';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryCheckout = existsSync(path.join(packageRoot, '.git'));

if (!repositoryCheckout) {
  stdout.write('package build completed without installing repository hooks\n');
} else {
  try {
    const { default: husky } = await import('husky');
    stdout.write(`${husky()}\n`);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'husky'")) {
      throw error;
    }
    stdout.write('husky is unavailable; package build completed without installing repository hooks\n');
  }
}
