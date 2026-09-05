import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export function detectPackageManager(root, { allowMissingManifest = false } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    if (allowMissingManifest && error && typeof error === 'object' && error.code === 'ENOENT') return 'npm';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read package.json: ${detail}`, { cause: error });
  }

  if (manifest.packageManager !== undefined) {
    if (typeof manifest.packageManager !== 'string') {
      throw new Error('package.json#packageManager must be a string');
    }
    const declared = manifest.packageManager.split('@', 1)[0];
    if (!SUPPORTED_PACKAGE_MANAGERS.has(declared)) {
      throw new Error(`unsupported package.json#packageManager: ${manifest.packageManager}`);
    }
    return declared;
  }

  const detected = [];
  if (fs.existsSync(path.join(root, 'package-lock.json'))) detected.push('npm');
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) detected.push('pnpm');
  if (fs.existsSync(path.join(root, 'yarn.lock'))) detected.push('yarn');
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) detected.push('bun');
  if (detected.length > 1) {
    throw new Error(
      `multiple package-manager lockfiles found (${detected.join(', ')}); set package.json#packageManager explicitly`,
    );
  }
  return detected[0] ?? 'npm';
}
