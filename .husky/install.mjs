import { stdout } from 'node:process';

try {
  const { default: husky } = await import('husky');
  stdout.write(`${husky()}\n`);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'husky'")) {
    throw error;
  }
  stdout.write('husky is unavailable; package build completed without installing repository hooks\n');
}
