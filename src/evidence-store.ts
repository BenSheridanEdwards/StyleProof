import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class EvidenceStoreError extends Error {}

export type EvidenceObjectRef = {
  algorithm: 'sha256';
  digest: string;
  size: number;
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceObjectPath(storeRoot: string, reference: EvidenceObjectRef): string {
  if (reference.algorithm !== 'sha256') {
    throw new EvidenceStoreError(`unsupported evidence digest algorithm: ${String(reference.algorithm)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(reference.digest)) {
    throw new EvidenceStoreError(`invalid sha256 evidence digest: ${reference.digest}`);
  }
  if (!Number.isSafeInteger(reference.size) || reference.size < 0) {
    throw new EvidenceStoreError(`invalid evidence object size: ${reference.size}`);
  }
  return path.join(storeRoot, 'objects', 'sha256', reference.digest.slice(0, 2), reference.digest);
}

function verifyEvidenceBytes(reference: EvidenceObjectRef, bytes: Buffer): void {
  const actualDigest = sha256(bytes);
  if (bytes.length !== reference.size || actualDigest !== reference.digest) {
    throw new EvidenceStoreError(
      `evidence object digest mismatch: expected ${reference.digest} (${reference.size} bytes), ` +
        `received ${actualDigest} (${bytes.length} bytes)`,
    );
  }
}

export function readEvidenceObject(storeRoot: string, reference: EvidenceObjectRef): Buffer {
  const objectPath = evidenceObjectPath(storeRoot, reference);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(objectPath);
  } catch (error) {
    throw new EvidenceStoreError(
      `evidence object ${reference.digest} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  verifyEvidenceBytes(reference, bytes);
  return bytes;
}

export function putEvidenceObject(storeRoot: string, input: Uint8Array): EvidenceObjectRef {
  const bytes = Buffer.from(input);
  const reference: EvidenceObjectRef = {
    algorithm: 'sha256',
    digest: sha256(bytes),
    size: bytes.length,
  };
  const objectPath = evidenceObjectPath(storeRoot, reference);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });

  try {
    fs.writeFileSync(objectPath, bytes, { flag: 'wx' });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'EEXIST') {
      throw new EvidenceStoreError(
        `could not store evidence object ${reference.digest}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Verify after either creation or deduplication. A pre-existing corrupted object
  // must fail loudly instead of turning content-addressed identity into a lie.
  readEvidenceObject(storeRoot, reference);
  return reference;
}

export type EvidenceCoverageBasis = 'complete' | 'incomplete' | 'unasserted' | 'unknown';
export type EvidenceDeterminismStatus = 'proven' | 'unproven' | 'unknown';

export type EvidenceCaptureManifest = {
  kind: 'styleproof.capture';
  version: 2;
  source: {
    sha: string;
    compatibilityKey: string;
  };
  trust: {
    coverageBasis: EvidenceCoverageBasis;
    determinismStatus: EvidenceDeterminismStatus;
  };
  files: Array<{
    path: string;
    object: EvidenceObjectRef;
  }>;
};

export type EvidenceCaptureInput = {
  source: EvidenceCaptureManifest['source'];
  trust: EvidenceCaptureManifest['trust'];
  files: Array<{ path: string; bytes: Uint8Array }>;
};

function safeEvidencePath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new EvidenceStoreError(`unsafe evidence path: ${value}`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EvidenceStoreError('evidence manifest contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new EvidenceStoreError(`evidence manifest contains unsupported ${typeof value}`);
}

function isEvidenceObjectRef(value: unknown): value is EvidenceObjectRef {
  if (!value || typeof value !== 'object') return false;
  const reference = value as Partial<EvidenceObjectRef>;
  return (
    reference.algorithm === 'sha256' &&
    typeof reference.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(reference.digest) &&
    Number.isSafeInteger(reference.size) &&
    Number(reference.size) >= 0
  );
}

function assertEvidenceTrust(value: unknown): asserts value is EvidenceCaptureManifest['trust'] {
  if (!value || typeof value !== 'object') throw new EvidenceStoreError('invalid evidence trust: expected an object');
  const trust = value as { coverageBasis?: unknown; determinismStatus?: unknown };
  const coverageBases: readonly unknown[] = ['complete', 'incomplete', 'unasserted', 'unknown'];
  const determinismStatuses: readonly unknown[] = ['proven', 'unproven', 'unknown'];
  if (!coverageBases.includes(trust.coverageBasis) || !determinismStatuses.includes(trust.determinismStatus)) {
    throw new EvidenceStoreError(
      `invalid evidence trust: coverage=${String(trust.coverageBasis)}, determinism=${String(trust.determinismStatus)}`,
    );
  }
}

function parseCaptureManifest(bytes: Buffer): EvidenceCaptureManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new EvidenceStoreError(
      `capture manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') throw new EvidenceStoreError('capture manifest is not an object');
  const manifest = parsed as Partial<EvidenceCaptureManifest>;
  if (
    manifest.kind !== 'styleproof.capture' ||
    manifest.version !== 2 ||
    !manifest.source ||
    typeof manifest.source.sha !== 'string' ||
    typeof manifest.source.compatibilityKey !== 'string' ||
    !manifest.trust ||
    !Array.isArray(manifest.files)
  ) {
    throw new EvidenceStoreError('capture manifest does not match StyleProof evidence schema v2');
  }
  assertEvidenceTrust(manifest.trust);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !isEvidenceObjectRef(file.object)) {
      throw new EvidenceStoreError('capture manifest contains an invalid file entry');
    }
    safeEvidencePath(file.path);
    if (seen.has(file.path)) throw new EvidenceStoreError(`capture manifest contains duplicate path: ${file.path}`);
    seen.add(file.path);
  }
  return manifest as EvidenceCaptureManifest;
}

export function createEvidenceCapture(
  storeRoot: string,
  input: EvidenceCaptureInput,
): { capture: EvidenceObjectRef; manifest: EvidenceCaptureManifest } {
  assertEvidenceTrust(input.trust);
  const sortedFiles = [...input.files].sort((first, second) => first.path.localeCompare(second.path));
  const seen = new Set<string>();
  const files = sortedFiles.map((file) => {
    const evidencePath = safeEvidencePath(file.path);
    if (seen.has(evidencePath)) throw new EvidenceStoreError(`duplicate evidence path: ${evidencePath}`);
    seen.add(evidencePath);
    return { path: evidencePath, object: putEvidenceObject(storeRoot, file.bytes) };
  });
  const manifest: EvidenceCaptureManifest = {
    kind: 'styleproof.capture',
    version: 2,
    source: { ...input.source },
    trust: { ...input.trust },
    files,
  };
  const capture = putEvidenceObject(storeRoot, Buffer.from(canonicalJson(manifest)));
  return { capture, manifest };
}

export function materializeEvidenceCapture(
  storeRoot: string,
  capture: EvidenceObjectRef,
  outputDirectory: string,
): EvidenceCaptureManifest {
  if (fs.existsSync(outputDirectory)) {
    throw new EvidenceStoreError(`refusing to materialize over existing path: ${outputDirectory}`);
  }
  const manifest = parseCaptureManifest(readEvidenceObject(storeRoot, capture));
  const verifiedFiles = manifest.files.map((file) => ({ ...file, bytes: readEvidenceObject(storeRoot, file.object) }));
  const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.mkdirSync(temporaryDirectory, { recursive: false });
    for (const file of verifiedFiles) {
      const destination = path.join(temporaryDirectory, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes, { flag: 'wx' });
    }
    fs.renameSync(temporaryDirectory, outputDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    if (error instanceof EvidenceStoreError) throw error;
    throw new EvidenceStoreError(
      `could not materialize capture ${capture.digest}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return manifest;
}

function evidenceRefPath(storeRoot: string, key: string): string {
  const segments = key.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..')
  ) {
    throw new EvidenceStoreError(`unsafe evidence ref key: ${key}`);
  }
  return path.join(storeRoot, 'refs', ...segments.slice(0, -1), `${segments.at(-1)}.json`);
}

function sameObjectReference(first: EvidenceObjectRef | null, second: EvidenceObjectRef | null): boolean {
  if (first === null || second === null) return first === second;
  return first.algorithm === second.algorithm && first.digest === second.digest && first.size === second.size;
}

export function readEvidenceRef(storeRoot: string, key: string): EvidenceObjectRef | null {
  const referencePath = evidenceRefPath(storeRoot, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return null;
    throw new EvidenceStoreError(
      `could not read evidence ref ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') throw new EvidenceStoreError(`evidence ref ${key} is not an object`);
  const reference = parsed as { kind?: unknown; version?: unknown; capture?: unknown };
  if (reference.kind !== 'styleproof.ref' || reference.version !== 2 || !isEvidenceObjectRef(reference.capture)) {
    throw new EvidenceStoreError(`evidence ref ${key} does not match StyleProof ref schema v2`);
  }
  parseCaptureManifest(readEvidenceObject(storeRoot, reference.capture));
  return reference.capture;
}

export function writeEvidenceRef(
  storeRoot: string,
  key: string,
  capture: EvidenceObjectRef,
  expectedCapture: EvidenceObjectRef | null,
): void {
  parseCaptureManifest(readEvidenceObject(storeRoot, capture));
  const referencePath = evidenceRefPath(storeRoot, key);
  const lockPath = `${referencePath}.lock`;
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });

  let lockDescriptor: number | undefined;
  try {
    try {
      lockDescriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockDescriptor, `${process.pid}\n`);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EEXIST') throw new EvidenceStoreError(`evidence ref ${key} is locked by another publisher`);
      throw error;
    }

    const currentCapture = readEvidenceRef(storeRoot, key);
    if (!sameObjectReference(currentCapture, expectedCapture)) {
      throw new EvidenceStoreError(
        `evidence ref ${key} compare-and-swap failed: expected ${expectedCapture?.digest ?? 'absent'}, ` +
          `found ${currentCapture?.digest ?? 'absent'}`,
      );
    }
    const content = canonicalJson({ kind: 'styleproof.ref', version: 2, capture });
    const temporaryPath = `${referencePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(temporaryPath, content, { flag: 'wx' });
      fs.renameSync(temporaryPath, referencePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  } catch (error) {
    if (error instanceof EvidenceStoreError) throw error;
    throw new EvidenceStoreError(
      `could not update evidence ref ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (lockDescriptor !== undefined) {
      fs.closeSync(lockDescriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }
}
