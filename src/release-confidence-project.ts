import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap, validateProductStateIdentity } from './capture.js';
import {
  bundleSurfaceKeys,
  CONFIDENCE_LEDGER,
  readConfidenceLedger,
  readCoverageLedgerLenient,
  type ConfidenceLedgerFile,
} from './confidence-ledger.js';
import { auditCoverage, auditDeterminism, COVERAGE_LEDGER, type CoverageLedger } from './coverage.js';
import { diffStyleMapDirs } from './diff.js';
import { verifyEvidenceCapture, type EvidenceCaptureManifest, type EvidenceObjectRef } from './evidence-store.js';
import {
  assertCompatibleMapDirs,
  captureEvidenceBindingReceipt,
  captureKeyParts,
  isMapFile,
  readMapManifest,
  type MapManifest,
  type SourceBindingReceipt,
} from './map-store.js';
import {
  PHASE0_REQUIRED_DOMAINS,
  type Phase0Assertion,
  type Phase0Comparability,
  type Phase0ContractDocument,
  type Phase0Domain,
  type Phase0Execution,
  type Phase0Identity,
  type Phase0IntegrityJoin,
  type Phase0Obligation,
  type Phase0SourceRun,
} from './phase0-contract.js';
import { createReleaseConfidenceManifest, type ReleaseConfidenceManifest } from './release-confidence-manifest.js';

export type ReleaseConfidenceEvidenceInput = {
  storeRoot: string;
  capture: EvidenceObjectRef;
};

export type ReleaseConfidenceProjectInput = {
  beforeDir: string;
  afterDir: string;
  manifestId: string;
  producerVersion: string;
  releaseScope: string;
  expectedBeforeSha?: string;
  expectedAfterSha?: string;
  evidence?: ReleaseConfidenceEvidenceInput;
};

export type ReleaseConfidenceProjectResult = {
  contract: Phase0ContractDocument;
  manifest: ReleaseConfidenceManifest;
};

export class ReleaseConfidenceProjectError extends Error {
  constructor() {
    super('release confidence projection failed');
    this.name = 'ReleaseConfidenceProjectError';
  }
}

type CaptureRecord = {
  captureKey: string;
  physicalCaptureKey: string;
  surface: string;
  state: { id: string; revision: string } | null;
};

type SharedRun = {
  sourceSha: string;
  compatibilityKey: string;
  configDigest: string;
  producerVersion: string;
  scope: string;
};

const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
const GIT_SHA = /^[0-9a-f]{40}$/;
const COMPATIBILITY_KEY = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function strictCoverage(dir: string): CoverageLedger | null {
  const exists = fs.existsSync(path.join(dir, COVERAGE_LEDGER));
  const ledger = readCoverageLedgerLenient(dir);
  if (exists && !ledger) throw new ReleaseConfidenceProjectError();
  return ledger;
}

function strictConfidence(dir: string): ConfidenceLedgerFile | null {
  const exists = fs.existsSync(path.join(dir, CONFIDENCE_LEDGER));
  const ledger = readConfidenceLedger(dir);
  if (exists && !ledger) throw new ReleaseConfidenceProjectError();
  return ledger;
}

function mapFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(isMapFile).sort(compareText);
}

function captureKeyFromFile(file: string): string {
  return file.replace(/\.json(?:\.gz)?$/i, '');
}

function physicalCaptureKey(captureKey: string): string {
  return captureKey.replace(/[^A-Za-z0-9._-]/g, '-');
}

function captureRecords(dir: string): CaptureRecord[] {
  try {
    return mapFiles(dir).map((file) => {
      const captureKey = captureKeyFromFile(file);
      const surface = captureKeyParts(captureKey).surface;
      const state = validateProductStateIdentity(loadStyleMap(path.join(dir, file)).metadata?.productState);
      return {
        captureKey,
        physicalCaptureKey: physicalCaptureKey(captureKey),
        surface,
        state: state ? { id: state.id, revision: state.revision } : null,
      };
    });
  } catch {
    throw new ReleaseConfidenceProjectError();
  }
}

function requiredHeadManifest(dir: string): MapManifest {
  try {
    const manifest = readMapManifest(dir);
    if (
      !manifest ||
      !GIT_SHA.test(manifest.sha) ||
      !COMPATIBILITY_KEY.test(manifest.compatibilityKey) ||
      !SHA256.test(manifest.specHash)
    ) {
      throw new ReleaseConfidenceProjectError();
    }
    return manifest;
  } catch {
    throw new ReleaseConfidenceProjectError();
  }
}

function copiedComparability(beforeDir: string, afterDir: string): Phase0Comparability[] {
  try {
    return diffStyleMapDirs(beforeDir, afterDir).comparability.map((entry) => ({
      surface: captureKeyParts(entry.surface).surface,
      status: entry.status,
      required: entry.required,
      reason: entry.reason,
    }));
  } catch {
    throw new ReleaseConfidenceProjectError();
  }
}

function styleproofRun(
  shared: SharedRun,
  domain: Exclude<Phase0Domain, 'product-state'>,
  execution: Phase0Execution,
  outputDigest: string,
  capabilities: string[],
): Phase0SourceRun {
  const complete = execution === 'complete';
  return {
    id: `run-${domain}`,
    domain,
    producer: 'styleproof',
    producerVersion: shared.producerVersion,
    authority: 'styleproof',
    sourceSha: shared.sourceSha,
    configDigest: shared.configDigest,
    scope: shared.scope,
    capabilities,
    execution,
    outputDigest,
    closure: complete ? 'enumerated' : 'unasserted',
    factCount: 0,
    ...(complete ? { emptyUniverseProof: true } : {}),
    compatibilityKey: shared.compatibilityKey,
  };
}

function productStateRun(
  shared: SharedRun,
  execution: Phase0Execution,
  outputDigest: string,
  factCount: number,
): Phase0SourceRun {
  return {
    id: 'run-product-state',
    domain: 'product-state',
    producer: 'consumer',
    producerVersion: 'unasserted',
    authority: 'consumer',
    sourceSha: shared.sourceSha,
    configDigest: shared.configDigest,
    scope: shared.scope,
    capabilities: ['declared-state'],
    execution,
    outputDigest,
    closure: execution === 'complete' ? 'enumerated' : 'unasserted',
    factCount,
    compatibilityKey: shared.compatibilityKey,
  };
}

function requiredEvidence(
  input: ReleaseConfidenceEvidenceInput | undefined,
  sourceSha: string,
  compatibilityKey: string,
): { manifest: EvidenceCaptureManifest; digest: string } | null {
  if (!input) return null;
  try {
    const manifest = verifyEvidenceCapture(input.storeRoot, input.capture);
    if (manifest.source.sha !== sourceSha || manifest.source.compatibilityKey !== compatibilityKey) {
      throw new ReleaseConfidenceProjectError();
    }
    return { manifest, digest: input.capture.digest };
  } catch {
    throw new ReleaseConfidenceProjectError();
  }
}

function exactState(records: CaptureRecord[]): { id: string; revision: string } | null {
  if (records.length === 0 || records.some((entry) => !entry.state)) return null;
  const states = uniqueSorted(records.map((entry) => `${entry.state!.id}\u0000${entry.state!.revision}`));
  if (states.length !== 1) return null;
  return records[0].state;
}

function exactSurface(records: CaptureRecord[]): string | null {
  const surfaces = uniqueSorted(records.map((entry) => entry.surface));
  return surfaces.length === 1 ? surfaces[0] : null;
}

function environmentDigest(manifest: MapManifest): string {
  return digestOf({
    compatibilityKey: manifest.compatibilityKey,
    specHash: manifest.specHash,
    platform: manifest.platform,
    arch: manifest.arch,
    nodeMajor: manifest.nodeMajor,
    screenshots: manifest.screenshots,
    har: manifest.har,
  });
}

function executionState(present: boolean, complete: boolean): Phase0Execution {
  if (!present) return 'not-run';
  return complete ? 'complete' : 'partial';
}

function buildRuns(input: {
  shared: SharedRun;
  records: CaptureRecord[];
  state: { id: string; revision: string } | null;
  coverageComplete: boolean;
  determinismComplete: boolean;
  productStateComplete: boolean;
  evidenceComplete: boolean;
  sourceBound: boolean;
  beforeCoverage: CoverageLedger | null;
  afterCoverage: CoverageLedger | null;
  beforeConfidence: ConfidenceLedgerFile | null;
  afterConfidence: ConfidenceLedgerFile | null;
  determinismVerdict: unknown;
  binding: SourceBindingReceipt;
  captureDigest: string;
  evidence: { manifest: EvidenceCaptureManifest; digest: string } | null;
}): {
  sourceRuns: Phase0SourceRun[];
  captureRun: Phase0SourceRun;
  productRun: Phase0SourceRun;
  evidenceRun: Phase0SourceRun;
  productOutput: string;
} {
  const captureRun = styleproofRun(
    input.shared,
    'capture-maps',
    executionState(input.records.length > 0, input.sourceBound),
    input.captureDigest,
    ['computed-style'],
  );
  const coverageRun = styleproofRun(
    input.shared,
    'coverage-ledger',
    executionState(input.afterCoverage !== null, input.coverageComplete),
    input.afterCoverage ? digestOf({ coverage: input.afterCoverage, confidence: input.afterConfidence }) : EMPTY_DIGEST,
    ['coverage-registry', 'confidence-ledger'],
  );
  const determinismPresent = input.beforeCoverage !== null || input.afterCoverage !== null;
  const determinismRun = styleproofRun(
    input.shared,
    'determinism',
    executionState(determinismPresent, input.determinismComplete),
    determinismPresent
      ? digestOf({
          verdict: input.determinismVerdict,
          beforeConfidence: input.beforeConfidence,
          afterConfidence: input.afterConfidence,
        })
      : EMPTY_DIGEST,
    ['repeat-hash'],
  );
  const productPresent = input.records.length > 0;
  const productOutput = productPresent ? digestOf(input.records) : EMPTY_DIGEST;
  const productRun = productStateRun(
    input.shared,
    executionState(productPresent, input.productStateComplete),
    productOutput,
    input.state ? 1 : 0,
  );
  const evidenceRun = styleproofRun(
    input.shared,
    'evidence-store',
    executionState(input.evidence !== null, input.evidenceComplete),
    input.evidence?.digest ?? EMPTY_DIGEST,
    ['evidence-bytes'],
  );
  const sourceRun = styleproofRun(
    input.shared,
    'source-binding',
    input.sourceBound ? 'complete' : 'partial',
    digestOf(input.binding),
    ['source-sha'],
  );
  const byDomain = new Map<Phase0Domain, Phase0SourceRun>([
    ['capture-maps', captureRun],
    ['coverage-ledger', coverageRun],
    ['determinism', determinismRun],
    ['product-state', productRun],
    ['evidence-store', evidenceRun],
    ['source-binding', sourceRun],
  ]);
  return {
    sourceRuns: PHASE0_REQUIRED_DOMAINS.map((domain) => byDomain.get(domain)!),
    captureRun,
    productRun,
    evidenceRun,
    productOutput,
  };
}

function buildIdentityAssertions(input: {
  sourceSha: string;
  state: { id: string; revision: string } | null;
  surface: string | null;
  productOutput: string;
  configDigest: string;
  productRun: Phase0SourceRun;
  evidenceDigest?: string;
}): { identities: Phase0Identity[]; assertions: Phase0Assertion[] } {
  const identities: Phase0Identity[] = [{ id: 'snap-head', layer: 'source-snapshot', sourceSha: input.sourceSha }];
  const assertions: Phase0Assertion[] = [];
  if (input.state && input.surface) {
    identities.push({ id: input.state.id, layer: 'product-state', revision: input.state.revision });
    identities.push({ id: 'assert-product-state', layer: 'assertion', assertionId: 'assert-product-state' });
    assertions.push({
      id: 'assert-product-state',
      mode: 'declared',
      subject: input.state.id,
      predicate: 'has-revision',
      object: input.state.revision,
      sourceDigest: input.productOutput,
      inputDigest: input.configDigest,
      producer: input.productRun.producer,
      producerVersion: input.productRun.producerVersion,
      run: input.productRun.id,
      scope: input.surface,
      validity: 'snap-head',
    });
  }
  if (input.evidenceDigest) {
    identities.push({ id: 'evidence-head', layer: 'evidence', evidenceDigest: input.evidenceDigest });
  }
  return { identities, assertions };
}

function buildObligations(input: {
  records: CaptureRecord[];
  state: { id: string; revision: string } | null;
  surface: string | null;
  comparability: Phase0Comparability[];
  environment: string;
  prerequisitesComplete: boolean;
}): Phase0Obligation[] {
  const physicalKey = input.records.length === 1 ? input.records[0].physicalCaptureKey : null;
  if (!input.state || !input.surface || !physicalKey) return [];
  return input.comparability
    .filter((entry) => entry.required)
    .map((entry) => ({
      id: `obligation-${entry.surface}`,
      required: true,
      state: input.state!.id,
      surface: entry.surface,
      environment: input.environment,
      sensor: 'styleproof.computed-style',
      sourceSnapshot: 'snap-head',
      physicalCaptureKey: physicalKey,
      outcome: input.prerequisitesComplete && entry.status === 'comparable' ? 'satisfied' : 'unproven',
    }));
}

function buildIntegrity(input: {
  evidenceDigest?: string;
  sourceSha: string;
  compatibilityKey: string;
  captureRun: Phase0SourceRun;
  evidenceRun: Phase0SourceRun;
  sourceRuns: Phase0SourceRun[];
  assertions: Phase0Assertion[];
  obligations: Phase0Obligation[];
}): Phase0IntegrityJoin[] {
  if (!input.evidenceDigest) return [];
  const credited = new Set<string>([input.captureRun.outputDigest, input.evidenceDigest]);
  for (const run of input.sourceRuns) {
    credited.add(run.outputDigest);
    credited.add(run.configDigest);
  }
  for (const assertion of input.assertions) {
    credited.add(assertion.sourceDigest);
    credited.add(assertion.inputDigest);
  }
  return input.obligations
    .filter((entry) => entry.required && entry.outcome === 'satisfied')
    .map((entry) => ({
      obligationId: entry.id,
      sourceSha: input.sourceSha,
      manifestDigest: input.captureRun.outputDigest,
      compatibilityKey: input.compatibilityKey,
      producer: input.evidenceRun.producer,
      run: input.evidenceRun.id,
      physicalCaptureKey: entry.physicalCaptureKey,
      semanticStateId: entry.state,
      environmentDigest: entry.environment,
      sensorContract: entry.sensor,
      evidenceDigest: input.evidenceDigest!,
      artifactDigests: [...credited].sort(compareText),
    }));
}

function compatibleBinding(input: ReleaseConfidenceProjectInput): SourceBindingReceipt {
  try {
    return assertCompatibleMapDirs(input.beforeDir, input.afterDir, {
      beforeSha: input.expectedBeforeSha,
      afterSha: input.expectedAfterSha,
    });
  } catch {
    throw new ReleaseConfidenceProjectError();
  }
}

function completeCoverage(ledger: CoverageLedger | null, verdict: ReturnType<typeof auditCoverage>): boolean {
  return ledger !== null && verdict.basis === 'complete';
}

function completeDeterminism(before: CoverageLedger | null, after: CoverageLedger | null): boolean {
  if (!before || !after) return false;
  const proven = ['self-checked', 'replayed'];
  return proven.includes(before.determinism ?? '') && proven.includes(after.determinism ?? '');
}

function completeEvidence(evidence: { manifest: EvidenceCaptureManifest; digest: string } | null): boolean {
  if (!evidence) return false;
  return evidence.manifest.trust.coverageBasis === 'complete' && evidence.manifest.trust.determinismStatus === 'proven';
}

function everyPrerequisite(...values: boolean[]): boolean {
  return values.every(Boolean);
}

function assembleContract(input: ReleaseConfidenceProjectInput): Phase0ContractDocument {
  const afterManifest = requiredHeadManifest(input.afterDir);
  const beforeCoverage = strictCoverage(input.beforeDir);
  const afterCoverage = strictCoverage(input.afterDir);
  const beforeConfidence = strictConfidence(input.beforeDir);
  const afterConfidence = strictConfidence(input.afterDir);
  const records = captureRecords(input.afterDir);
  const surface = exactSurface(records);
  const state = exactState(records);
  const binding = compatibleBinding(input);
  const evidence = requiredEvidence(input.evidence, afterManifest.sha, afterManifest.compatibilityKey);
  const comparability = copiedComparability(input.beforeDir, input.afterDir);
  const captureBinding = captureEvidenceBindingReceipt(input.beforeDir, input.afterDir);
  const capturedKeys = bundleSurfaceKeys(input.afterDir, afterCoverage?.expected ?? null);
  const coverageVerdict = auditCoverage(capturedKeys, afterCoverage);
  const determinismVerdict = auditDeterminism(beforeCoverage, afterCoverage);
  const shared: SharedRun = {
    sourceSha: afterManifest.sha,
    compatibilityKey: afterManifest.compatibilityKey,
    configDigest: afterManifest.specHash,
    producerVersion: afterManifest.packageVersion,
    scope: surface ?? input.releaseScope,
  };

  const coverageComplete = completeCoverage(afterCoverage, coverageVerdict);
  const determinismComplete = completeDeterminism(beforeCoverage, afterCoverage);
  const sourceBound = binding.status === 'bound';
  const captureComplete = records.length > 0 && sourceBound;
  const productStateComplete = surface !== null && state !== null;
  const evidenceComplete = completeEvidence(evidence);

  const { sourceRuns, captureRun, productRun, evidenceRun, productOutput } = buildRuns({
    shared,
    records,
    state,
    coverageComplete,
    determinismComplete,
    productStateComplete,
    evidenceComplete,
    sourceBound,
    beforeCoverage,
    afterCoverage,
    beforeConfidence,
    afterConfidence,
    determinismVerdict,
    binding,
    captureDigest: captureBinding.after.digest,
    evidence,
  });

  const { identities, assertions } = buildIdentityAssertions({
    sourceSha: afterManifest.sha,
    state,
    surface,
    productOutput,
    configDigest: shared.configDigest,
    productRun,
    evidenceDigest: evidence?.digest,
  });

  const prerequisitesComplete = everyPrerequisite(
    captureComplete,
    coverageComplete,
    determinismComplete,
    productStateComplete,
    evidenceComplete,
    sourceBound,
  );
  const obligations = buildObligations({
    records,
    state,
    surface,
    comparability,
    environment: environmentDigest(afterManifest),
    prerequisitesComplete,
  });

  const contract: Phase0ContractDocument = {
    version: '0.1',
    documentId: input.manifestId,
    identities,
    assertions,
    sourceRuns,
    obligations,
    relations: [],
    comparability,
    integrity: buildIntegrity({
      evidenceDigest: evidence?.digest,
      sourceSha: afterManifest.sha,
      compatibilityKey: afterManifest.compatibilityKey,
      captureRun,
      evidenceRun,
      sourceRuns,
      assertions,
      obligations,
    }),
  };
  return contract;
}

export function projectReleaseConfidence(input: ReleaseConfidenceProjectInput): ReleaseConfidenceProjectResult {
  try {
    const contract = assembleContract(input);
    return {
      contract,
      manifest: createReleaseConfidenceManifest({
        manifestId: input.manifestId,
        producerVersion: input.producerVersion,
        releaseScope: input.releaseScope,
        contract,
      }),
    };
  } catch (error) {
    if (error instanceof ReleaseConfidenceProjectError) throw error;
    throw new ReleaseConfidenceProjectError();
  }
}
