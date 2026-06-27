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
    `Next: run styleproof-map to create ${dir}, then commit the updated maps.`,
    'If your maps live elsewhere, pass --maps-dir <dir>.',
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

export function baseMapsMessage(command: string, message: string, baseRef: string, mapsDir: string): string {
  return [
    `${command}: ${message}`,
    `Next: make sure ${baseRef} contains committed captures at ${mapsDir}. On the base branch, run styleproof-map and commit ${mapsDir}.`,
  ].join('\n');
}
