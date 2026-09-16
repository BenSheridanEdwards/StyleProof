// Two-directory compare guards: trusted source-SHA binding, the same-environment
// compatibility check, and the manifest-less (legacy bundle) refusal.
import fs from 'node:fs';
import { errorMessage } from '../util.js';
import { MAP_MANIFEST, MapStoreError, isMapFile } from './bundle.js';
import { type MapManifest, readMapManifest } from './manifest.js';

type SourceBindingSide = {
  expected: string | null;
  observed: string | null;
  result: 'matched' | 'no-capture' | 'unverified';
};

export type SourceBindingReceipt = {
  status: 'bound' | 'unverified';
  compatibility: 'matched' | 'not-applicable';
  applicationDependencyProvenance?: {
    status: 'matched' | 'changed';
    before: { lockfile: string; lockfileHash: string };
    after: { lockfile: string; lockfileHash: string };
  };
  before: SourceBindingSide;
  after: SourceBindingSide;
};

type ExpectedShas = { beforeSha?: string; afterSha?: string };

function validateExpectedSourceShas(expected: ExpectedShas): void {
  if ((expected.beforeSha === undefined) !== (expected.afterSha === undefined)) {
    throw new MapStoreError('trusted before and after SHAs must be supplied together');
  }
  for (const side of ['before', 'after'] as const) {
    const sha = expected[`${side}Sha`];
    if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
      throw new MapStoreError(`trusted ${side} SHA must be a full lowercase commit SHA`);
    }
  }
}

/** CLI-flag validation for `--expected-before-sha` / `--expected-after-sha`; the message, or null. */
export function expectedSourceShaFlagsError(input: {
  beforeProvided: boolean;
  beforeSha?: string;
  afterProvided: boolean;
  afterSha?: string;
}): string | null {
  try {
    validateExpectedSourceShas({
      beforeSha: input.beforeProvided ? (input.beforeSha ?? '') : undefined,
      afterSha: input.afterProvided ? (input.afterSha ?? '') : undefined,
    });
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

/** True if `dir` holds at least one captured surface map, ignoring metadata sidecars. */
function dirHasMaps(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(isMapFile);
  } catch {
    return false;
  }
}

function comparableManifest(dir: string): MapManifest | null {
  const manifest = readMapManifest(dir);
  if (!manifest && dirHasMaps(dir))
    throw new MapStoreError('capture manifest is unavailable for a map-bearing directory');
  return manifest;
}

function assertBoundManifest(manifest: MapManifest | null, expectedSha: string | undefined, side: string): void {
  if (expectedSha === undefined || !manifest) return;
  if (manifest.dirty) throw new MapStoreError('dirty capture cannot bind to a trusted commit SHA');
  if (manifest.sha !== expectedSha) throw new MapStoreError(`${side} capture source does not match the trusted SHA`);
}

function sourceBindingSide(manifest: MapManifest | null, expectedSha: string | undefined): SourceBindingSide {
  const result = expectedSha === undefined ? 'unverified' : manifest ? 'matched' : 'no-capture';
  return { expected: expectedSha ?? null, observed: manifest?.sha ?? null, result };
}

const lockfilePair = (manifest: MapManifest | null) =>
  manifest?.lockfile && manifest.lockfileHash
    ? { lockfile: manifest.lockfile, lockfileHash: manifest.lockfileHash }
    : undefined;

function sourceBindingReceipt(
  before: MapManifest | null,
  after: MapManifest | null,
  expected: ExpectedShas,
): SourceBindingReceipt {
  const beforeLock = lockfilePair(before);
  const afterLock = lockfilePair(after);
  const same = beforeLock?.lockfile === afterLock?.lockfile && beforeLock?.lockfileHash === afterLock?.lockfileHash;
  return {
    status: expected.beforeSha !== undefined && expected.afterSha !== undefined ? 'bound' : 'unverified',
    compatibility: before && after ? 'matched' : 'not-applicable',
    ...(beforeLock && afterLock
      ? {
          applicationDependencyProvenance: {
            status: same ? 'matched' : 'changed',
            before: beforeLock,
            after: afterLock,
          },
        }
      : {}),
    before: sourceBindingSide(before, expected.beforeSha),
    after: sourceBindingSide(after, expected.afterSha),
  };
}

function runtimeIdentity(manifest: MapManifest, includeBrowser: boolean): string {
  return JSON.stringify({
    platform: manifest.platform,
    arch: manifest.arch,
    nodeMajor: manifest.nodeMajor,
    playwrightVersion: manifest.playwrightVersion ?? '',
    baseUrl: manifest.baseUrl ?? '',
    ...(includeBrowser ? { browserVersion: manifest.browserVersion } : {}),
  });
}

const SAME_ENVIRONMENT_NEXT =
  '\nNext: rebuild one side with styleproof-map in the same environment, or let CI recapture both maps.';

function assertCompatibleManifests(before: MapManifest, after: MapManifest): void {
  if (before.compatibilityKey !== after.compatibilityKey) {
    throw new MapStoreError(
      `maps were captured with different capture compatibility contracts${SAME_ENVIRONMENT_NEXT}`,
    );
  }
  // The browser build is optional for older bundles; compare it only when both sides carry it.
  const includeBrowser = Boolean(before.browserVersion && after.browserVersion);
  if (runtimeIdentity(before, includeBrowser) !== runtimeIdentity(after, includeBrowser)) {
    throw new MapStoreError(`maps were captured in different runtime environments${SAME_ENVIRONMENT_NEXT}`);
  }
}

/** Refuse to compare captures from different environments or untrusted sources; returns
 *  the binding receipt the diff/report JSON carries. */
export function assertCompatibleMapDirs(
  beforeDir: string,
  afterDir: string,
  expected: ExpectedShas = {},
): SourceBindingReceipt {
  validateExpectedSourceShas(expected);
  const before = comparableManifest(beforeDir);
  const after = comparableManifest(afterDir);
  assertBoundManifest(before, expected.beforeSha, 'before');
  assertBoundManifest(after, expected.afterSha, 'after');
  const receipt = sourceBindingReceipt(before, after, expected);
  if (before && after) assertCompatibleManifests(before, after);
  return receipt;
}

/** Which side(s) hold captured maps but NO manifest (a legacy committed-map bundle, refused
 *  since v4). A side with zero maps is "no baseline yet" and is NOT flagged. */
export function manifestlessSide(beforeDir: string, afterDir: string): 'before' | 'after' | 'both' | null {
  const before = dirHasMaps(beforeDir) && readMapManifest(beforeDir) == null;
  const after = dirHasMaps(afterDir) && readMapManifest(afterDir) == null;
  if (before && after) return 'both';
  return before ? 'before' : after ? 'after' : null;
}

/** Fail-loud message for a manifest-less compare (the CLI exits 2). */
export function manifestlessError(side: 'before' | 'after' | 'both'): string {
  const carry = side === 'both' ? 'before and after carry' : `${side} carries`;
  return (
    `styleproof: ${carry} no ${MAP_MANIFEST} — environment compatibility can't be verified, so ` +
    'captures from different browser builds or platforms would diff as false changes. ' +
    'Re-capture with current StyleProof (styleproof-map, or styleproof-capture for a one-shot ' +
    'diff); maps without a manifest are unsupported since v4.'
  );
}
