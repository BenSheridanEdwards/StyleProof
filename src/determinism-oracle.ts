import { createHash } from 'node:crypto';

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

type NormalizedReceipt = {
  stateKeys: readonly string[];
  mapHashes: Readonly<Record<string, string>>;
  signature: string;
};

type ReceiptValidation = { ok: true; receipt: NormalizedReceipt } | { ok: false; diagnostic: string };

function jsonSafetyError(detail: string): never {
  throw new TypeError(`determinism map must be JSON-safe: ${detail}`);
}

function assertNoSymbolKeys(keys: readonly (string | symbol)[]): void {
  if (keys.some((key) => typeof key === 'symbol')) jsonSafetyError('symbol keys are not valid JSON');
}

function assertEnumerableDataProperty(value: object, key: string, kind: 'array element' | 'object field'): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    jsonSafetyError(`${kind}s must be enumerable data properties`);
  }
  return descriptor.value;
}

function canonicalJsonArray(value: unknown[], active: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  assertNoSymbolKeys(ownKeys);
  const elementKeys = ownKeys.filter((key) => key !== 'length') as string[];
  if (elementKeys.length !== value.length) jsonSafetyError('arrays must be dense and contain no custom properties');
  const elements = value.map((_, index) =>
    canonicalJson(assertEnumerableDataProperty(value, String(index), 'array element'), active),
  );
  return `[${elements.join(',')}]`;
}

function canonicalJsonObject(value: object, active: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    jsonSafetyError('objects must be plain records');
  }
  const ownKeys = Reflect.ownKeys(value);
  assertNoSymbolKeys(ownKeys);
  const fields = (ownKeys as string[]).sort().map((key) => {
    const field = assertEnumerableDataProperty(value, key, 'object field');
    return `${JSON.stringify(key)}:${canonicalJson(field, active)}`;
  });
  return `{${fields.join(',')}}`;
}

function canonicalJson(value: unknown, active = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) jsonSafetyError('numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') jsonSafetyError(`${typeof value} values are not valid JSON`);
  if (active.has(value)) jsonSafetyError('cyclic references are not valid JSON');

  active.add(value);
  try {
    return Array.isArray(value) ? canonicalJsonArray(value, active) : canonicalJsonObject(value, active);
  } finally {
    active.delete(value);
  }
}

/** Hash a strict JSON computed map after recursively sorting object keys. Array order remains significant. */
export function hashDeterminismMap(map: unknown): string {
  return createHash('sha256').update(canonicalJson(map)).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateReceiptUnchecked(run: unknown, index: number): ReceiptValidation {
  const prefix = `run ${index + 1}`;
  if (!isPlainRecord(run)) return { ok: false, diagnostic: `${prefix}: receipt must be a plain object` };
  if (!Array.isArray(run.stateKeys) || run.stateKeys.length === 0) {
    return { ok: false, diagnostic: `${prefix}: stateKeys must be a non-empty array` };
  }
  if (!run.stateKeys.every((key): key is string => typeof key === 'string' && key.length > 0)) {
    return { ok: false, diagnostic: `${prefix}: every state key must be a non-empty string` };
  }
  const stateKeys = [...run.stateKeys];
  if (new Set(stateKeys).size !== stateKeys.length) {
    return { ok: false, diagnostic: `${prefix}: stateKeys must be unique` };
  }
  if (!isPlainRecord(run.mapHashes)) {
    return { ok: false, diagnostic: `${prefix}: mapHashes must be a plain object` };
  }
  if (Reflect.ownKeys(run.mapHashes).some((key) => typeof key === 'symbol')) {
    return { ok: false, diagnostic: `${prefix}: mapHashes must not contain symbol keys` };
  }

  const hashKeys = Object.keys(run.mapHashes);
  const expectedKeys = new Set(stateKeys);
  if (hashKeys.length !== stateKeys.length || hashKeys.some((key) => !expectedKeys.has(key))) {
    return { ok: false, diagnostic: `${prefix}: map hash keys must exactly match stateKeys` };
  }

  const entries: [string, string][] = [];
  for (const key of stateKeys) {
    const hash = run.mapHashes[key];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
      return { ok: false, diagnostic: `${prefix}: map hash for ${JSON.stringify(key)} must be a SHA-256 hex string` };
    }
    entries.push([key, hash.toLowerCase()]);
  }
  const mapHashes = Object.fromEntries(entries);
  return {
    ok: true,
    receipt: {
      stateKeys,
      mapHashes,
      signature: JSON.stringify([stateKeys, entries.map(([, hash]) => hash)]),
    },
  };
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
  for (const receipt of receipts) {
    counts.set(receipt.signature, (counts.get(receipt.signature) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/**
 * Build one run's receipt from the maps a single capture wrote.
 *
 * Keys are sorted, so the receipt depends on WHICH surfaces were captured and what
 * they rendered — never on the order the filesystem happened to list them in. Every
 * producer (the capture CLI, the browser fixture) must build receipts through this
 * one function, or two honest runs could disagree purely on key order.
 */
export function determinismRunReceipt(entries: Iterable<readonly [string, unknown]>): DeterminismRunReceipt {
  const captured = [...entries];
  const stateKeys = captured.map(([key]) => key).sort();
  if (new Set(stateKeys).size !== stateKeys.length) {
    throw new TypeError('determinism receipt requires unique state keys');
  }
  const maps = new Map(captured);
  return {
    stateKeys,
    mapHashes: Object.fromEntries(stateKeys.map((key) => [key, hashDeterminismMap(maps.get(key))])),
  };
}

/** Assess the exact five-run promotion oracle required for deterministic state classes. */
export function assessDeterminismOracle(runs: readonly unknown[]): DeterminismOracleVerdict {
  const inputRuns = Array.isArray(runs) ? runs : [];
  const validations = inputRuns.map(validateReceipt);
  const validReceipts = validations.flatMap((validation) => (validation.ok ? [validation.receipt] : []));
  const matchingRuns = countMatchingReceipts(validReceipts);

  if (inputRuns.length !== 5) {
    return {
      status: 'flake',
      reason: 'run-count',
      requiredRuns: 5,
      observedRuns: inputRuns.length,
      matchingRuns,
      runs: inputRuns,
      diagnostics: [`expected exactly 5 runs, received ${inputRuns.length}`],
    };
  }

  const invalidDiagnostics = validations.flatMap((validation) => (validation.ok ? [] : [validation.diagnostic]));
  if (invalidDiagnostics.length > 0) {
    return {
      status: 'flake',
      reason: 'invalid-receipt',
      requiredRuns: 5,
      observedRuns: 5,
      matchingRuns,
      runs: inputRuns,
      diagnostics: invalidDiagnostics,
    };
  }

  if (matchingRuns !== 5) {
    return {
      status: 'flake',
      reason: 'mismatch',
      requiredRuns: 5,
      observedRuns: 5,
      matchingRuns,
      runs: inputRuns,
      diagnostics: [`expected all 5 runs to match, largest matching group was ${matchingRuns}`],
    };
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
