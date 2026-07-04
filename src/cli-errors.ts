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
 * The "cached maps couldn't be restored" guidance, shared by styleproof-diff and
 * styleproof-report (each names its own `purpose` — "comparison" / "report").
 */
export function cachedMapsUnavailableMessage(command: string, purpose: string, error: unknown): string {
  return [
    `${command}: cached maps are not available for this ${purpose}`,
    cliErrorMessage(error),
    'Next: run styleproof-map on the base and head commits to upload maps, or let CI recapture both sides.',
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
