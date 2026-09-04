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
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|private[_-]?key|secret|token)/i;
const TOKEN_LIKE_RUN = /[A-Za-z0-9_-]{32,}/;
const PERSONAL_DATA_LIKE =
  /(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|\b\d{3}-\d{2}-\d{4}\b|\b(?:\+?\d[\d ()-]{7,}\d)\b)/i;
const PUBLIC_OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function safePublicReason(value: string, label: string): string {
  if (!PUBLIC_PROSE.test(value) || MARKDOWN_OR_HTML.test(value)) {
    throw new RequiredStateComparisonError(`${label} must be plain printable prose without Markdown or HTML syntax`);
  }
  if (CREDENTIAL_MARKER.test(value) || TOKEN_LIKE_RUN.test(value)) {
    throw new RequiredStateComparisonError(`${label} must not contain credential markers or token-like values`);
  }
  if (PERSONAL_DATA_LIKE.test(value)) {
    throw new RequiredStateComparisonError(`${label} must not contain personal data`);
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequiredStateComparisonError(`${label} must be an object`);
  }
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new RequiredStateComparisonError(`${label} could not be read safely`);
  }
}

function plainValue(descriptor: PropertyDescriptor | undefined, label: string): unknown {
  if (!descriptor || !('value' in descriptor)) throw new RequiredStateComparisonError(`${label} must be a plain value`);
  return descriptor.value;
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

export function parseRequiredStateComparisons(value: unknown): RequiredStateComparison[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequiredStateComparisonError('expected an array');
  if (value.length > MAX_REQUIREMENTS)
    throw new RequiredStateComparisonError(`at most ${MAX_REQUIREMENTS} entries are allowed`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!(index in value)) throw new RequiredStateComparisonError('sparse arrays are not allowed');
    const descriptors = descriptorsOf(entry, `entry ${index}`);
    const fields = Reflect.ownKeys(descriptors);
    const allowed = ['surface', 'productState', 'owner', 'reason'];
    if (fields.length !== allowed.length || fields.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
      throw new RequiredStateComparisonError(
        `entry ${index} must contain only surface, productState, owner, and reason`,
      );
    }
    const surface = boundedString(
      plainValue(descriptors.surface, `entry ${index}.surface`),
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
    let productState: ProductStateIdentity | undefined;
    try {
      productState = validateProductStateIdentity(plainValue(descriptors.productState, `entry ${index}.productState`));
    } catch {
      throw new RequiredStateComparisonError(
        `entry ${index}.productState must contain valid id and revision identifiers`,
      );
    }
    if (!productState) throw new RequiredStateComparisonError(`entry ${index}.productState is required`);
    const owner = boundedString(
      plainValue(descriptors.owner, `entry ${index}.owner`),
      `entry ${index}.owner`,
      128,
      true,
    );
    safePublicOwner(owner, `entry ${index}.owner`);
    const reason = safePublicReason(
      boundedString(plainValue(descriptors.reason, `entry ${index}.reason`), `entry ${index}.reason`, 512),
      `entry ${index}.reason`,
    );
    const tuple = `${surface}\0${productState.id}\0${productState.revision}`;
    if (seen.has(tuple))
      throw new RequiredStateComparisonError(`entry ${index} duplicates an earlier state × surface tuple`);
    seen.add(tuple);
    return { surface, productState: { ...productState }, owner, reason };
  });
}
