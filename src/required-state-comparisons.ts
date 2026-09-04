import {
  loadStyleMap,
  mapFilesByCaptureKey,
  type ProductStateIdentity,
  validateProductStateIdentity,
} from './capture.js';
import { diffStyleMapDirs } from './diff.js';
import { surfaceBase } from './surface-keys.js';

import {
  RequiredStateComparisonError,
  parseRequiredStateComparisons,
  type RequiredStateComparison,
} from './required-state-policy.js';
export {
  RequiredStateComparisonError,
  parseRequiredStateComparisons,
  type RequiredStateComparison,
} from './required-state-policy.js';

export type RequiredStateComparisonFailureReason =
  | 'missing-base'
  | 'missing-head'
  | 'missing-both'
  | 'wrong-surface'
  | 'wrong-state'
  | 'wrong-revision'
  | 'no-shared-capture-key'
  | 'not-comparable'
  | 'base-surface-metadata-missing'
  | 'head-surface-metadata-missing';

export type RequiredStateComparisonReceipt = RequiredStateComparison &
  Readonly<{
    status: 'satisfied' | 'unsatisfied';
    failures: RequiredStateComparisonFailureReason[];
  }>;

export type RequiredStateComparisonSummary = Readonly<{
  status: 'not-required' | 'satisfied' | 'unsatisfied';
  blocksCertification: boolean;
  counts: Readonly<{ declared: number; satisfied: number; unsatisfied: number }>;
  receipts: RequiredStateComparisonReceipt[];
}>;

type IndexedCapture = {
  key: string;
  surface?: string;
  state?: ProductStateIdentity;
};

function indexCaptures(dir: string): IndexedCapture[] {
  return [...mapFilesByCaptureKey(dir)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, file]) => {
      const metadata = loadStyleMap(file).metadata;
      let state: ProductStateIdentity | undefined;
      try {
        state = validateProductStateIdentity(metadata?.productState);
      } catch {
        throw new RequiredStateComparisonError('capture evidence contains malformed product-state identity');
      }
      return { key, surface: metadata?.surfaceKey, state };
    });
}

const exactState = (entry: IndexedCapture, required: RequiredStateComparison): boolean =>
  entry.surface === required.surface &&
  entry.state?.id === required.productState.id &&
  entry.state.revision === required.productState.revision;

function failureReasons(
  required: RequiredStateComparison,
  before: IndexedCapture[],
  after: IndexedCapture[],
  comparability: Map<string, string>,
): RequiredStateComparisonFailureReason[] {
  const beforeExact = before.filter((entry) => exactState(entry, required));
  const afterExact = after.filter((entry) => exactState(entry, required));
  const shared = beforeExact.filter((left) => afterExact.some((right) => right.key === left.key));
  if (shared.some((entry) => comparability.get(entry.key) !== 'comparable')) return ['not-comparable'];
  if (beforeExact.length && afterExact.length) return ['no-shared-capture-key'];
  const missingSurfaceMetadata: RequiredStateComparisonFailureReason[] = [];
  if (before.some((entry) => entry.surface === undefined && surfaceBase(entry.key) === required.surface)) {
    missingSurfaceMetadata.push('base-surface-metadata-missing');
  }
  if (after.some((entry) => entry.surface === undefined && surfaceBase(entry.key) === required.surface)) {
    missingSurfaceMetadata.push('head-surface-metadata-missing');
  }
  if (missingSurfaceMetadata.length > 0) return missingSurfaceMetadata;
  if (!beforeExact.length && afterExact.length) return ['missing-base'];
  if (beforeExact.length && !afterExact.length) return ['missing-head'];
  const all = [...before, ...after];
  if (
    all.some(
      (entry) =>
        entry.state?.id === required.productState.id &&
        entry.state.revision === required.productState.revision &&
        entry.surface !== undefined &&
        entry.surface !== required.surface,
    )
  )
    return ['wrong-surface'];
  if (
    all.some(
      (entry) =>
        entry.surface === required.surface &&
        entry.state?.id === required.productState.id &&
        entry.state.revision !== required.productState.revision,
    )
  )
    return ['wrong-revision'];
  if (
    all.some(
      (entry) => entry.surface === required.surface && entry.state && entry.state.id !== required.productState.id,
    )
  )
    return ['wrong-state'];
  return ['missing-both'];
}

export function auditRequiredStateComparisons(
  beforeDir: string,
  afterDir: string,
  declarations: readonly RequiredStateComparison[],
): RequiredStateComparisonSummary {
  const required = parseRequiredStateComparisons(declarations);
  if (required.length === 0) {
    return {
      status: 'not-required',
      blocksCertification: false,
      counts: { declared: 0, satisfied: 0, unsatisfied: 0 },
      receipts: [],
    };
  }
  const before = indexCaptures(beforeDir);
  const after = indexCaptures(afterDir);
  const comparison = new Map(
    diffStyleMapDirs(beforeDir, afterDir).comparability.map((entry) => [entry.surface, entry.status]),
  );
  const receipts = required.map((entry): RequiredStateComparisonReceipt => {
    const exactShared = before.filter(
      (left) => exactState(left, entry) && after.some((right) => right.key === left.key && exactState(right, entry)),
    );
    const satisfied = exactShared.some((capture) => comparison.get(capture.key) === 'comparable');
    return {
      ...entry,
      productState: { ...entry.productState },
      status: satisfied ? 'satisfied' : 'unsatisfied',
      failures: satisfied ? [] : failureReasons(entry, before, after, comparison),
    };
  });
  const satisfied = receipts.filter((entry) => entry.status === 'satisfied').length;
  const unsatisfied = receipts.length - satisfied;
  return {
    status: unsatisfied ? 'unsatisfied' : 'satisfied',
    blocksCertification: unsatisfied > 0,
    counts: { declared: receipts.length, satisfied, unsatisfied },
    receipts,
  };
}
