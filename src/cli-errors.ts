import { type StyleProofConfig, loadStyleProofConfig, missingStyleProofSpecMessage } from './config.js';
import { errorMessage } from './util.js';

/** The repo's styleproof.config as the lowest-precedence default layer, or a usage-error exit. */
export function projectConfigOrExit(cli: string, cwd = process.cwd()): StyleProofConfig {
  try {
    return loadStyleProofConfig(cwd);
  } catch (error) {
    process.stderr.write(`${cli}: ${errorMessage(error)}\n`);
    process.exit(2);
  }
}

/** "Cached maps couldn't be restored" guidance shared by styleproof-diff and styleproof-report. */
export function cachedMapsUnavailableMessage(command: string, purpose: string, error: unknown): string {
  return [
    `${command}: cached maps are not available for this ${purpose} — nothing was compared`,
    errorMessage(error),
    `Next: run this in CI (or a repo with the 'origin' remote) where the base map is restorable, ` +
      `or capture both sides and compare them directly: ${command} <beforeDir> <afterDir>.`,
  ].join('\n');
}

export function missingSpecMessage(
  spec: string,
  searched?: readonly string[],
  configFile?: string,
  specDeclared?: string,
): string {
  return [
    `styleproof-map: ${missingStyleProofSpecMessage({ spec, specDeclared, configFile, searched })}`,
    'Next: run styleproof-init to scaffold the spec, or pass --spec <path> if your capture spec lives elsewhere.',
  ].join('\n');
}

export function playwrightMissingMessage(message: string): string {
  return [
    `styleproof-map: could not run Playwright (${message})`,
    'Next: install @playwright/test, then run npx playwright install chromium.',
  ].join('\n');
}

export function missingManualCaptureMessage(command: string, dir: string): string {
  return [
    `${command}: no capture at ${dir}`,
    `Next: pass existing capture directories, or run styleproof-map first and use ${command} [baseRef].`,
  ].join('\n');
}

/** A map's compatibility key is platform-specific, so a non-Linux upload is never restored by
 *  the scaffolded ubuntu-latest CI. Warn (not block); null on Linux or when suppressed. */
export function nonLinuxUploadWarning(platform: string, suppressed = false): string | null {
  if (suppressed || platform === 'linux') return null;
  return [
    `styleproof-map: capturing on ${platform}, but StyleProof CI (ubuntu-latest) captures on linux.`,
    "  A map's compatibility key is platform-specific, so a Linux CI will NOT restore this bundle —",
    '  it will recapture both sides instead, and this upload just adds an unused bundle to the store.',
    '  To make the pre-push capture count, capture on Linux (e.g. a container matching CI).',
    '  Suppress this notice with STYLEPROOF_SUPPRESS_PLATFORM_WARNING=1.',
  ].join('\n');
}
