// Pieces shared by the two commands that restore-then-capture through
// styleproof-map: styleproof-ci (the runner) and styleproof-prepush (the hook).
import path from 'node:path';
import { classifyRestoreExit } from '../dist/ci.js';
import { classifyColdReasonFromMissMessage, extractColdReasonFromLog } from '../dist/map-hit-observability.js';
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

/** `styleproof-map --restore`: `{ hit }` on success/miss. A persistent map-store
 *  fault (the restore CLI already retried) throws with its exit code. On miss,
 *  `coldReason` is taken from the structured map-restore line when present. */
export function restoreMap(mapArgs, { cwd, env, dir = '', next } = {}) {
  // Pipe so we can read cold_reason= from the map CLI, then forward streams unchanged.
  const r = runBin('styleproof-map', ['--restore', ...mapArgs], {
    cwd,
    env: { ...env, STYLEPROOF_SUPPRESS_MAP_RESTORE_OBSERVE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = r.stdout?.toString?.('utf8') ?? (typeof r.stdout === 'string' ? r.stdout : '');
  const stderr = r.stderr?.toString?.('utf8') ?? (typeof r.stderr === 'string' ? r.stderr : '');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (r.error)
    throw new ExitError(`could not run styleproof-map --restore${dir && ` for ${dir}`}\n${r.error.message}`, 1);
  const outcome = classifyRestoreExit(r.status);
  if (outcome === 'fault') {
    throw new ExitError(
      `${dir && `${dir} `}map restore hit a map-store/network fault (exit ${r.status}). ${next}`,
      r.status ?? 5,
    );
  }
  if (outcome === 'hit') return { hit: true };
  const combined = `${stdout}\n${stderr}`;
  const coldReason = extractColdReasonFromLog(combined) ?? classifyColdReasonFromMissMessage(combined) ?? 'no_bundle';
  return { hit: false, coldReason };
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
