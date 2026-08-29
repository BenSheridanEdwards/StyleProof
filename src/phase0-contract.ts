/** Phase 0 truth-contract kernel: closed types, parser, and assessment oracle. */

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { isProductStateComparabilityStatus } from './comparability-status.js';

export type Phase0Presence = 'present' | 'present-invalid' | 'absent-legacy';
export type Phase0AxisStatus = 'valid' | 'invalid' | 'unproven' | 'not-required';
export type Phase0AxisName =
  'integrity' | 'envelopes' | 'authority' | 'execution' | 'identity' | 'comparability' | 'completeness' | 'provenance';

export type Phase0Reason =
  | 'document-absent'
  | 'document-invalid'
  | 'unknown-field'
  | 'unknown-enum'
  | 'duplicate-json-key'
  | 'duplicate-id'
  | 'invalid-id'
  | 'invalid-digest'
  | 'contradiction-blocks-obligation'
  | 'connector-not-run'
  | 'connector-failed'
  | 'connector-unsupported'
  | 'connector-partial'
  | 'closure-partial'
  | 'closure-unasserted'
  | 'empty-universe-unproven'
  | 'empty-universe-conflict'
  | 'partial-enumerated'
  | 'illegal-cardinality'
  | 'dangling-endpoint'
  | 'identity-cycle'
  | 'integrity-mismatch'
  | 'legacy-unproven'
  | 'environment-unproven'
  | 'missing-required-domain'
  | 'duplicate-domain'
  | 'unmatched-source-run'
  | 'producer-mismatch'
  | 'unauthorized-mode'
  | 'scope-mismatch'
  | 'missing-join'
  | 'extra-join'
  | 'duplicate-join'
  | 'fact-count-mismatch'
  | 'comparability-mismatch';

export type Phase0AssertionMode = 'declared' | 'observed' | 'derived' | 'excluded';
export type Phase0Closure = 'enumerated' | 'partial' | 'unasserted';
export type Phase0Execution = 'complete' | 'partial' | 'failed' | 'unsupported' | 'not-run';
export type Phase0Domain =
  'capture-maps' | 'coverage-ledger' | 'determinism' | 'product-state' | 'evidence-store' | 'source-binding';
export type Phase0RelationKind = 'rename' | 'split' | 'merge' | 'supersede';
export type Phase0IdentityLayer = 'product-state' | 'source-snapshot' | 'assertion' | 'evidence';
export type Phase0Authority = 'consumer' | 'styleproof';
export type Phase0ObligationOutcome = 'satisfied' | 'blocked' | 'unproven';
export type Phase0ComparabilityReason =
  | 'explicit-state-match'
  | 'explicit-state-mismatch'
  | 'state-identity-missing'
  | 'state-identity-invalid'
  | 'missing-before'
  | 'missing-after';

export type Phase0Assertion = {
  id: string;
  mode: Phase0AssertionMode;
  subject: string;
  predicate: string;
  object: string;
  sourceDigest: string;
  inputDigest: string;
  producer: string;
  producerVersion: string;
  run: string;
  scope: string;
  validity: string;
};

export type Phase0SourceRun = {
  id: string;
  domain: Phase0Domain;
  producer: string;
  producerVersion: string;
  authority: Phase0Authority;
  sourceSha: string;
  configDigest: string;
  scope: string;
  capabilities: string[];
  execution: Phase0Execution;
  outputDigest: string;
  closure: Phase0Closure;
  factCount: number;
  emptyUniverseProof?: boolean;
  compatibilityKey: string;
};

export type Phase0Obligation = {
  id: string;
  required: boolean;
  state: string;
  surface: string;
  environment: string;
  sensor: string;
  sourceSnapshot: string;
  physicalCaptureKey: string;
  outcome: Phase0ObligationOutcome;
};

export type Phase0Relation = {
  kind: Phase0RelationKind;
  from: string[];
  to: string[];
};

export type Phase0ProductStateIdentity = {
  id: string;
  layer: 'product-state';
  revision: string;
};
export type Phase0SourceSnapshotIdentity = {
  id: string;
  layer: 'source-snapshot';
  sourceSha: string;
};
export type Phase0AssertionIdentity = {
  id: string;
  layer: 'assertion';
  assertionId: string;
};
export type Phase0EvidenceIdentity = {
  id: string;
  layer: 'evidence';
  evidenceDigest: string;
};
export type Phase0Identity =
  Phase0ProductStateIdentity | Phase0SourceSnapshotIdentity | Phase0AssertionIdentity | Phase0EvidenceIdentity;

export type Phase0Comparability = {
  surface: string;
  status: 'comparable' | 'incomparable' | 'unproven' | 'not-required';
  required: boolean;
  reason: Phase0ComparabilityReason;
};

export type Phase0IntegrityJoin = {
  obligationId: string;
  sourceSha: string;
  manifestDigest: string;
  compatibilityKey: string;
  producer: string;
  run: string;
  physicalCaptureKey: string;
  semanticStateId: string;
  environmentDigest: string;
  sensorContract: string;
  evidenceDigest: string;
  artifactDigests: string[];
};

export type Phase0ContractDocument = {
  version: '0.1';
  documentId: string;
  assertions?: Phase0Assertion[];
  sourceRuns?: Phase0SourceRun[];
  obligations?: Phase0Obligation[];
  relations?: Phase0Relation[];
  identities?: Phase0Identity[];
  comparability?: Phase0Comparability[];
  integrity?: Phase0IntegrityJoin[];
};

export type Phase0CertificationReceipt = {
  certifies: boolean;
  presence: Phase0Presence;
  status: Phase0AxisStatus;
  axes: Record<Phase0AxisName, Phase0AxisStatus>;
  reasons: Phase0Reason[];
  counts: {
    assertions: number;
    contradictions: number;
    sourceRuns: number;
    obligations: number;
    blockedObligations: number;
    relations: number;
  };
};

export class Phase0ContractError extends Error {
  constructor() {
    super('styleproof: phase 0 contract bytes are unreadable');
    this.name = 'Phase0ContractError';
  }
}

const AXES: Phase0AxisName[] = [
  'integrity',
  'envelopes',
  'authority',
  'execution',
  'identity',
  'comparability',
  'completeness',
  'provenance',
];

export const PHASE0_REQUIRED_DOMAINS: readonly Phase0Domain[] = [
  'capture-maps',
  'coverage-ledger',
  'determinism',
  'product-state',
  'evidence-store',
  'source-binding',
];

const PRODUCT_STATE_MODES = new Set<Phase0AssertionMode>(['declared', 'excluded']);
const EVIDENCE_MODES = new Set<Phase0AssertionMode>(['observed', 'derived']);
const AUTHORITIES = new Set<Phase0Authority>(['consumer', 'styleproof']);

export const PHASE0_AUTHORITY_MATRIX: Readonly<Record<Phase0Domain, readonly Phase0AssertionMode[]>> = {
  'product-state': ['declared', 'excluded'],
  'capture-maps': ['observed', 'derived'],
  'coverage-ledger': ['observed', 'derived'],
  determinism: ['observed', 'derived'],
  'evidence-store': ['observed', 'derived'],
  'source-binding': ['observed', 'derived'],
};

const DOCUMENT_FIELDS = new Set([
  'version',
  'documentId',
  'assertions',
  'sourceRuns',
  'obligations',
  'relations',
  'comparability',
  'identities',
  'integrity',
]);
const ASSERTION_FIELDS = new Set([
  'id',
  'mode',
  'subject',
  'predicate',
  'object',
  'sourceDigest',
  'inputDigest',
  'producer',
  'producerVersion',
  'run',
  'scope',
  'validity',
]);
const SOURCE_RUN_FIELDS = new Set([
  'id',
  'domain',
  'producer',
  'producerVersion',
  'authority',
  'sourceSha',
  'configDigest',
  'scope',
  'capabilities',
  'execution',
  'outputDigest',
  'closure',
  'factCount',
  'emptyUniverseProof',
  'compatibilityKey',
]);
const OBLIGATION_FIELDS = new Set([
  'id',
  'required',
  'state',
  'surface',
  'environment',
  'sensor',
  'sourceSnapshot',
  'physicalCaptureKey',
  'outcome',
]);
const RELATION_FIELDS = new Set(['kind', 'from', 'to']);
const IDENTITY_FIELDS_BY_LAYER: Record<Phase0IdentityLayer, Set<string>> = {
  'product-state': new Set(['id', 'layer', 'revision']),
  'source-snapshot': new Set(['id', 'layer', 'sourceSha']),
  assertion: new Set(['id', 'layer', 'assertionId']),
  evidence: new Set(['id', 'layer', 'evidenceDigest']),
};
const COMPARABILITY_FIELDS = new Set(['surface', 'status', 'required', 'reason']);
const INTEGRITY_FIELDS = new Set([
  'obligationId',
  'sourceSha',
  'manifestDigest',
  'compatibilityKey',
  'producer',
  'run',
  'physicalCaptureKey',
  'semanticStateId',
  'environmentDigest',
  'sensorContract',
  'evidenceDigest',
  'artifactDigests',
]);

const ASSERTION_MODES = new Set<Phase0AssertionMode>(['declared', 'observed', 'derived', 'excluded']);
const CLOSURES = new Set<Phase0Closure>(['enumerated', 'partial', 'unasserted']);
const EXECUTIONS = new Set<Phase0Execution>(['complete', 'partial', 'failed', 'unsupported', 'not-run']);
const DOMAINS = new Set<Phase0Domain>([
  'capture-maps',
  'coverage-ledger',
  'determinism',
  'product-state',
  'evidence-store',
  'source-binding',
]);
const RELATION_KINDS = new Set<Phase0RelationKind>(['rename', 'split', 'merge', 'supersede']);
const IDENTITY_LAYERS = new Set<Phase0IdentityLayer>(['product-state', 'source-snapshot', 'assertion', 'evidence']);
const OBLIGATION_OUTCOMES = new Set<Phase0ObligationOutcome>(['satisfied', 'blocked', 'unproven']);
const COMPARABILITY_REASONS = new Set<Phase0ComparabilityReason>([
  'explicit-state-match',
  'explicit-state-mismatch',
  'state-identity-missing',
  'state-identity-invalid',
  'missing-before',
  'missing-after',
]);
const COMPARABILITY_LATTICE = new Set([
  'comparable|true|explicit-state-match',
  'incomparable|true|explicit-state-mismatch',
  'unproven|true|state-identity-missing',
  'unproven|true|state-identity-invalid',
  'unproven|false|state-identity-missing',
  'not-required|false|missing-before',
  'not-required|false|missing-after',
]);

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const COMPAT = /^[0-9a-f]{16}$/;
const MAX_ARRAY = 10_000;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const EMPTY_COUNTS = {
  assertions: 0,
  contradictions: 0,
  sourceRuns: 0,
  obligations: 0,
  blockedObligations: 0,
  relations: 0,
};

type Draft = { reasons: Set<Phase0Reason> };

function axesWith(status: Phase0AxisStatus): Record<Phase0AxisName, Phase0AxisStatus> {
  return Object.fromEntries(AXES.map((axis) => [axis, status])) as Record<Phase0AxisName, Phase0AxisStatus>;
}

function add(draft: Draft, reason: Phase0Reason): void {
  draft.reasons.add(reason);
}

function sortedReasons(reasons: Iterable<Phase0Reason>): Phase0Reason[] {
  return [...new Set(reasons)].sort();
}

function receipt(input: {
  certifies: boolean;
  presence: Phase0Presence;
  status: Phase0AxisStatus;
  axes: Record<Phase0AxisName, Phase0AxisStatus>;
  reasons: Phase0Reason[];
  counts?: Phase0CertificationReceipt['counts'];
}): Phase0CertificationReceipt {
  return {
    certifies: input.certifies,
    presence: input.presence,
    status: input.status,
    axes: input.axes,
    reasons: sortedReasons(input.reasons),
    counts: input.counts ?? EMPTY_COUNTS,
  };
}

function absentReceipt(): Phase0CertificationReceipt {
  return receipt({
    certifies: false,
    presence: 'absent-legacy',
    status: 'unproven',
    axes: axesWith('unproven'),
    reasons: ['document-absent'],
  });
}

function invalidReceipt(reasons: Phase0Reason[]): Phase0CertificationReceipt {
  return receipt({
    certifies: false,
    presence: 'present-invalid',
    status: 'invalid',
    axes: { ...axesWith('unproven'), integrity: 'invalid' },
    reasons,
  });
}

function ownStringKeys(value: object): string[] | null {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    return keys as string[];
  } catch {
    return null;
  }
}

function ownValue(value: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc)) return { ok: false };
    return { ok: true, value: desc.value };
  } catch {
    return { ok: false };
  }
}

function closedKeys(value: object, allowed: Set<string>, draft: Draft): string[] | undefined {
  const keys = ownStringKeys(value);
  if (keys === null) {
    add(draft, 'document-invalid');
    return undefined;
  }
  if (keys.some((key) => !allowed.has(key))) {
    add(draft, 'unknown-field');
    return undefined;
  }
  return keys;
}

function field(value: object, key: string, draft: Draft): unknown {
  const read = ownValue(value, key);
  if (!read.ok) {
    add(draft, 'document-invalid');
    return undefined;
  }
  return read.value;
}

function opaque(value: unknown, draft: Draft): string | undefined {
  if (typeof value !== 'string') {
    add(draft, 'document-invalid');
    return undefined;
  }
  if (!OPAQUE.test(value)) {
    add(draft, 'invalid-id');
    return undefined;
  }
  return value;
}

function digest(value: unknown, draft: Draft): string | undefined {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    add(draft, 'invalid-digest');
    return undefined;
  }
  return value;
}

function gitSha(value: unknown, draft: Draft): string | undefined {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) {
    add(draft, 'invalid-digest');
    return undefined;
  }
  return value;
}

function compatKey(value: unknown, draft: Draft): string | undefined {
  if (typeof value !== 'string' || !COMPAT.test(value)) {
    add(draft, 'invalid-digest');
    return undefined;
  }
  return value;
}

function closedEnum<T extends string>(value: unknown, allowed: Set<T>, draft: Draft): T | undefined {
  if (typeof value !== 'string') {
    add(draft, 'document-invalid');
    return undefined;
  }
  if (!allowed.has(value as T)) {
    add(draft, 'unknown-enum');
    return undefined;
  }
  return value as T;
}

function safeIsArray(value: unknown): boolean | 'hostile' {
  try {
    return Array.isArray(value);
  } catch {
    return 'hostile';
  }
}

function readOwnDescriptor(value: object, key: string): PropertyDescriptor | 'hostile' | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return 'hostile';
  }
}

function lengthFromDescriptor(desc: PropertyDescriptor | 'hostile' | undefined): number | undefined {
  if (desc === 'hostile' || !desc || !('value' in desc)) return undefined;
  const length = desc.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > MAX_ARRAY) {
    return undefined;
  }
  return length;
}

function snapshotIndex(value: object, index: number): { ok: true; value: unknown } | { ok: false } {
  const desc = readOwnDescriptor(value, String(index));
  if (desc === 'hostile' || !desc || !('value' in desc)) return { ok: false };
  return { ok: true, value: desc.value };
}

function snapshotArray(value: unknown, draft: Draft): unknown[] | undefined {
  const isArray = safeIsArray(value);
  if (isArray !== true || types.isProxy(value)) {
    add(draft, 'document-invalid');
    return undefined;
  }
  const length = lengthFromDescriptor(readOwnDescriptor(value as object, 'length'));
  if (length === undefined) {
    add(draft, 'document-invalid');
    return undefined;
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const item = snapshotIndex(value as object, index);
    if (!item.ok) {
      add(draft, 'document-invalid');
      return undefined;
    }
    out.push(item.value);
  }
  return out;
}

function asArray(value: unknown, draft: Draft): unknown[] | undefined {
  return snapshotArray(value, draft);
}

function asClosedObject(value: unknown, draft: Draft): object | undefined {
  const isArray = safeIsArray(value);
  if (isArray === 'hostile' || value === null || typeof value !== 'object' || isArray === true) {
    add(draft, 'document-invalid');
    return undefined;
  }
  return value;
}

function asBoolean(value: unknown, draft: Draft): boolean | undefined {
  if (typeof value !== 'boolean') {
    add(draft, 'document-invalid');
    return undefined;
  }
  return value;
}

function asFactCount(value: unknown, draft: Draft): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_ARRAY) {
    add(draft, 'document-invalid');
    return undefined;
  }
  return value;
}

function opaqueList(value: unknown, draft: Draft): string[] | undefined {
  const items = asArray(value, draft);
  if (!items) return undefined;
  const out: string[] = [];
  for (const item of items) {
    const id = opaque(item, draft);
    if (id === undefined) return undefined;
    out.push(id);
  }
  return out;
}

function digestList(value: unknown, draft: Draft): string[] | undefined {
  const items = asArray(value, draft);
  if (!items) return undefined;
  const out: string[] = [];
  for (const item of items) {
    const hash = digest(item, draft);
    if (hash === undefined) return undefined;
    out.push(hash);
  }
  return out;
}

function parseAssertion(value: unknown, draft: Draft): Phase0Assertion | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  if (!closedKeys(record, ASSERTION_FIELDS, draft)) return undefined;
  const parsed: Phase0Assertion = {
    id: opaque(field(record, 'id', draft), draft) as string,
    mode: closedEnum(field(record, 'mode', draft), ASSERTION_MODES, draft) as Phase0AssertionMode,
    subject: opaque(field(record, 'subject', draft), draft) as string,
    predicate: opaque(field(record, 'predicate', draft), draft) as string,
    object: opaque(field(record, 'object', draft), draft) as string,
    sourceDigest: digest(field(record, 'sourceDigest', draft), draft) as string,
    inputDigest: digest(field(record, 'inputDigest', draft), draft) as string,
    producer: opaque(field(record, 'producer', draft), draft) as string,
    producerVersion: opaque(field(record, 'producerVersion', draft), draft) as string,
    run: opaque(field(record, 'run', draft), draft) as string,
    scope: opaque(field(record, 'scope', draft), draft) as string,
    validity: opaque(field(record, 'validity', draft), draft) as string,
  };
  return draft.reasons.size === 0 ? parsed : undefined;
}

function parseSourceRun(value: unknown, draft: Draft): Phase0SourceRun | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  const keys = closedKeys(record, SOURCE_RUN_FIELDS, draft);
  if (!keys) return undefined;
  const parsed: Phase0SourceRun = {
    id: opaque(field(record, 'id', draft), draft) as string,
    domain: closedEnum(field(record, 'domain', draft), DOMAINS, draft) as Phase0Domain,
    producer: opaque(field(record, 'producer', draft), draft) as string,
    producerVersion: opaque(field(record, 'producerVersion', draft), draft) as string,
    authority: closedEnum(field(record, 'authority', draft), AUTHORITIES, draft) as Phase0Authority,
    sourceSha: gitSha(field(record, 'sourceSha', draft), draft) as string,
    configDigest: digest(field(record, 'configDigest', draft), draft) as string,
    scope: opaque(field(record, 'scope', draft), draft) as string,
    capabilities: opaqueList(field(record, 'capabilities', draft), draft) as string[],
    execution: closedEnum(field(record, 'execution', draft), EXECUTIONS, draft) as Phase0Execution,
    outputDigest: digest(field(record, 'outputDigest', draft), draft) as string,
    closure: closedEnum(field(record, 'closure', draft), CLOSURES, draft) as Phase0Closure,
    factCount: asFactCount(field(record, 'factCount', draft), draft) as number,
    compatibilityKey: compatKey(field(record, 'compatibilityKey', draft), draft) as string,
  };
  if (keys.includes('emptyUniverseProof')) {
    parsed.emptyUniverseProof = asBoolean(field(record, 'emptyUniverseProof', draft), draft);
  }
  if (Array.isArray(parsed.capabilities)) uniqueIds(parsed.capabilities, draft);
  return draft.reasons.size === 0 ? parsed : undefined;
}

function parseObligation(value: unknown, draft: Draft): Phase0Obligation | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  if (!closedKeys(record, OBLIGATION_FIELDS, draft)) return undefined;
  const parsed: Phase0Obligation = {
    id: opaque(field(record, 'id', draft), draft) as string,
    required: asBoolean(field(record, 'required', draft), draft) as boolean,
    state: opaque(field(record, 'state', draft), draft) as string,
    surface: opaque(field(record, 'surface', draft), draft) as string,
    environment: digest(field(record, 'environment', draft), draft) as string,
    sensor: opaque(field(record, 'sensor', draft), draft) as string,
    sourceSnapshot: opaque(field(record, 'sourceSnapshot', draft), draft) as string,
    physicalCaptureKey: opaque(field(record, 'physicalCaptureKey', draft), draft) as string,
    outcome: closedEnum(field(record, 'outcome', draft), OBLIGATION_OUTCOMES, draft) as Phase0ObligationOutcome,
  };
  return draft.reasons.size === 0 ? parsed : undefined;
}

function parseRelation(value: unknown, draft: Draft): Phase0Relation | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  if (!closedKeys(record, RELATION_FIELDS, draft)) return undefined;
  const parsed: Phase0Relation = {
    kind: closedEnum(field(record, 'kind', draft), RELATION_KINDS, draft) as Phase0RelationKind,
    from: opaqueList(field(record, 'from', draft), draft) as string[],
    to: opaqueList(field(record, 'to', draft), draft) as string[],
  };
  return draft.reasons.size === 0 ? parsed : undefined;
}

function parseIdentity(value: unknown, draft: Draft): Phase0Identity | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  const keys = ownStringKeys(record);
  if (keys === null) {
    add(draft, 'document-invalid');
    return undefined;
  }
  const layer = closedEnum(field(record, 'layer', draft), IDENTITY_LAYERS, draft);
  if (!layer) return undefined;
  const allowed = IDENTITY_FIELDS_BY_LAYER[layer];
  if (keys.some((key) => !allowed.has(key))) {
    add(draft, 'unknown-field');
    return undefined;
  }
  const id = opaque(field(record, 'id', draft), draft);
  if (!id) return undefined;
  return parseIdentityFields(layer, record, id, draft);
}

function parseIdentityFields(
  layer: Phase0IdentityLayer,
  value: object,
  id: string,
  draft: Draft,
): Phase0Identity | undefined {
  if (layer === 'product-state') {
    const revision = opaque(field(value, 'revision', draft), draft);
    return revision ? { id, layer, revision } : undefined;
  }
  if (layer === 'source-snapshot') {
    const sourceSha = gitSha(field(value, 'sourceSha', draft), draft);
    return sourceSha ? { id, layer, sourceSha } : undefined;
  }
  if (layer === 'assertion') {
    const assertionId = opaque(field(value, 'assertionId', draft), draft);
    return assertionId ? { id, layer, assertionId } : undefined;
  }
  const evidenceDigest = digest(field(value, 'evidenceDigest', draft), draft);
  return evidenceDigest ? { id, layer, evidenceDigest } : undefined;
}

function parseComparability(value: unknown, draft: Draft): Phase0Comparability | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  if (!closedKeys(record, COMPARABILITY_FIELDS, draft)) return undefined;
  const status = field(record, 'status', draft);
  if (!isProductStateComparabilityStatus(status)) {
    add(draft, 'unknown-enum');
    return undefined;
  }
  const parsed: Phase0Comparability = {
    surface: opaque(field(record, 'surface', draft), draft) as string,
    status,
    required: asBoolean(field(record, 'required', draft), draft) as boolean,
    reason: closedEnum(field(record, 'reason', draft), COMPARABILITY_REASONS, draft) as Phase0ComparabilityReason,
  };
  return draft.reasons.size === 0 ? parsed : undefined;
}

function parseIntegrity(value: unknown, draft: Draft): Phase0IntegrityJoin | undefined {
  const record = asClosedObject(value, draft);
  if (!record) return undefined;
  if (!closedKeys(record, INTEGRITY_FIELDS, draft)) return undefined;
  const parsed: Phase0IntegrityJoin = {
    obligationId: opaque(field(record, 'obligationId', draft), draft) as string,
    sourceSha: gitSha(field(record, 'sourceSha', draft), draft) as string,
    manifestDigest: digest(field(record, 'manifestDigest', draft), draft) as string,
    compatibilityKey: compatKey(field(record, 'compatibilityKey', draft), draft) as string,
    producer: opaque(field(record, 'producer', draft), draft) as string,
    run: opaque(field(record, 'run', draft), draft) as string,
    physicalCaptureKey: opaque(field(record, 'physicalCaptureKey', draft), draft) as string,
    semanticStateId: opaque(field(record, 'semanticStateId', draft), draft) as string,
    environmentDigest: digest(field(record, 'environmentDigest', draft), draft) as string,
    sensorContract: opaque(field(record, 'sensorContract', draft), draft) as string,
    evidenceDigest: digest(field(record, 'evidenceDigest', draft), draft) as string,
    artifactDigests: digestList(field(record, 'artifactDigests', draft), draft) as string[],
  };
  return draft.reasons.size === 0 ? parsed : undefined;
}

function mapArray<T>(
  value: unknown,
  draft: Draft,
  parseOne: (entry: unknown, draft: Draft) => T | undefined,
): T[] | undefined {
  const items = asArray(value, draft);
  if (!items) return undefined;
  const out: T[] = [];
  let failed = false;
  for (const item of items) {
    const local: Draft = { reasons: new Set() };
    const parsed = parseOne(item, local);
    for (const reason of local.reasons) add(draft, reason);
    if (parsed === undefined) failed = true;
    else out.push(parsed);
  }
  return failed ? undefined : out;
}

function uniqueIds(ids: string[], draft: Draft): void {
  if (new Set(ids).size !== ids.length) add(draft, 'duplicate-id');
}

type ParsedDocument = {
  document: Phase0ContractDocument;
  reasons: Phase0Reason[];
};

function parseObject(input: object): ParsedDocument {
  const draft: Draft = { reasons: new Set() };
  const keys = closedKeys(input, DOCUMENT_FIELDS, draft);
  if (!keys) return { document: { version: '0.1', documentId: 'invalid' }, reasons: [...draft.reasons] };
  const version = field(input, 'version', draft);
  if (version !== '0.1') add(draft, version === undefined ? 'document-invalid' : 'unknown-enum');
  const documentId = opaque(field(input, 'documentId', draft), draft);
  const document: Phase0ContractDocument = { version: '0.1', documentId: documentId ?? 'invalid' };
  parseDocumentCollections(input, keys, document, draft);
  uniqueDocumentIds(document, draft);
  return { document, reasons: [...draft.reasons] };
}

function parseDocumentCollections(input: object, keys: string[], document: Phase0ContractDocument, draft: Draft): void {
  if (keys.includes('assertions'))
    document.assertions = mapArray(field(input, 'assertions', draft), draft, parseAssertion);
  if (keys.includes('sourceRuns'))
    document.sourceRuns = mapArray(field(input, 'sourceRuns', draft), draft, parseSourceRun);
  if (keys.includes('obligations'))
    document.obligations = mapArray(field(input, 'obligations', draft), draft, parseObligation);
  if (keys.includes('relations')) document.relations = mapArray(field(input, 'relations', draft), draft, parseRelation);
  if (keys.includes('identities'))
    document.identities = mapArray(field(input, 'identities', draft), draft, parseIdentity);
  if (keys.includes('comparability')) {
    document.comparability = mapArray(field(input, 'comparability', draft), draft, parseComparability);
  }
  if (keys.includes('integrity'))
    document.integrity = mapArray(field(input, 'integrity', draft), draft, parseIntegrity);
}

function uniqueDocumentIds(document: Phase0ContractDocument, draft: Draft): void {
  uniqueIds(
    (document.assertions ?? []).map((entry) => entry.id),
    draft,
  );
  uniqueIds(
    (document.identities ?? []).map((entry) => entry.id),
    draft,
  );
  uniqueIds(
    (document.obligations ?? []).map((entry) => entry.id),
    draft,
  );
  uniqueIds(
    (document.sourceRuns ?? []).map((entry) => entry.id),
    draft,
  );
}

type Cursor = { source: string; offset: number; duplicate: boolean };

function skipSpace(cursor: Cursor): void {
  while (/\s/.test(cursor.source[cursor.offset] ?? '')) cursor.offset++;
}

function readJsonString(cursor: Cursor): string {
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

function skipJsonArray(cursor: Cursor, depth: number): void {
  cursor.offset++;
  skipSpace(cursor);
  while (cursor.source[cursor.offset] !== ']') {
    skipJsonValue(cursor, depth + 1);
    skipSpace(cursor);
    if (cursor.source[cursor.offset] !== ',') break;
    cursor.offset++;
    skipSpace(cursor);
  }
  cursor.offset++;
}

function skipJsonObject(cursor: Cursor, depth: number): void {
  cursor.offset++;
  const keys = new Set<string>();
  skipSpace(cursor);
  while (cursor.source[cursor.offset] !== '}') {
    const key = readJsonString(cursor);
    if (keys.has(key)) cursor.duplicate = true;
    keys.add(key);
    skipSpace(cursor);
    cursor.offset++;
    skipJsonValue(cursor, depth + 1);
    skipSpace(cursor);
    if (cursor.source[cursor.offset] !== ',') break;
    cursor.offset++;
    skipSpace(cursor);
  }
  cursor.offset++;
}

function skipJsonValue(cursor: Cursor, depth: number): void {
  skipSpace(cursor);
  const ch = cursor.source[cursor.offset];
  if (ch === '{') {
    if (depth > MAX_JSON_DEPTH) throw new Phase0ContractError();
    skipJsonObject(cursor, depth);
    return;
  }
  if (ch === '[') {
    if (depth > MAX_JSON_DEPTH) throw new Phase0ContractError();
    skipJsonArray(cursor, depth);
    return;
  }
  if (ch === '"') {
    readJsonString(cursor);
    return;
  }
  while (cursor.offset < cursor.source.length && !/[\s,\]}]/.test(cursor.source[cursor.offset] ?? '')) {
    cursor.offset++;
  }
}

function hasDuplicateJsonKeys(source: string): boolean {
  const cursor: Cursor = { source, offset: 0, duplicate: false };
  skipJsonValue(cursor, 1);
  return cursor.duplicate;
}

function toUtf8(bytes: string | Uint8Array): string {
  if (typeof bytes === 'string') return bytes;
  return new TextDecoder('utf8', { fatal: true }).decode(bytes);
}

function worstStatus(statuses: Phase0AxisStatus[]): Phase0AxisStatus {
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('unproven')) return 'unproven';
  if (statuses.every((status) => status === 'not-required')) return 'not-required';
  return 'valid';
}

function contradictionTupleKey(assertion: {
  subject: string;
  predicate: string;
  scope: string;
  validity: string;
}): string {
  return `${assertion.subject}\0${assertion.predicate}\0${assertion.scope}\0${assertion.validity}`;
}

function contradictionKeys(assertions: Phase0Assertion[]): Set<string> {
  const byTuple = new Map<string, Set<string>>();
  for (const assertion of assertions) {
    const key = contradictionTupleKey(assertion);
    const objects = byTuple.get(key) ?? new Set<string>();
    objects.add(assertion.object);
    byTuple.set(key, objects);
  }
  const contradicted = new Set<string>();
  for (const [key, objects] of byTuple) {
    if (objects.size > 1) contradicted.add(key);
  }
  return contradicted;
}

function identitiesOfLayer<T extends Phase0Identity['layer']>(
  document: Phase0ContractDocument,
  layer: T,
): Extract<Phase0Identity, { layer: T }>[] {
  return (document.identities ?? []).filter(
    (entry): entry is Extract<Phase0Identity, { layer: T }> => entry.layer === layer,
  );
}

function snapshotById(document: Phase0ContractDocument): Map<string, Phase0SourceSnapshotIdentity> {
  return new Map(identitiesOfLayer(document, 'source-snapshot').map((entry) => [entry.id, entry]));
}

function productStateById(document: Phase0ContractDocument): Map<string, Phase0ProductStateIdentity> {
  return new Map(identitiesOfLayer(document, 'product-state').map((entry) => [entry.id, entry]));
}

function uniqueOpaque(ids: string[]): string[] {
  return [...new Set(ids)];
}

function relationCardinalityOk(relation: Phase0Relation): boolean {
  const from = uniqueOpaque(relation.from);
  const to = uniqueOpaque(relation.to);
  if (from.length === 0 || to.length === 0) return false;
  if (from.length !== relation.from.length || to.length !== relation.to.length) return false;
  if (relation.kind === 'rename' || relation.kind === 'supersede') {
    return from.length === 1 && to.length === 1;
  }
  if (relation.kind === 'split') return from.length === 1 && to.length >= 2;
  return from.length >= 2 && to.length === 1;
}

function relationKey(relation: Phase0Relation): string {
  return `${relation.kind}:${sortTexts(relation.from).join(',')}:${sortTexts(relation.to).join(',')}`;
}

function hasDuplicateRelations(relations: Phase0Relation[]): boolean {
  const keys = relations.map(relationKey);
  return new Set(keys).size !== keys.length;
}

function relationHasCycle(relations: Phase0Relation[]): boolean {
  const edges = new Map<string, string[]>();
  for (const relation of relations) {
    for (const from of relation.from) {
      const next = edges.get(from) ?? [];
      next.push(...relation.to);
      edges.set(from, next);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...edges.keys()].some((node) => visit(node));
}

function assertionBijectionOk(document: Phase0ContractDocument): boolean {
  const assertionIds = (document.assertions ?? []).map((entry) => entry.id);
  const boundIds = identitiesOfLayer(document, 'assertion').map((entry) => entry.assertionId);
  if (new Set(assertionIds).size !== assertionIds.length) return false;
  if (new Set(boundIds).size !== boundIds.length) return false;
  if (assertionIds.length !== boundIds.length) return false;
  const wanted = new Set(assertionIds);
  return boundIds.every((id) => wanted.has(id));
}

function identityBindingReasons(document: Phase0ContractDocument): Phase0Reason[] {
  return [
    ...assertionIdentityReasons(document),
    ...obligationIdentityReasons(document),
    ...uniqueSnapshotShaReasons(document),
  ];
}

function assertionIdentityReasons(document: Phase0ContractDocument): Phase0Reason[] {
  const reasons: Phase0Reason[] = [];
  if (!assertionBijectionOk(document)) reasons.push('invalid-id');
  const snapshots = snapshotById(document);
  const runById = new Map((document.sourceRuns ?? []).map((run) => [run.id, run]));
  for (const assertion of document.assertions ?? []) {
    const snap = snapshots.get(assertion.validity);
    if (!snap) {
      reasons.push('invalid-id');
      continue;
    }
    const run = runById.get(assertion.run);
    if (run && snap.sourceSha !== run.sourceSha) reasons.push('integrity-mismatch');
  }
  return reasons;
}

function obligationIdentityReasons(document: Phase0ContractDocument): Phase0Reason[] {
  const reasons: Phase0Reason[] = [];
  const snapshots = snapshotById(document);
  const products = productStateById(document);
  for (const obligation of document.obligations ?? []) {
    if (!products.has(obligation.state)) reasons.push('invalid-id');
    if (!snapshots.has(obligation.sourceSnapshot)) reasons.push('invalid-id');
  }
  return reasons;
}

function uniqueSnapshotShaReasons(document: Phase0ContractDocument): Phase0Reason[] {
  const snapshotShas = identitiesOfLayer(document, 'source-snapshot').map((entry) => entry.sourceSha);
  if (new Set(snapshotShas).size === snapshotShas.length) return [];
  return ['duplicate-id', 'integrity-mismatch'];
}

function assessIdentity(document: Phase0ContractDocument): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const reasons: Phase0Reason[] = identityBindingReasons(document);
  const relations = document.relations ?? [];
  if (hasDuplicateRelations(relations)) reasons.push('duplicate-id');
  const knownProductStates = productStateIds(document);
  for (const relation of relations) {
    if (!relationCardinalityOk(relation)) reasons.push('illegal-cardinality');
    const endpoints = [...relation.from, ...relation.to];
    if (endpoints.some((id) => !knownProductStates.has(id))) reasons.push('dangling-endpoint');
  }
  if (relationHasCycle(relations)) reasons.push('identity-cycle');
  return { status: reasons.length > 0 ? 'invalid' : 'valid', reasons };
}

function allowedModes(domain: Phase0Domain): Set<Phase0AssertionMode> {
  return domain === 'product-state' ? PRODUCT_STATE_MODES : EVIDENCE_MODES;
}

function domainAuthority(domain: Phase0Domain): Phase0Authority {
  return domain === 'product-state' ? 'consumer' : 'styleproof';
}

function assessAuthority(document: Phase0ContractDocument): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const runs = document.sourceRuns ?? [];
  const runById = new Map(runs.map((run) => [run.id, run]));
  const reasons: Phase0Reason[] = [];
  const statuses: Phase0AxisStatus[] = [];
  for (const run of runs) {
    const note = assessRunAuthority(run);
    if (note) {
      reasons.push(note.reason);
      statuses.push(note.status);
    }
  }
  const assertions = document.assertions ?? [];
  if (assertions.length === 0) {
    return { status: worstStatus(statuses.length > 0 ? statuses : ['valid']), reasons };
  }
  for (const assertion of assertions) {
    const note = assessAssertionAuthority(assertion, runById);
    if (note.reason) reasons.push(note.reason);
    statuses.push(note.status);
  }
  return { status: worstStatus(statuses), reasons };
}

function assessRunAuthority(run: Phase0SourceRun): { status: Phase0AxisStatus; reason: Phase0Reason } | undefined {
  if (run.authority !== domainAuthority(run.domain)) {
    return { status: 'invalid', reason: 'unauthorized-mode' };
  }
  return undefined;
}

function assessAssertionAuthority(
  assertion: Phase0Assertion,
  runById: Map<string, Phase0SourceRun>,
): { status: Phase0AxisStatus; reason?: Phase0Reason } {
  const run = runById.get(assertion.run);
  if (!run) return { status: 'unproven', reason: 'unmatched-source-run' };
  if (run.producer !== assertion.producer || run.producerVersion !== assertion.producerVersion) {
    return { status: 'invalid', reason: 'producer-mismatch' };
  }
  if (assertion.scope !== run.scope) return { status: 'invalid', reason: 'scope-mismatch' };
  if (!allowedModes(run.domain).has(assertion.mode) || run.authority !== domainAuthority(run.domain)) {
    return { status: 'invalid', reason: 'unauthorized-mode' };
  }
  return { status: 'valid' };
}

function assessEnvelopes(runs: Phase0SourceRun[]): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const counts = new Map<Phase0Domain, number>();
  for (const run of runs) counts.set(run.domain, (counts.get(run.domain) ?? 0) + 1);
  const reasons: Phase0Reason[] = [];
  for (const domain of PHASE0_REQUIRED_DOMAINS) {
    const count = counts.get(domain) ?? 0;
    if (count === 0) reasons.push('missing-required-domain');
    if (count > 1) reasons.push('duplicate-domain');
  }
  if (reasons.length > 0) return { status: 'invalid', reasons: [...new Set(reasons)] };
  return { status: 'valid', reasons: [] };
}

function assessRunState(run: Phase0SourceRun): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  if (run.execution === 'complete' && run.closure === 'enumerated') return { status: 'valid', reasons: [] };
  if (run.closure === 'enumerated') return enumeratedClaimState(run.execution);
  if (run.execution === 'failed') return { status: 'invalid', reasons: ['connector-failed'] };
  if (run.execution === 'unsupported') return { status: 'unproven', reasons: ['connector-unsupported'] };
  if (run.execution === 'not-run') return { status: 'unproven', reasons: ['connector-not-run'] };
  if (run.execution === 'partial') return { status: 'unproven', reasons: ['connector-partial'] };
  if (run.closure === 'partial') return { status: 'unproven', reasons: ['closure-partial'] };
  return { status: 'unproven', reasons: ['closure-unasserted'] };
}

function enumeratedClaimState(execution: Phase0Execution): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const reasons: Phase0Reason[] = ['partial-enumerated'];
  if (execution === 'failed') reasons.push('connector-failed');
  return { status: 'invalid', reasons };
}

function assessExecution(runs: Phase0SourceRun[]): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  if (runs.length === 0) return { status: 'unproven', reasons: ['connector-not-run'] };
  const reasons: Phase0Reason[] = [];
  const statuses: Phase0AxisStatus[] = [];
  for (const run of runs) {
    const result = assessRunState(run);
    reasons.push(...result.reasons);
    statuses.push(result.status);
  }
  return { status: worstStatus(statuses), reasons };
}

function assessCompleteness(document: Phase0ContractDocument): {
  status: Phase0AxisStatus;
  reasons: Phase0Reason[];
  contradictions: number;
  blocked: number;
} {
  const reasons: Phase0Reason[] = [];
  const statuses: Phase0AxisStatus[] = [];
  const runs = document.sourceRuns ?? [];
  for (const run of runs) {
    const result = assessRunCompleteness(document, run);
    reasons.push(...result.reasons);
    statuses.push(result.status);
  }
  if (runs.length === 0) {
    reasons.push('empty-universe-unproven');
    statuses.push('unproven');
  }
  const contradicted = contradictionKeys(document.assertions ?? []);
  const obligations = document.obligations ?? [];
  let blocked = 0;
  const byState = groupObligationsByState(obligations);
  for (const obligation of obligations) {
    blocked += recordObligationCompleteness(obligation, contradicted, reasons, statuses);
  }
  for (const group of byState.values()) {
    if (mixedEnvironmentUnproven(group)) {
      reasons.push('environment-unproven');
      statuses.push('invalid');
    }
  }
  return {
    status: worstStatus(statuses.length > 0 ? statuses : ['unproven']),
    reasons,
    contradictions: contradicted.size,
    blocked,
  };
}

function runFactCount(document: Phase0ContractDocument, runId: string): number {
  return (document.assertions ?? []).filter((assertion) => assertion.run === runId).length;
}

function enumeratedRunAssessment(
  run: Phase0SourceRun,
  facts: number,
): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  if (run.factCount > 0 && run.emptyUniverseProof === true) {
    return { status: 'invalid', reasons: ['empty-universe-conflict'] };
  }
  if (run.factCount !== facts) {
    return { status: 'invalid', reasons: [facts === 0 ? 'empty-universe-unproven' : 'fact-count-mismatch'] };
  }
  if (run.factCount === 0 && run.emptyUniverseProof !== true) {
    return { status: 'invalid', reasons: ['empty-universe-unproven'] };
  }
  return { status: 'valid', reasons: [] };
}

function assessRunCompleteness(
  document: Phase0ContractDocument,
  run: Phase0SourceRun,
): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const state = assessRunState(run);
  if (state.status !== 'valid') return state;
  return enumeratedRunAssessment(run, runFactCount(document, run.id));
}

function groupObligationsByState(obligations: Phase0Obligation[]): Map<string, Phase0Obligation[]> {
  const byState = new Map<string, Phase0Obligation[]>();
  for (const obligation of obligations) {
    const group = byState.get(obligation.state) ?? [];
    group.push(obligation);
    byState.set(obligation.state, group);
  }
  return byState;
}

function contradictionBlocksObligation(obligation: Phase0Obligation, contradicted: Set<string>): boolean {
  for (const key of contradicted) {
    const [subject, , scope, validity] = key.split('\0');
    if (subject === obligation.state && scope === obligation.surface && validity === obligation.sourceSnapshot) {
      return true;
    }
  }
  return false;
}

function recordObligationCompleteness(
  obligation: Phase0Obligation,
  contradicted: Set<string>,
  reasons: Phase0Reason[],
  statuses: Phase0AxisStatus[],
): number {
  if (contradictionBlocksObligation(obligation, contradicted) && obligation.required) {
    reasons.push('contradiction-blocks-obligation');
    statuses.push('invalid');
    return 1;
  }
  if (obligation.required && obligation.outcome !== 'satisfied') {
    statuses.push('invalid');
    if (obligation.outcome === 'unproven') reasons.push('environment-unproven');
    return 1;
  }
  return 0;
}

function mixedEnvironmentUnproven(group: Phase0Obligation[]): boolean {
  const environments = new Set(group.map((entry) => entry.environment));
  const outcomes = new Set(group.map((entry) => entry.outcome));
  return (
    environments.size > 1 && outcomes.size > 1 && group.some((entry) => entry.required && entry.outcome !== 'satisfied')
  );
}

function assessComparability(document: Phase0ContractDocument): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const entries = document.comparability ?? [];
  const surfaces = entries.map((entry) => entry.surface);
  if (new Set(surfaces).size !== surfaces.length) {
    return { status: 'invalid', reasons: ['duplicate-id'] };
  }
  const reasons: Phase0Reason[] = [];
  const statuses: Phase0AxisStatus[] = [];
  if (!comparabilityCoversRequired(document, entries)) {
    reasons.push('comparability-mismatch');
    statuses.push('invalid');
  }
  for (const entry of entries) {
    const note = comparabilityEntryNote(entry);
    if (note.reason) reasons.push(note.reason);
    statuses.push(note.status);
  }
  if (statuses.length === 0) return { status: 'not-required', reasons: [] };
  return { status: worstStatus(statuses), reasons: [...new Set(reasons)] };
}

function comparabilityCoversRequired(document: Phase0ContractDocument, entries: Phase0Comparability[]): boolean {
  const required = uniqueSorted(
    (document.obligations ?? []).filter((entry) => entry.required).map((entry) => entry.surface),
  );
  const receipts = uniqueSorted(entries.map((entry) => entry.surface));
  if (!sameTexts(required, receipts)) return false;
  const requiredSet = new Set(required);
  return entries.every(
    (entry) => !requiredSet.has(entry.surface) || (entry.required && entry.status !== 'not-required'),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameTexts(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function comparabilityEntryNote(entry: Phase0Comparability): { status: Phase0AxisStatus; reason?: Phase0Reason } {
  const latticeKey = `${entry.status}|${String(entry.required)}|${entry.reason}`;
  if (!COMPARABILITY_LATTICE.has(latticeKey)) {
    return { status: 'invalid', reason: 'comparability-mismatch' };
  }
  if (entry.status === 'comparable') return { status: 'valid' };
  if (entry.status === 'not-required') return { status: 'not-required' };
  if (entry.status === 'incomparable') return { status: 'invalid', reason: 'comparability-mismatch' };
  return { status: 'unproven', reason: 'legacy-unproven' };
}

function productStateIds(document: Phase0ContractDocument): Set<string> {
  return new Set(identitiesOfLayer(document, 'product-state').map((entry) => entry.id));
}

function creditedDigests(document: Phase0ContractDocument, join: Phase0IntegrityJoin): Set<string> {
  const needed = new Set<string>([join.manifestDigest]);
  for (const run of document.sourceRuns ?? []) {
    needed.add(run.outputDigest);
    needed.add(run.configDigest);
  }
  for (const assertion of document.assertions ?? []) {
    needed.add(assertion.sourceDigest);
    needed.add(assertion.inputDigest);
  }
  for (const identity of identitiesOfLayer(document, 'evidence')) needed.add(identity.evidenceDigest);
  return needed;
}

function artifactsCover(join: Phase0IntegrityJoin, needed: Set<string>): boolean {
  if (join.artifactDigests.length === 0) return false;
  if (new Set(join.artifactDigests).size !== join.artifactDigests.length) return false;
  const have = new Set(join.artifactDigests);
  if (have.size !== needed.size) return false;
  for (const digest of needed) {
    if (!have.has(digest)) return false;
  }
  return true;
}

function joinMatchesObligation(
  document: Phase0ContractDocument,
  join: Phase0IntegrityJoin,
  obligation: Phase0Obligation,
): boolean {
  const snap = snapshotById(document).get(obligation.sourceSnapshot);
  if (!snap) return false;
  return (
    join.semanticStateId === obligation.state &&
    join.environmentDigest === obligation.environment &&
    join.sensorContract === obligation.sensor &&
    join.physicalCaptureKey === obligation.physicalCaptureKey &&
    join.sourceSha === snap.sourceSha
  );
}

function isCaptureOrEvidenceDomain(domain: Phase0Domain): boolean {
  return domain === 'capture-maps' || domain === 'evidence-store';
}

function evidenceDigestSetEqual(document: Phase0ContractDocument): boolean {
  const identityDigests = identitiesOfLayer(document, 'evidence').map((entry) => entry.evidenceDigest);
  const joinDigests = (document.integrity ?? []).map((join) => join.evidenceDigest);
  if (new Set(identityDigests).size !== identityDigests.length) return false;
  return sameTexts(uniqueSorted(identityDigests), uniqueSorted(joinDigests));
}

function assessOneJoin(document: Phase0ContractDocument, join: Phase0IntegrityJoin): boolean {
  const runs = document.sourceRuns ?? [];
  const capture = runs.find((run) => run.domain === 'capture-maps');
  if (!capture || capture.outputDigest !== join.manifestDigest) return false;
  if (runs.some((run) => run.sourceSha !== join.sourceSha || run.compatibilityKey !== join.compatibilityKey)) {
    return false;
  }
  const producerRun = runs.find((run) => run.id === join.run);
  if (!producerRun || producerRun.producer !== join.producer) return false;
  if (producerRun.authority !== 'styleproof' || !isCaptureOrEvidenceDomain(producerRun.domain)) return false;
  if (!productStateIds(document).has(join.semanticStateId)) return false;
  const obligation = (document.obligations ?? []).find((entry) => entry.id === join.obligationId);
  if (!obligation || !joinMatchesObligation(document, join, obligation)) return false;
  if (producerRun.scope !== obligation.surface || capture.scope !== obligation.surface) return false;
  return artifactsCover(join, creditedDigests(document, join));
}

function assessProvenance(document: Phase0ContractDocument): { status: Phase0AxisStatus; reasons: Phase0Reason[] } {
  const joins = document.integrity ?? [];
  const obligations = document.obligations ?? [];
  const requiredSatisfied = obligations.filter((entry) => entry.required && entry.outcome === 'satisfied');
  if (joins.length === 0) return { status: 'unproven', reasons: ['integrity-mismatch'] };
  const reasons: Phase0Reason[] = [];
  const counts = new Map<string, number>();
  for (const join of joins) counts.set(join.obligationId, (counts.get(join.obligationId) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > 1)) reasons.push('duplicate-join');
  const satisfiedIds = new Set(requiredSatisfied.map((entry) => entry.id));
  if (joins.some((join) => !satisfiedIds.has(join.obligationId))) reasons.push('extra-join');
  if (requiredSatisfied.some((entry) => (counts.get(entry.id) ?? 0) === 0)) reasons.push('missing-join');
  if (joins.some((join) => !assessOneJoin(document, join))) reasons.push('integrity-mismatch');
  if (!evidenceDigestSetEqual(document)) reasons.push('integrity-mismatch');
  if (reasons.length > 0) return { status: 'invalid', reasons };
  return { status: 'valid', reasons: [] };
}

function assessParsed(document: Phase0ContractDocument): Phase0CertificationReceipt {
  const identity = assessIdentity(document);
  const envelopes = assessEnvelopes(document.sourceRuns ?? []);
  const authority = assessAuthority(document);
  const execution = assessExecution(document.sourceRuns ?? []);
  const completeness = assessCompleteness(document);
  const comparability = assessComparability(document);
  const provenance = assessProvenance(document);
  const axes: Record<Phase0AxisName, Phase0AxisStatus> = {
    integrity: 'valid',
    envelopes: envelopes.status,
    authority: authority.status,
    execution: execution.status,
    identity: identity.status,
    comparability: comparability.status,
    completeness: completeness.status,
    provenance: provenance.status,
  };
  const reasons = sortedReasons([
    ...envelopes.reasons,
    ...authority.reasons,
    ...execution.reasons,
    ...identity.reasons,
    ...completeness.reasons,
    ...comparability.reasons,
    ...provenance.reasons,
  ]);
  const required = AXES.filter((axis) => axes[axis] !== 'not-required');
  const certifies = required.every((axis) => axes[axis] === 'valid');
  const status = certifies ? 'valid' : worstStatus(required.map((axis) => axes[axis]));
  return receipt({
    certifies,
    presence: 'present',
    status,
    axes,
    reasons,
    counts: {
      assertions: document.assertions?.length ?? 0,
      contradictions: completeness.contradictions,
      sourceRuns: document.sourceRuns?.length ?? 0,
      obligations: document.obligations?.length ?? 0,
      blockedObligations: completeness.blocked,
      relations: document.relations?.length ?? 0,
    },
  });
}

function assessObject(input: unknown): Phase0CertificationReceipt {
  const isArray = safeIsArray(input);
  if (isArray === 'hostile' || input === null || typeof input !== 'object' || isArray === true) {
    return invalidReceipt(['document-invalid']);
  }
  const parsed = parseObject(input);
  if (parsed.reasons.length > 0) return invalidReceipt(parsed.reasons);
  return assessParsed(parsed.document);
}

export function assessPhase0Contract(input?: unknown, bytes?: string | Uint8Array): Phase0CertificationReceipt {
  if (bytes !== undefined) return parsePhase0Contract(bytes);
  if (arguments.length === 0 || input === undefined) return absentReceipt();
  return assessObject(input);
}

export function parsePhase0Contract(bytes: string | Uint8Array): Phase0CertificationReceipt {
  if (typeof bytes !== 'string') {
    let byteLength: number;
    try {
      byteLength = bytes.byteLength;
    } catch {
      throw new Phase0ContractError();
    }
    if (byteLength > MAX_DOCUMENT_BYTES) throw new Phase0ContractError();
  }
  let source: string;
  try {
    source = toUtf8(bytes);
  } catch {
    throw new Phase0ContractError();
  }
  if (typeof bytes === 'string' && Buffer.byteLength(source, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Phase0ContractError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Phase0ContractError();
  }
  if (hasDuplicateJsonKeys(source)) return invalidReceipt(['duplicate-json-key']);
  return assessObject(parsed);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => compareText(left.id, right.id));
}

function sortTexts(items: string[]): string[] {
  return [...items].sort(compareText);
}

function canonicalRelation(relation: Phase0Relation): Phase0Relation {
  return { kind: relation.kind, from: sortTexts(relation.from), to: sortTexts(relation.to) };
}

function canonicalDocument(document: Phase0ContractDocument): Phase0ContractDocument {
  return {
    version: document.version,
    documentId: document.documentId,
    assertions: sortById(document.assertions ?? []),
    sourceRuns: sortById(document.sourceRuns ?? []).map((run) => ({
      ...run,
      capabilities: sortTexts(run.capabilities),
    })),
    obligations: sortById(document.obligations ?? []),
    identities: sortById(document.identities ?? []),
    relations: [...(document.relations ?? []).map(canonicalRelation)].sort((left, right) =>
      compareText(
        `${left.kind}:${left.from.join(',')}:${left.to.join(',')}`,
        `${right.kind}:${right.from.join(',')}:${right.to.join(',')}`,
      ),
    ),
    comparability: [...(document.comparability ?? [])].sort(
      (left, right) =>
        compareText(left.surface, right.surface) ||
        compareText(left.status, right.status) ||
        compareText(String(left.required), String(right.required)) ||
        compareText(left.reason, right.reason),
    ),
    integrity: [...(document.integrity ?? [])]
      .map((join) => ({ ...join, artifactDigests: sortTexts(join.artifactDigests) }))
      .sort((left, right) => compareText(left.obligationId, right.obligationId)),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalValue(record[key]);
    return out;
  }
  return value;
}

export function serializePhase0Contract(document: Phase0ContractDocument): string {
  return JSON.stringify(canonicalValue(canonicalDocument(document)));
}

export function digestPhase0Contract(document: Phase0ContractDocument): string {
  return createHash('sha256').update(serializePhase0Contract(document)).digest('hex');
}
