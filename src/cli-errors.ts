import { type StyleProofConfig, loadStyleProofConfig } from './config.js';

export function isHelpArg(arg: string | undefined): boolean {
  return arg === '-h' || arg === '--help';
}

export function showHelpAndExit(help: string): never {
  process.stdout.write(help);
  process.exit(0);
}

export function cliErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shared CLI prologue: the repo's styleproof.config.json as the lowest-precedence
 * default layer (flag > env > file > built-in), or a loud usage-error exit —
 * config the user wrote must never be silently dropped.
 */
export function projectConfigOrExit(cli: string, cwd = process.cwd()): StyleProofConfig {
  try {
    return loadStyleProofConfig(cwd);
  } catch (error) {
    process.stderr.write(`${cli}: ${cliErrorMessage(error)}\n`);
    process.exit(2);
  }
}

/**
 * The "cached maps couldn't be restored" guidance, shared by styleproof-diff and
 * styleproof-report (each names its own `purpose` — "comparison" / "report").
 */
export function cachedMapsUnavailableMessage(command: string, purpose: string, error: unknown): string {
  return [
    `${command}: cached maps are not available for this ${purpose} — nothing was compared`,
    cliErrorMessage(error),
    // Name the two ways forward explicitly so a newcomer never reads "nothing compared"
    // as "certified clean": the cached-map path only works where the base is restorable
    // (CI, or a repo with the map-store remote), and the two-directory form always works
    // off already-captured maps with no git remote at all.
    `Next: run this in CI (or a repo with the 'origin' remote) where the base map is restorable, ` +
      `or capture both sides and compare them directly: ${command} <beforeDir> <afterDir>.`,
  ].join('\n');
}

export function unknownFlagMessage(command: string, flag: string): string {
  return `${command}: unknown flag: ${flag}\nNext: run ${command} --help to see supported options.`;
}

export function missingSpecMessage(spec: string): string {
  return [
    `styleproof-map: no StyleProof spec at ${spec}`,
    'Next: run styleproof-init to scaffold the spec, or pass --spec <path> if your capture spec lives elsewhere.',
  ].join('\n');
}

export function playwrightMissingMessage(message: string): string {
  return [
    `styleproof-map: could not run Playwright (${message})`,
    'Next: install @playwright/test, then run npx playwright install chromium.',
  ].join('\n');
}

export function missingWorkingMapsMessage(command: string, dir: string): string {
  return [
    `${command}: no capture at ${dir}`,
    `Next: run styleproof-map to create ${dir}, or run styleproof-map --restore --sha <commit> to restore it from the map store.`,
    'If your maps live elsewhere, pass explicit capture directories.',
  ].join('\n');
}

export function missingManualCaptureMessage(command: string, dir: string): string {
  return [
    `${command}: no capture at ${dir}`,
    `Next: pass existing capture directories, or run styleproof-map first and use ${command} [baseRef].`,
  ].join('\n');
}

export function baseInferenceMessage(command: string, message: string): string {
  return [
    `${command}: ${message}`,
    `Next: pass a base ref explicitly, e.g. ${command} main, or set git config branch.<name>.gh-merge-base main.`,
  ].join('\n');
}

/**
 * Advisory shown when a map is uploaded from a non-Linux platform. A map's
 * compatibility key is platform-specific, and the scaffolded CI runs on
 * `ubuntu-latest` — so a bundle captured on macOS/Windows can never be restored by
 * that Linux CI, which recaptures instead. The upload isn't wrong (CI may be
 * non-Linux, or the user knows better), so this warns rather than blocks. Returns
 * `null` on Linux (and when suppressed via `STYLEPROOF_SUPPRESS_PLATFORM_WARNING=1`).
 */
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
