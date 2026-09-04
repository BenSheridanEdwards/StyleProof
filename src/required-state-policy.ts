import { types as utilTypes } from 'node:util';

import { type ProductStateIdentity, validateProductStateIdentity } from './capture.js';
import { assertSafeCaptureKey, surfaceBase } from './surface-keys.js';

export type RequiredStateComparison = Readonly<{
  surface: string;
  productState: ProductStateIdentity;
  owner: string;
  reason: string;
}>;

export class RequiredStateComparisonError extends Error {
  constructor(message: string) {
    super(`styleproof: invalid requiredStateComparisons — ${message}`);
    this.name = 'RequiredStateComparisonError';
  }
}

const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REQUIREMENTS = 256;
const PUBLIC_PROSE = /^[\x20-\x7E]+$/;
const MARKDOWN_OR_HTML = /[<>`*_{}]|\[|\]/;
const CREDENTIAL_MARKER =
  /(?:(?:api|access|private|secret)[\s_-]?key|authorization|bearer|client[\s_-]?secret|credential|password|secret|token)/i;
const TOKEN_LIKE_RUN = /[A-Za-z0-9_-]{32,}/;
const SEGMENTED_TOKEN_LIKE = /[A-Za-z0-9_-]{16,}(?:[.:/=-][A-Za-z0-9_-]{16,})+/;
const PERSONAL_DATA_LIKE =
  /(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|\b\d{3}-\d{2}-\d{4}\b|\b(?:\+?\d[\d ()-]{7,}\d)\b|\b[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*\b)/i;
const PUBLIC_LOCATION_LIKE =
  /(?:\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\\)|(?:^|[^a-z0-9])\/(?:[^\s/]+\/)+|(?:^|[^a-z0-9])[a-z]:[\\/]|(?:^|[^a-z0-9])\\\\[^\s\\]+\\|(?:^|[^a-z0-9])(?:\.\.[\\/])+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b)/i;
const PUBLIC_OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function safePublicReason(value: string, label: string): string {
  if (!PUBLIC_PROSE.test(value) || MARKDOWN_OR_HTML.test(value)) {
    throw new RequiredStateComparisonError(`${label} must be plain printable prose without Markdown or HTML syntax`);
  }
  if (CREDENTIAL_MARKER.test(value) || TOKEN_LIKE_RUN.test(value) || SEGMENTED_TOKEN_LIKE.test(value)) {
    throw new RequiredStateComparisonError(`${label} must not contain credential markers or token-like values`);
  }
  if (PERSONAL_DATA_LIKE.test(value) || PUBLIC_LOCATION_LIKE.test(value)) {
    throw new RequiredStateComparisonError(`${label} must not contain personal data or public locations`);
  }
  return value;
}

function safePublicOwner(value: string, label: string): string {
  if (CREDENTIAL_MARKER.test(value) || TOKEN_LIKE_RUN.test(value) || !PUBLIC_OWNER.test(value)) {
    throw new RequiredStateComparisonError(`${label} must be a lowercase low-entropy team or component slug`);
  }
  return value;
}

function descriptorsOf(value: unknown, label: string): PropertyDescriptorMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new RequiredStateComparisonError(`${label} must be an object`);
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new RequiredStateComparisonError(`${label} must be a plain JSON object`);
    }
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new RequiredStateComparisonError(`${label} could not be read safely`);
  }
}

function plainValue(descriptor: PropertyDescriptor | undefined, label: string): unknown {
  if (!descriptor || !('value' in descriptor)) throw new RequiredStateComparisonError(`${label} must be a plain value`);
  return descriptor.value;
}

function jsonFieldValue(descriptor: PropertyDescriptor | undefined, label: string): unknown {
  const value = plainValue(descriptor, label);
  if (!descriptor?.enumerable || !descriptor.configurable || !descriptor.writable) {
    throw new RequiredStateComparisonError(`${label} must be an enumerable plain JSON field`);
  }
  return value;
}

function boundedString(value: unknown, label: string, max: number, opaque = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim()) {
    throw new RequiredStateComparisonError(`${label} must be a non-empty bounded string`);
  }
  if (opaque && !OPAQUE_IDENTIFIER.test(value)) {
    throw new RequiredStateComparisonError(`${label} must be an opaque identifier`);
  }
  return value;
}

function denseArrayDescriptors(value: unknown): { descriptors: PropertyDescriptorMap; length: number } {
  if (!Array.isArray(value) || utilTypes.isProxy(value))
    throw new RequiredStateComparisonError('expected a plain array');
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RequiredStateComparisonError('expected a plain array');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new RequiredStateComparisonError('array could not be read safely');
  }
  const lengthDescriptor = descriptors.length;
  const length = plainValue(lengthDescriptor, 'array length');
  if (lengthDescriptor?.enumerable || lengthDescriptor?.configurable || !lengthDescriptor?.writable) {
    throw new RequiredStateComparisonError('array length must use plain JSON array attributes');
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new RequiredStateComparisonError('array length must be a safe integer');
  }
  if (length > MAX_REQUIREMENTS) {
    throw new RequiredStateComparisonError(`at most ${MAX_REQUIREMENTS} entries are allowed`);
  }
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set<PropertyKey>(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new RequiredStateComparisonError('arrays must be dense and contain no extra properties');
  }
  return { descriptors, length };
}

function requiredSurface(descriptors: PropertyDescriptorMap, index: number): string {
  const surface = boundedString(
    jsonFieldValue(descriptors.surface, `entry ${index}.surface`),
    `entry ${index}.surface`,
    128,
  );
  try {
    assertSafeCaptureKey(surface);
  } catch {
    throw new RequiredStateComparisonError(`entry ${index}.surface must be a safe width-normalized surface key`);
  }
  if (surfaceBase(surface) !== surface) {
    throw new RequiredStateComparisonError(`entry ${index}.surface must not include a viewport width`);
  }
  return surface;
}

function requiredProductState(descriptors: PropertyDescriptorMap, index: number): ProductStateIdentity {
  let productState: ProductStateIdentity | undefined;
  try {
    const raw = jsonFieldValue(descriptors.productState, `entry ${index}.productState`);
    const stateDescriptors = descriptorsOf(raw, `entry ${index}.productState`);
    const stateFields = Reflect.ownKeys(stateDescriptors);
    if (stateFields.length !== 2 || !stateFields.includes('id') || !stateFields.includes('revision')) {
      throw new RequiredStateComparisonError(`entry ${index}.productState must contain only id and revision`);
    }
    jsonFieldValue(stateDescriptors.id, `entry ${index}.productState.id`);
    jsonFieldValue(stateDescriptors.revision, `entry ${index}.productState.revision`);
    productState = validateProductStateIdentity(raw);
  } catch {
    throw new RequiredStateComparisonError(
      `entry ${index}.productState must contain valid id and revision identifiers`,
    );
  }
  if (!productState) throw new RequiredStateComparisonError(`entry ${index}.productState is required`);
  return productState;
}

function parseRequiredStateEntry(entry: unknown, index: number): RequiredStateComparison {
  const descriptors = descriptorsOf(entry, `entry ${index}`);
  const fields = Reflect.ownKeys(descriptors);
  const allowed = ['surface', 'productState', 'owner', 'reason'];
  if (fields.length !== allowed.length || fields.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new RequiredStateComparisonError(`entry ${index} must contain only surface, productState, owner, and reason`);
  }
  const surface = requiredSurface(descriptors, index);
  const productState = requiredProductState(descriptors, index);
  const owner = boundedString(
    jsonFieldValue(descriptors.owner, `entry ${index}.owner`),
    `entry ${index}.owner`,
    128,
    true,
  );
  safePublicOwner(owner, `entry ${index}.owner`);
  const reason = safePublicReason(
    boundedString(jsonFieldValue(descriptors.reason, `entry ${index}.reason`), `entry ${index}.reason`, 512),
    `entry ${index}.reason`,
  );
  return { surface, productState: { ...productState }, owner, reason };
}

export function parseRequiredStateComparisons(value: unknown): RequiredStateComparison[] {
  if (value === undefined) return [];
  const { descriptors, length } = denseArrayDescriptors(value);
  const seen = new Set<string>();
  const parsed: RequiredStateComparison[] = [];
  for (let index = 0; index < length; index += 1) {
    const requirement = parseRequiredStateEntry(jsonFieldValue(descriptors[String(index)], `entry ${index}`), index);
    const tuple = `${requirement.surface}\0${requirement.productState.id}\0${requirement.productState.revision}`;
    if (seen.has(tuple)) {
      throw new RequiredStateComparisonError(`entry ${index} duplicates an earlier state × surface tuple`);
    }
    seen.add(tuple);
    parsed.push(requirement);
  }
  return parsed;
}
