import { sha256 } from './node-util.js';

export type DeterminismRunReceipt = {
  stateKeys: readonly string[];
  mapHashes: Readonly<Record<string, string>>;
};

export type DeterminismFlakeReason = 'run-count' | 'invalid-receipt' | 'mismatch';

export type DeterministicOracleVerdict = {
  status: 'deterministic';
  requiredRuns: 5;
  observedRuns: 5;
  matchingRuns: 5;
  stateKeys: readonly string[];
  mapHashes: Readonly<Record<string, string>>;
};

export type NonDeterministicOracleVerdict = {
  status: 'flake';
  reason: DeterminismFlakeReason;
  requiredRuns: 5;
  observedRuns: number;
  matchingRuns: number;
  runs: readonly unknown[];
  diagnostics: readonly string[];
};

export type DeterminismOracleVerdict = DeterministicOracleVerdict | NonDeterministicOracleVerdict;

type NormalizedReceipt = DeterminismRunReceipt & { signature: string };

type ReceiptValidation = { ok: true; receipt: NormalizedReceipt } | { ok: false; diagnostic: string };

function jsonSafetyError(detail: string): never {
  throw new TypeError(`determinism map must be JSON-safe: ${detail}`);
}

/** Own string keys, rejecting symbols. */
function ownStringKeys(value: object): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) jsonSafetyError('symbol keys are not valid JSON');
  return keys as string[];
}

function dataProperty(value: object, key: string, kind: 'array element' | 'object field'): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    jsonSafetyError(`${kind}s must be enumerable data properties`);
  }
  return descriptor.value;
}

const isPlainPrototype = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Strict JSON serialization with object keys sorted recursively; array order stays significant. */
function canonicalJson(value: unknown, active = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) jsonSafetyError('numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') jsonSafetyError(`${typeof value} values are not valid JSON`);
  if (active.has(value)) jsonSafetyError('cyclic references are not valid JSON');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = ownStringKeys(value).filter((key) => key !== 'length');
      if (keys.length !== value.length) jsonSafetyError('arrays must be dense and contain no custom properties');
      return `[${value.map((_, i) => canonicalJson(dataProperty(value, String(i), 'array element'), active)).join(',')}]`;
    }
    if (!isPlainPrototype(value)) jsonSafetyError('objects must be plain records');
    const fields = ownStringKeys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(dataProperty(value, key, 'object field'), active)}`);
    return `{${fields.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

/** Hash a strict JSON computed map after recursively sorting object keys. */
export function hashDeterminismMap(map: unknown): string {
  return sha256(canonicalJson(map));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && isPlainPrototype(value);
}

const isKeyList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((key) => typeof key === 'string' && key.length > 0);

/** Receipt shape checks in order; the first failing message is the diagnostic. */
const RECEIPT_CHECKS: [test: (run: Record<string, unknown>) => boolean, message: string][] = [
  [(run) => Array.isArray(run.stateKeys) && run.stateKeys.length > 0, 'stateKeys must be a non-empty array'],
  [(run) => isKeyList(run.stateKeys), 'every state key must be a non-empty string'],
  [(run) => new Set(run.stateKeys as string[]).size === (run.stateKeys as string[]).length, 'stateKeys must be unique'],
  [(run) => isPlainRecord(run.mapHashes), 'mapHashes must be a plain object'],
  [
    (run) => !Reflect.ownKeys(run.mapHashes as object).some((k) => typeof k === 'symbol'),
    'mapHashes must not contain symbol keys',
  ],
  [
    (run) => {
      const keys = Object.keys(run.mapHashes as object);
      const expected = new Set(run.stateKeys as string[]);
      return keys.length === expected.size && keys.every((key) => expected.has(key));
    },
    'map hash keys must exactly match stateKeys',
  ],
];

function validateReceiptUnchecked(run: unknown, index: number): ReceiptValidation {
  const prefix = `run ${index + 1}`;
  if (!isPlainRecord(run)) return { ok: false, diagnostic: `${prefix}: receipt must be a plain object` };
  const failed = RECEIPT_CHECKS.find(([test]) => !test(run));
  if (failed) return { ok: false, diagnostic: `${prefix}: ${failed[1]}` };
  const stateKeys = [...(run.stateKeys as string[])];
  const hashes = run.mapHashes as Record<string, unknown>;
  const entries: [string, string][] = [];
  for (const key of stateKeys) {
    const hash = hashes[key];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
      return { ok: false, diagnostic: `${prefix}: map hash for ${JSON.stringify(key)} must be a SHA-256 hex string` };
    }
    entries.push([key, hash.toLowerCase()]);
  }
  const signature = JSON.stringify([stateKeys, entries.map(([, hash]) => hash)]);
  return { ok: true, receipt: { stateKeys, mapHashes: Object.fromEntries(entries), signature } };
}

function validateReceipt(run: unknown, index: number): ReceiptValidation {
  try {
    return validateReceiptUnchecked(run, index);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostic: `run ${index + 1}: invalid receipt (${detail})` };
  }
}

function countMatchingReceipts(receipts: readonly NormalizedReceipt[]): number {
  const counts = new Map<string, number>();
  for (const receipt of receipts) counts.set(receipt.signature, (counts.get(receipt.signature) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

/** One run's receipt from the maps a capture wrote. Keys are sorted so key order can never make two honest runs disagree. */
export function determinismRunReceipt(entries: Iterable<readonly [string, unknown]>): DeterminismRunReceipt {
  const captured = [...entries];
  const stateKeys = captured.map(([key]) => key).sort();
  if (new Set(stateKeys).size !== stateKeys.length)
    throw new TypeError('determinism receipt requires unique state keys');
  const maps = new Map(captured);
  return { stateKeys, mapHashes: Object.fromEntries(stateKeys.map((key) => [key, hashDeterminismMap(maps.get(key))])) };
}

/** Assess the exact five-run promotion oracle required for deterministic state classes. */
export function assessDeterminismOracle(runs: readonly unknown[]): DeterminismOracleVerdict {
  const inputRuns = Array.isArray(runs) ? runs : [];
  const validations = inputRuns.map(validateReceipt);
  const validReceipts = validations.flatMap((validation) => (validation.ok ? [validation.receipt] : []));
  const matchingRuns = countMatchingReceipts(validReceipts);
  const invalidDiagnostics = validations.flatMap((validation) => (validation.ok ? [] : [validation.diagnostic]));
  const flake = (reason: DeterminismFlakeReason, diagnostics: string[]): NonDeterministicOracleVerdict => ({
    status: 'flake',
    reason,
    requiredRuns: 5,
    observedRuns: inputRuns.length,
    matchingRuns,
    runs: inputRuns,
    diagnostics,
  });
  if (inputRuns.length !== 5) return flake('run-count', [`expected exactly 5 runs, received ${inputRuns.length}`]);
  if (invalidDiagnostics.length > 0) return flake('invalid-receipt', invalidDiagnostics);
  if (matchingRuns !== 5) {
    return flake('mismatch', [`expected all 5 runs to match, largest matching group was ${matchingRuns}`]);
  }
  const first = validReceipts[0];
  return {
    status: 'deterministic',
    requiredRuns: 5,
    observedRuns: 5,
    matchingRuns: 5,
    stateKeys: first.stateKeys,
    mapHashes: first.mapHashes,
  };
}
