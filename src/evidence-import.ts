import fs from 'node:fs';
import path from 'node:path';
import { auditCoverage, COVERAGE_LEDGER, type CoverageLedger } from './coverage.js';
import { bundleSurfaceKeys, readCoverageLedgerLenient } from './confidence-ledger.js';
import { createEvidenceCapture, EvidenceStoreError } from './evidence-store.js';
import {
  isMapFile,
  isOwnedCaptureArtifact,
  isSurfaceCaptureFailureArtifact,
  MAP_MANIFEST,
  readMapManifest,
  SURFACE_CAPTURE_FAILURES_DIR,
} from './map-store.js';
import { readRegularFileNoFollow } from './safe-filesystem.js';

export type ImportMapBundleOptions = {
  bundleDirectory: string;
  storeRoot: string;
  includeHar?: boolean;
};

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOwnedTopLevelEntriesAreReadableFiles(bundleDirectory: string, includeHar: boolean): void {
  for (const entry of fs.readdirSync(bundleDirectory, { withFileTypes: true })) {
    const ownedHar = includeHar && /@\d+\.har$/i.test(entry.name);
    if (!isOwnedCaptureArtifact(entry.name) && !isMapFile(entry.name) && !ownedHar) continue;
    const relative = entry.name;
    const absolute = path.join(bundleDirectory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new EvidenceStoreError(`refusing symbolic link in map bundle: ${relative}`);
    if (stat.isDirectory() && entry.name === SURFACE_CAPTURE_FAILURES_DIR) continue;
    if (!stat.isFile()) throw new EvidenceStoreError(`refusing non-regular map bundle entry: ${relative}`);
  }
}

function readCoverageStrict(bundleDirectory: string): CoverageLedger | null {
  const ledgerPath = path.join(bundleDirectory, COVERAGE_LEDGER);
  if (!fs.existsSync(ledgerPath)) return null;
  const ledger = readCoverageLedgerLenient(bundleDirectory);
  if (!ledger) throw new EvidenceStoreError(`malformed ${COVERAGE_LEDGER} in ${bundleDirectory}`);
  return ledger;
}

function listBundleFiles(bundleDirectory: string, includeHar: boolean): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const readOwnedDirectory = (directory: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((candidate) => isSurfaceCaptureFailureArtifact(candidate.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new EvidenceStoreError(`refusing symbolic link in map bundle: ${relative}`);
      if (!entry.isFile()) throw new EvidenceStoreError(`refusing non-regular map bundle entry: ${relative}`);
      files.push({ path: relative, bytes: readRegularFileNoFollow(absolute) });
    }
  };

  for (const entry of fs
    .readdirSync(bundleDirectory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const ownedHar = includeHar && /@\d+\.har$/i.test(entry.name);
    if (!isOwnedCaptureArtifact(entry.name) && !ownedHar) continue;
    const absolute = path.join(bundleDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new EvidenceStoreError(`refusing symbolic link in map bundle: ${entry.name}`);
    if (entry.isDirectory()) {
      if (entry.name !== SURFACE_CAPTURE_FAILURES_DIR) {
        throw new EvidenceStoreError(`refusing generated capture artifact directory: ${entry.name}`);
      }
      readOwnedDirectory(absolute, entry.name);
      continue;
    }
    if (!entry.isFile()) throw new EvidenceStoreError(`refusing non-regular map bundle entry: ${entry.name}`);
    files.push({ path: entry.name, bytes: readRegularFileNoFollow(absolute) });
  }
  return files;
}

export function importMapBundleToEvidenceStore(options: ImportMapBundleOptions) {
  const bundleDirectory = path.resolve(options.bundleDirectory);
  const storeRoot = path.resolve(options.storeRoot);
  if (!fs.existsSync(bundleDirectory) || !fs.statSync(bundleDirectory).isDirectory()) {
    throw new EvidenceStoreError(`map bundle directory does not exist: ${bundleDirectory}`);
  }
  if (pathIsInside(bundleDirectory, storeRoot)) {
    throw new EvidenceStoreError('evidence store root must not be inside the imported map bundle');
  }
  const includeHar = options.includeHar === true;
  assertOwnedTopLevelEntriesAreReadableFiles(bundleDirectory, includeHar);

  const manifestPath = path.join(bundleDirectory, MAP_MANIFEST);
  const manifest = readMapManifest(bundleDirectory);
  if (!fs.existsSync(manifestPath)) throw new EvidenceStoreError(`no ${MAP_MANIFEST} in ${bundleDirectory}`);
  if (
    !manifest ||
    typeof manifest.sha !== 'string' ||
    manifest.sha.length === 0 ||
    typeof manifest.compatibilityKey !== 'string' ||
    manifest.compatibilityKey.length === 0
  ) {
    throw new EvidenceStoreError(`malformed ${MAP_MANIFEST} in ${bundleDirectory}`);
  }

  const coverageLedger = readCoverageStrict(bundleDirectory);
  const coverage = auditCoverage(bundleSurfaceKeys(bundleDirectory, coverageLedger?.expected ?? null), coverageLedger);
  const determinism = coverageLedger?.determinism;
  const determinismStatus =
    determinism === 'self-checked' || determinism === 'replayed'
      ? 'proven'
      : determinism === 'unproven'
        ? 'unproven'
        : 'unknown';

  return createEvidenceCapture(storeRoot, {
    source: {
      sha: manifest.sha,
      compatibilityKey: manifest.compatibilityKey,
    },
    trust: {
      coverageBasis: coverage.basis,
      determinismStatus,
    },
    files: listBundleFiles(bundleDirectory, includeHar),
  });
}
