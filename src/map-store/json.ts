// Guarded JSON helpers shared by the map-store modules: duplicate-key detection,
// sidecar reads, and the bounded-value guards the manifest and receipt readers use.
import fs from 'node:fs';
import { readRegularFileNoFollow } from '../safe-filesystem.js';

function duplicateKey(scope: Set<string>, token: string): boolean {
  const key = JSON.parse(token) as string;
  if (scope.has(key)) return true;
  scope.add(key);
  return false;
}

/** JSON.parse keeps only the last duplicate key; certification receipts must reject that
 *  ambiguity. Runs only after JSON.parse has established valid grammar, so every string
 *  token that follows `{` or an object-level `,` is a key. */
export function hasDuplicateJsonKeys(source: string): boolean {
  const scopes: (Set<string> | null)[] = [];
  let expectKey = false;
  for (const [token] of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    const scope = scopes.at(-1);
    if (token === '{') scopes.push(new Set());
    else if (token === '[') scopes.push(null);
    else if (token === '}' || token === ']') scopes.pop();
    else if (expectKey && scope && duplicateKey(scope, token)) return true;
    expectKey = token === '{' || (token === ',' && scope instanceof Set);
  }
  return false;
}

/** Parse a JSON file; `undefined` when absent or malformed. */
export function readJsonFile<T>(file: string | URL): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Parse a bundle sidecar read no-follow; `undefined` when absent, unsafe, or malformed. */
export function readJsonSidecar<T>(file: string, maximumBytes?: number): T | undefined {
  try {
    return JSON.parse(readRegularFileNoFollow(file, maximumBytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
};

/** Control characters become spaces, whitespace runs collapse, and the result is clipped. */
export function boundedText(value: string, maximumLength: number, fallback: string): string {
  const normalized = [...value]
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maximumLength);
}

export function boundedString(value: unknown, maximumLength = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    ![...value].some(isControlCharacter)
  );
}

export const optionalBoundedString = (value: unknown, maximumLength = 4096): boolean =>
  value === undefined || boundedString(value, maximumLength);

export const matchesBoundedString = (value: unknown, expression: RegExp, maximumLength = 4096): value is string =>
  boundedString(value, maximumLength) && expression.test(value);

export function canonicalInstant(value: unknown): value is string {
  if (!boundedString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export const canonicalContentHash = (value: unknown): value is string =>
  value === 'missing' || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
