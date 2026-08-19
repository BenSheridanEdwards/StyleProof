import { createHash } from 'node:crypto';

export type DeterminismRunReceipt = {
  stateKeys: readonly string[];
  mapHashes: Readonly<Record<string, string>>;
};

export type DeterministicOracleVerdict = {
  status: 'deterministic';
  requiredRuns: 5;
  observedRuns: number;
  matchingRuns: number;
  stateKeys: readonly string[];
  mapHashes: Readonly<Record<string, string>>;
};

export type NonDeterministicOracleVerdict = {
  status: 'flake' | 'insufficient';
  requiredRuns: 5;
  observedRuns: number;
  matchingRuns: number;
  runs: readonly DeterminismRunReceipt[];
};

export type DeterminismOracleVerdict = DeterministicOracleVerdict | NonDeterministicOracleVerdict;

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Hash a computed map after recursively sorting object keys. Array order remains significant. */
export function hashDeterminismMap(map: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJsonValue(map)))
    .digest('hex');
}

function runSignature(run: DeterminismRunReceipt): string {
  return JSON.stringify(run);
}

/** Assess the five-run promotion oracle required for deterministic state classes. */
export function assessDeterminismOracle(runs: readonly DeterminismRunReceipt[]): DeterminismOracleVerdict {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const signature = runSignature(run);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const matchingRuns = Math.max(0, ...counts.values());
  if (runs.length < 5) {
    return {
      status: 'insufficient',
      requiredRuns: 5,
      observedRuns: runs.length,
      matchingRuns,
      runs,
    };
  }
  if (matchingRuns !== runs.length) {
    return {
      status: 'flake',
      requiredRuns: 5,
      observedRuns: runs.length,
      matchingRuns,
      runs,
    };
  }
  return {
    status: 'deterministic',
    requiredRuns: 5,
    observedRuns: runs.length,
    matchingRuns,
    stateKeys: runs[0].stateKeys,
    mapHashes: runs[0].mapHashes,
  };
}
