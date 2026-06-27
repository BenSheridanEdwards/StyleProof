import fs from 'node:fs';
import { inferBaseRef, materializeRef, GitRefError } from './gitref.js';
import { baseInferenceMessage, baseMapsMessage, missingWorkingMapsMessage } from './cli-errors.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BaseRefCaptureDirs {
  beforeDir: string;
  afterDir: string;
  baseRef: string;
  mapsDir: string;
  tmpBase: string;
}

function exitUsage(usage: string): never {
  console.error(usage);
  process.exit(2);
}

function inferBaseRefOrExit(command: string): string {
  try {
    return inferBaseRef();
  } catch (e) {
    console.error(e instanceof GitRefError ? baseInferenceMessage(command, e.message) : errorMessage(e));
    process.exit(2);
  }
}

function selectBaseRef(options: {
  command: string;
  baseRef: string | null;
  mapsDir: string;
  args: string[];
  usage: string;
}) {
  const { command, args, usage } = options;
  if (options.baseRef) {
    if (args.length > 1) exitUsage(usage);
    return { baseRef: options.baseRef, mapsDir: args[0] ?? options.mapsDir };
  }
  if (args.length === 1) return { baseRef: args[0], mapsDir: options.mapsDir };
  return { baseRef: inferBaseRefOrExit(command), mapsDir: options.mapsDir };
}

function materializeBaseRefOrExit(command: string, baseRef: string, mapsDir: string): string {
  try {
    return materializeRef(baseRef, mapsDir);
  } catch (e) {
    console.error(e instanceof GitRefError ? baseMapsMessage(command, e.message, baseRef, mapsDir) : errorMessage(e));
    process.exit(2);
  }
}

export function resolveBaseRefCaptureDirs(options: {
  command: string;
  baseRef: string | null;
  mapsDir: string;
  args: string[];
  usage: string;
}): BaseRefCaptureDirs {
  const { command } = options;
  const { baseRef, mapsDir } = selectBaseRef(options);
  if (!fs.existsSync(mapsDir)) {
    console.error(missingWorkingMapsMessage(command, mapsDir));
    process.exit(2);
  }
  const tmpBase = materializeBaseRefOrExit(command, baseRef, mapsDir);
  return { beforeDir: tmpBase, afterDir: mapsDir, baseRef, mapsDir, tmpBase };
}

export function cleanupBaseRefCaptureDirs(captureDirs: BaseRefCaptureDirs | null): void {
  if (captureDirs) fs.rmSync(captureDirs.tmpBase, { recursive: true, force: true });
}
