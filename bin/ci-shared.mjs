// Pieces shared by the two commands that restore-then-capture through
// styleproof-map: styleproof-ci (the runner) and styleproof-prepush (the hook).
import path from 'node:path';
import { classifyRestoreExit } from '../dist/ci.js';
import { resolveStyleProofConfigPath, specPathForCwd } from '../dist/config.js';
import { decodeSpecPathEnv, validateRepoRelativeSpecPath } from './spec-path-env.mjs';
import { runBin } from './cli.mjs';

export const DEFAULT_SPEC = 'e2e/styleproof.spec.ts';

/** An error that names the exit code the command should end with. */
export class ExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The spec governing one checkout: its config's spec (made relative to `cwd`), else
 *  `fallback`, else the hook-encoded env, else the default. Repo-relative unless absolute. */
export function checkoutSpec(loaded, cwd, fallback) {
  const declared = loaded.config.spec ?? fallback ?? decodeSpecPathEnv() ?? DEFAULT_SPEC;
  const chosen = loaded.configFile
    ? specPathForCwd(resolveStyleProofConfigPath(declared, loaded.configDir), cwd)
    : declared;
  return path.isAbsolute(chosen) ? chosen : validateRepoRelativeSpecPath(chosen);
}

export const dirtyAllowArgs = (paths) => paths.flatMap((p) => ['--dirty-allow', p]);

/** `styleproof-map --restore`: true on a hit, false on a genuine miss. A persistent
 *  map-store fault (the restore CLI already retried) throws with its exit code. */
export function restoreMap(mapArgs, { cwd, env, dir = '', next } = {}) {
  const r = runBin('styleproof-map', ['--restore', ...mapArgs], { cwd, env });
  if (r.error)
    throw new ExitError(`could not run styleproof-map --restore${dir && ` for ${dir}`}\n${r.error.message}`, 1);
  const outcome = classifyRestoreExit(r.status);
  if (outcome === 'fault') {
    throw new ExitError(
      `${dir && `${dir} `}map restore hit a map-store/network fault (exit ${r.status}). ${next}`,
      r.status ?? 5,
    );
  }
  return outcome === 'hit';
}

/** `styleproof-map` capture: returns the exit status (1 when it could not even spawn). */
export function captureMap(name, args, { cwd, env } = {}) {
  const r = runBin('styleproof-map', args, { cwd, env });
  if (r.error) {
    console.error(`${name}: could not run styleproof-map capture\n${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}
