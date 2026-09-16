// Detect the consumer's package manager: package.json#packageManager wins, else the lockfile.
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './cli.mjs';

const LOCKFILES = [
  ['npm', ['package-lock.json']],
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
  ['bun', ['bun.lock', 'bun.lockb']],
];
const SUPPORTED = new Set(LOCKFILES.map(([name]) => name));

export function detectPackageManager(root, { allowMissingManifest = false } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    if (allowMissingManifest && error?.code === 'ENOENT') return 'npm';
    throw new Error(`could not read package.json: ${errorMessage(error)}`, { cause: error });
  }
  const declared = manifest.packageManager;
  if (declared !== undefined) {
    if (typeof declared !== 'string') throw new Error('package.json#packageManager must be a string');
    const name = declared.split('@', 1)[0];
    if (!SUPPORTED.has(name)) throw new Error(`unsupported package.json#packageManager: ${declared}`);
    return name;
  }
  const detected = LOCKFILES.filter(([, files]) => files.some((f) => fs.existsSync(path.join(root, f)))).map(
    ([name]) => name,
  );
  if (detected.length > 1) {
    throw new Error(
      `multiple package-manager lockfiles found (${detected.join(', ')}); set package.json#packageManager explicitly`,
    );
  }
  return detected[0] ?? 'npm';
}
