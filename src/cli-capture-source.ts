import { projectConfigOrExit } from './cli-errors.js';
import { DEFAULT_MAP_STORE_BRANCH, DEFAULT_REMOTE } from './map-store.js';

export type CaptureSourceOptions = {
  spec: string;
  cacheBranch: string;
  remote: string;
};

export function captureSourceDefaults(command: string): CaptureSourceOptions {
  const config = projectConfigOrExit(command);
  return {
    spec: config.spec ?? 'e2e/styleproof.spec.ts',
    cacheBranch: process.env.STYLEPROOF_CACHE_BRANCH ?? config.cacheBranch ?? DEFAULT_MAP_STORE_BRANCH,
    remote: process.env.STYLEPROOF_REMOTE ?? config.remote ?? DEFAULT_REMOTE,
  };
}

/** Consume one shared cached-capture option. Returns the last consumed argv index. */
export function consumeCaptureSourceOption(
  argv: string[],
  index: number,
  options: CaptureSourceOptions,
): number | undefined {
  const arg = argv[index];
  if (arg === '--spec') {
    options.spec = argv[index + 1];
    return index + 1;
  }
  if (arg.startsWith('--spec=')) {
    options.spec = arg.slice(7);
    return index;
  }
  if (arg === '--cache-branch') {
    options.cacheBranch = argv[index + 1];
    return index + 1;
  }
  if (arg.startsWith('--cache-branch=')) {
    options.cacheBranch = arg.slice(15);
    return index;
  }
  if (arg === '--remote') {
    options.remote = argv[index + 1];
    return index + 1;
  }
  if (arg.startsWith('--remote=')) {
    options.remote = arg.slice(9);
    return index;
  }
  return undefined;
}
