import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  assessPhase0Contract,
  serializePhase0Contract,
  type Phase0Assertion,
  type Phase0Comparability,
  type Phase0ContractDocument,
  type Phase0Identity,
  type Phase0IntegrityJoin,
  type Phase0Obligation,
  type Phase0Reason,
  type Phase0Relation,
  type Phase0SourceRun,
} from './phase0-contract.js';

export type ReleaseConfidenceManifest = {
  kind: 'styleproof.release-confidence';
  version: '0.1';
  manifestId: string;
  producer: { name: 'styleproof'; version: string };
  sourceSha: string;
  compatibilityKey: string;
  declaredScope: { id: string; surfaces: string[] };
  manifestDigest: string;
  contractId: string;
  identities: Phase0Identity[];
  assertions: Phase0Assertion[];
  sourceRuns: Phase0SourceRun[];
  obligations: Phase0Obligation[];
  relations: Phase0Relation[];
  comparability: Phase0Comparability[];
  evidenceJoins: Phase0IntegrityJoin[];
  exclusions: string[];
  gaps: {
    sourceRuns: string[];
    obligations: string[];
    comparability: string[];
  };
};

export type ReleaseConfidenceManifestReason =
  Phase0Reason | 'manifest-absent' | 'manifest-invalid' | 'manifest-digest-mismatch' | 'manifest-projection-mismatch';

export type ReleaseConfidenceManifestReceipt = {
  presence: 'present' | 'present-invalid' | 'absent-legacy';
  certifies: boolean;
  status: 'valid' | 'invalid' | 'unproven';
  manifestDigest?: string;
  reasons: ReleaseConfidenceManifestReason[];
};

export class ReleaseConfidenceManifestError extends Error {
  constructor() {
    super('styleproof: release confidence manifest is unreadable');
    this.name = 'ReleaseConfidenceManifestError';
  }
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPATIBILITY_KEY = /^[0-9a-f]{16}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)?.get;
const MAX_JSON_DEPTH = 64;
const MANIFEST_FIELDS = new Set([
  'kind',
  'version',
  'manifestId',
  'producer',
  'sourceSha',
  'compatibilityKey',
  'declaredScope',
  'manifestDigest',
  'contractId',
  'identities',
  'assertions',
  'sourceRuns',
  'obligations',
  'relations',
  'comparability',
  'evidenceJoins',
  'exclusions',
  'gaps',
]);
const PRODUCER_FIELDS = new Set(['name', 'version']);
const SCOPE_FIELDS = new Set(['id', 'surfaces']);
const GAP_FIELDS = new Set(['sourceRuns', 'obligations', 'comparability']);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareText);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareText)
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function hasExactKeys(value: unknown, fields: Set<string>): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
    const keys = Reflect.ownKeys(value);
    return (
      keys.every((key): key is string => typeof key === 'string') &&
      keys.length === fields.size &&
      keys.every((key) => {
        if (!fields.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !!descriptor && descriptor.enumerable === true && 'value' in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function snapshotOwnArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== 'string')) return undefined;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function plainDataChildren(value: object): unknown[] | undefined {
  if (types.isProxy(value)) return undefined;
  if (Array.isArray(value)) return snapshotOwnArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const children: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return undefined;
    children.push(descriptor.value);
  }
  return children;
}

function isPlainDataTree(value: unknown): boolean {
  try {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) continue;
      if (typeof current !== 'object' || seen.has(current)) return false;
      seen.add(current);
      const children = plainDataChildren(current);
      if (!children) return false;
      pending.push(...children);
    }
    return true;
  } catch {
    return false;
  }
}

function snapshotTextArray(value: unknown): string[] | undefined {
  const snapshot = snapshotOwnArray(value);
  if (!snapshot) return undefined;
  if (snapshot.some((entry) => typeof entry !== 'string' || !OPAQUE.test(entry))) return undefined;
  return snapshot as string[];
}

type JsonCursor = { source: string; offset: number; duplicate: boolean };

function skipJsonSpace(cursor: JsonCursor): void {
  while (/\s/.test(cursor.source[cursor.offset] ?? '')) cursor.offset++;
}

function readJsonString(cursor: JsonCursor): string {
  const start = cursor.offset++;
  while (cursor.offset < cursor.source.length) {
    if (cursor.source[cursor.offset] === '\\') {
      cursor.offset += 2;
      continue;
    }
    if (cursor.source[cursor.offset++] === '"') {
      return JSON.parse(cursor.source.slice(start, cursor.offset)) as string;
    }
  }
  return '';
}

function skipJsonArray(cursor: JsonCursor, depth: number): void {
  cursor.offset++;
  skipJsonSpace(cursor);
  while (cursor.source[cursor.offset] !== ']') {
    skipJsonValue(cursor, depth + 1);
    skipJsonSpace(cursor);
    if (cursor.source[cursor.offset] !== ',') break;
    cursor.offset++;
    skipJsonSpace(cursor);
  }
  cursor.offset++;
}

function skipJsonObject(cursor: JsonCursor, depth: number): void {
  cursor.offset++;
  const keys = new Set<string>();
  skipJsonSpace(cursor);
  while (cursor.source[cursor.offset] !== '}') {
    const key = readJsonString(cursor);
    if (keys.has(key)) cursor.duplicate = true;
    keys.add(key);
    skipJsonSpace(cursor);
    cursor.offset++;
    skipJsonValue(cursor, depth + 1);
    skipJsonSpace(cursor);
    if (cursor.source[cursor.offset] !== ',') break;
    cursor.offset++;
    skipJsonSpace(cursor);
  }
  cursor.offset++;
}

function skipJsonValue(cursor: JsonCursor, depth: number): void {
  skipJsonSpace(cursor);
  const character = cursor.source[cursor.offset];
  if (character === '{') {
    if (depth > MAX_JSON_DEPTH) throw new ReleaseConfidenceManifestError();
    skipJsonObject(cursor, depth);
    return;
  }
  if (character === '[') {
    if (depth > MAX_JSON_DEPTH) throw new ReleaseConfidenceManifestError();
    skipJsonArray(cursor, depth);
    return;
  }
  if (character === '"') {
    readJsonString(cursor);
    return;
  }
  while (cursor.offset < cursor.source.length && !/[\s,\]}]/.test(cursor.source[cursor.offset] ?? '')) {
    cursor.offset++;
  }
}

function hasDuplicateJsonKeys(source: string): boolean {
  const cursor: JsonCursor = { source, offset: 0, duplicate: false };
  skipJsonValue(cursor, 1);
  return cursor.duplicate;
}

function phase0Document(manifest: ReleaseConfidenceManifest): Phase0ContractDocument {
  const identities = snapshotOwnArray(manifest.identities) as Phase0Identity[] | undefined;
  const assertions = snapshotOwnArray(manifest.assertions) as Phase0Assertion[] | undefined;
  const sourceRuns = snapshotOwnArray(manifest.sourceRuns) as Phase0SourceRun[] | undefined;
  const obligations = snapshotOwnArray(manifest.obligations) as Phase0Obligation[] | undefined;
  const relations = snapshotOwnArray(manifest.relations) as Phase0Relation[] | undefined;
  const comparability = snapshotOwnArray(manifest.comparability) as Phase0Comparability[] | undefined;
  const integrity = snapshotOwnArray(manifest.evidenceJoins) as Phase0IntegrityJoin[] | undefined;
  if (
    !identities ||
    !assertions ||
    !sourceRuns ||
    !obligations ||
    !relations ||
    !comparability ||
    !integrity ||
    ![identities, assertions, sourceRuns, obligations, relations, comparability, integrity].every(isPlainDataTree)
  ) {
    throw new ReleaseConfidenceManifestError();
  }
  return {
    version: '0.1',
    documentId: manifest.contractId,
    identities,
    assertions,
    sourceRuns,
    obligations,
    relations,
    comparability,
    integrity,
  };
}

function canonicalContract(document: Phase0ContractDocument): Phase0ContractDocument {
  return JSON.parse(serializePhase0Contract(document)) as Phase0ContractDocument;
}

function projection(
  document: Phase0ContractDocument,
): Pick<
  ReleaseConfidenceManifest,
  | 'contractId'
  | 'identities'
  | 'assertions'
  | 'sourceRuns'
  | 'obligations'
  | 'relations'
  | 'comparability'
  | 'evidenceJoins'
  | 'exclusions'
  | 'gaps'
> & { surfaces: string[] } {
  const contract = canonicalContract(document);
  const assertions = contract.assertions ?? [];
  const sourceRuns = contract.sourceRuns ?? [];
  const obligations = contract.obligations ?? [];
  const comparability = contract.comparability ?? [];
  return {
    contractId: contract.documentId,
    identities: contract.identities ?? [],
    assertions,
    sourceRuns,
    obligations,
    relations: contract.relations ?? [],
    comparability,
    evidenceJoins: contract.integrity ?? [],
    exclusions: uniqueSorted(assertions.filter((entry) => entry.mode === 'excluded').map((entry) => entry.id)),
    gaps: {
      sourceRuns: uniqueSorted(
        sourceRuns
          .filter((entry) => entry.execution !== 'complete' || entry.closure !== 'enumerated')
          .map((entry) => entry.id),
      ),
      obligations: uniqueSorted(obligations.filter((entry) => entry.outcome !== 'satisfied').map((entry) => entry.id)),
      comparability: uniqueSorted(
        comparability.filter((entry) => entry.required && entry.status !== 'comparable').map((entry) => entry.surface),
      ),
    },
    surfaces: uniqueSorted(obligations.map((entry) => entry.surface)),
  };
}

function only(values: Iterable<string>): string | undefined {
  const unique = uniqueSorted(values);
  return unique.length === 1 ? unique[0] : undefined;
}

function digestPayload(manifest: ReleaseConfidenceManifest): Omit<ReleaseConfidenceManifest, 'manifestDigest'> {
  const projected = projection(phase0Document(manifest));
  return {
    kind: manifest.kind,
    version: manifest.version,
    manifestId: manifest.manifestId,
    producer: { name: manifest.producer.name, version: manifest.producer.version },
    sourceSha: manifest.sourceSha,
    compatibilityKey: manifest.compatibilityKey,
    declaredScope: { id: manifest.declaredScope.id, surfaces: projected.surfaces },
    contractId: projected.contractId,
    identities: projected.identities,
    assertions: projected.assertions,
    sourceRuns: projected.sourceRuns,
    obligations: projected.obligations,
    relations: projected.relations,
    comparability: projected.comparability,
    evidenceJoins: projected.evidenceJoins,
    exclusions: projected.exclusions,
    gaps: projected.gaps,
  };
}

export function digestReleaseConfidenceManifest(manifest: ReleaseConfidenceManifest): string {
  return createHash('sha256')
    .update(canonicalJson(digestPayload(manifest)))
    .digest('hex');
}

export function createReleaseConfidenceManifest(input: {
  manifestId: string;
  producerVersion: string;
  releaseScope: string;
  contract: Phase0ContractDocument;
}): ReleaseConfidenceManifest {
  const receipt = assessPhase0Contract(input.contract);
  if (receipt.presence !== 'present') throw new ReleaseConfidenceManifestError();
  const projected = projection(input.contract);
  const sourceSha = only(projected.sourceRuns.map((entry) => entry.sourceSha));
  const compatibilityKey = only(projected.sourceRuns.map((entry) => entry.compatibilityKey));
  if (
    !OPAQUE.test(input.manifestId) ||
    !OPAQUE.test(input.producerVersion) ||
    !OPAQUE.test(input.releaseScope) ||
    !sourceSha ||
    !compatibilityKey
  ) {
    throw new ReleaseConfidenceManifestError();
  }
  const withoutDigest: Omit<ReleaseConfidenceManifest, 'manifestDigest'> = {
    kind: 'styleproof.release-confidence',
    version: '0.1',
    manifestId: input.manifestId,
    producer: { name: 'styleproof', version: input.producerVersion },
    sourceSha,
    compatibilityKey,
    declaredScope: { id: input.releaseScope, surfaces: projected.surfaces },
    contractId: projected.contractId,
    identities: projected.identities,
    assertions: projected.assertions,
    sourceRuns: projected.sourceRuns,
    obligations: projected.obligations,
    relations: projected.relations,
    comparability: projected.comparability,
    evidenceJoins: projected.evidenceJoins,
    exclusions: projected.exclusions,
    gaps: projected.gaps,
  };
  const manifest = { ...withoutDigest, manifestDigest: '' } as ReleaseConfidenceManifest;
  manifest.manifestDigest = digestReleaseConfidenceManifest(manifest);
  return manifest;
}

function reflective(value: unknown): boolean {
  try {
    return !!value && typeof value === 'object' && types.isProxy(value);
  } catch {
    return true;
  }
}

function hasValidProducer(value: unknown): value is ReleaseConfidenceManifest['producer'] {
  if (reflective(value) || !hasExactKeys(value, PRODUCER_FIELDS)) return false;
  const producer = value as Partial<ReleaseConfidenceManifest['producer']>;
  return producer.name === 'styleproof' && typeof producer.version === 'string' && OPAQUE.test(producer.version);
}

function hasValidContractArrays(manifest: Partial<ReleaseConfidenceManifest>): boolean {
  return [
    manifest.identities,
    manifest.assertions,
    manifest.sourceRuns,
    manifest.obligations,
    manifest.relations,
    manifest.comparability,
    manifest.evidenceJoins,
  ].every(Array.isArray);
}

function hasValidGaps(value: unknown): value is ReleaseConfidenceManifest['gaps'] {
  if (reflective(value) || !hasExactKeys(value, GAP_FIELDS)) return false;
  const gaps = value as Partial<ReleaseConfidenceManifest['gaps']>;
  return [gaps.sourceRuns, gaps.obligations, gaps.comparability].every(
    (entry) => snapshotTextArray(entry) !== undefined,
  );
}

function hasValidScope(value: unknown): value is ReleaseConfidenceManifest['declaredScope'] {
  if (reflective(value) || !hasExactKeys(value, SCOPE_FIELDS)) return false;
  const scope = value as Partial<ReleaseConfidenceManifest['declaredScope']>;
  return typeof scope.id === 'string' && OPAQUE.test(scope.id) && snapshotTextArray(scope.surfaces) !== undefined;
}

function hasValidManifestScalars(manifest: Partial<ReleaseConfidenceManifest>): boolean {
  return (
    manifest.kind === 'styleproof.release-confidence' &&
    manifest.version === '0.1' &&
    typeof manifest.manifestId === 'string' &&
    OPAQUE.test(manifest.manifestId) &&
    typeof manifest.sourceSha === 'string' &&
    GIT_SHA.test(manifest.sourceSha) &&
    typeof manifest.compatibilityKey === 'string' &&
    COMPATIBILITY_KEY.test(manifest.compatibilityKey) &&
    typeof manifest.manifestDigest === 'string' &&
    SHA256.test(manifest.manifestDigest) &&
    typeof manifest.contractId === 'string'
  );
}

function isManifestShape(value: unknown): value is ReleaseConfidenceManifest {
  if (reflective(value) || !hasExactKeys(value, MANIFEST_FIELDS)) return false;
  const manifest = value as Partial<ReleaseConfidenceManifest>;
  return (
    hasValidManifestScalars(manifest) &&
    hasValidProducer(manifest.producer) &&
    hasValidContractArrays(manifest) &&
    snapshotTextArray(manifest.exclusions) !== undefined &&
    hasValidGaps(manifest.gaps) &&
    hasValidScope(manifest.declaredScope)
  );
}

function sameProjection(manifest: ReleaseConfidenceManifest): boolean {
  const exclusions = snapshotTextArray(manifest.exclusions);
  const sourceRuns = snapshotTextArray(manifest.gaps.sourceRuns);
  const obligations = snapshotTextArray(manifest.gaps.obligations);
  const comparability = snapshotTextArray(manifest.gaps.comparability);
  const surfaces = snapshotTextArray(manifest.declaredScope.surfaces);
  if (!exclusions || !sourceRuns || !obligations || !comparability || !surfaces) return false;
  const projected = projection(phase0Document(manifest));
  return (
    manifest.contractId === projected.contractId &&
    canonicalJson(sorted(exclusions)) === canonicalJson(projected.exclusions) &&
    canonicalJson(sorted(sourceRuns)) === canonicalJson(projected.gaps.sourceRuns) &&
    canonicalJson(sorted(obligations)) === canonicalJson(projected.gaps.obligations) &&
    canonicalJson(sorted(comparability)) === canonicalJson(projected.gaps.comparability) &&
    canonicalJson(sorted(surfaces)) === canonicalJson(projected.surfaces)
  );
}

function validateKnownReleaseConfidenceManifest(input?: unknown): ReleaseConfidenceManifestReceipt {
  if (input === undefined) {
    return { presence: 'absent-legacy', certifies: false, status: 'unproven', reasons: ['manifest-absent'] };
  }
  if (!isManifestShape(input)) {
    return { presence: 'present-invalid', certifies: false, status: 'invalid', reasons: ['manifest-invalid'] };
  }
  const reasons = new Set<ReleaseConfidenceManifestReason>();
  const contractReceipt = assessPhase0Contract(phase0Document(input));
  for (const reason of contractReceipt.reasons) reasons.add(reason);
  if (!sameProjection(input)) reasons.add('manifest-projection-mismatch');
  if (input.manifestDigest !== digestReleaseConfidenceManifest(input)) reasons.add('manifest-digest-mismatch');
  if (only(input.sourceRuns.map((entry) => entry.sourceSha)) !== input.sourceSha) {
    reasons.add('manifest-projection-mismatch');
  }
  if (only(input.sourceRuns.map((entry) => entry.compatibilityKey)) !== input.compatibilityKey) {
    reasons.add('manifest-projection-mismatch');
  }
  const sortedReasons = [...reasons].sort(compareText);
  const manifestInvalid =
    contractReceipt.presence !== 'present' ||
    sortedReasons.some((reason) =>
      ['manifest-invalid', 'manifest-digest-mismatch', 'manifest-projection-mismatch'].includes(reason),
    );
  if (manifestInvalid) {
    return {
      presence: 'present-invalid',
      certifies: false,
      status: 'invalid',
      manifestDigest: input.manifestDigest,
      reasons: sortedReasons,
    };
  }
  return {
    presence: 'present',
    certifies: contractReceipt.certifies && sortedReasons.length === 0,
    status:
      sortedReasons.length === 0 && contractReceipt.certifies
        ? 'valid'
        : contractReceipt.status === 'invalid'
          ? 'invalid'
          : 'unproven',
    manifestDigest: input.manifestDigest,
    reasons: sortedReasons,
  };
}

export function validateReleaseConfidenceManifest(input?: unknown): ReleaseConfidenceManifestReceipt {
  try {
    return validateKnownReleaseConfidenceManifest(input);
  } catch {
    return { presence: 'present-invalid', certifies: false, status: 'invalid', reasons: ['manifest-invalid'] };
  }
}

export function serializeReleaseConfidenceManifest(manifest: ReleaseConfidenceManifest): string {
  const receipt = validateReleaseConfidenceManifest(manifest);
  if (receipt.presence !== 'present') throw new ReleaseConfidenceManifestError();
  return canonicalJson({ ...digestPayload(manifest), manifestDigest: manifest.manifestDigest });
}

export function parseReleaseConfidenceManifest(bytes: string | Uint8Array): ReleaseConfidenceManifest {
  if (typeof bytes !== 'string') {
    let byteLength: number;
    try {
      if (!types.isUint8Array(bytes) || !TYPED_ARRAY_BYTE_LENGTH) throw new ReleaseConfidenceManifestError();
      byteLength = TYPED_ARRAY_BYTE_LENGTH.call(bytes) as number;
    } catch {
      throw new ReleaseConfidenceManifestError();
    }
    if (byteLength > MAX_MANIFEST_BYTES) throw new ReleaseConfidenceManifestError();
  }
  let source: string;
  try {
    source = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseConfidenceManifestError();
  }
  if (typeof bytes === 'string' && Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ReleaseConfidenceManifestError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ReleaseConfidenceManifestError();
  }
  if (hasDuplicateJsonKeys(source)) throw new ReleaseConfidenceManifestError();
  if (validateReleaseConfidenceManifest(parsed).presence !== 'present') throw new ReleaseConfidenceManifestError();
  return parsed as ReleaseConfidenceManifest;
}
