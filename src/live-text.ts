/**
 * Live/age/clock text — keep relative ages and clocks from masquerading as
 * stylesheet regressions.
 *
 * `freezeClock` pins `Date.now()` / `new Date()`. Server-rendered ages and
 * other clocks that ignore that freeze still drift in captured text
 * (`open 102.1d` → `open 103.1d`). Adopters declare `liveText` so that drift
 * is either:
 *   - advisory (not STYLE_REVIEW_REQUIRED / certify-blocking as style), or
 *   - freeze-checked: declared freeze + drifting ages is fail-closed, never
 *     a soft-green and never a style review.
 *
 * The certification differ stays exact. This module classifies content and
 * geometry so the report and verdict can name the right gate.
 */

export class LiveTextError extends Error {
  constructor(message: string) {
    super(`styleproof: invalid liveText — ${message}`);
    this.name = 'LiveTextError';
  }
}

/** Consumer-owned declaration persisted on capture metadata. */
export type LiveTextDeclaration = {
  /** When true, declared/detected age text must be identical on base and head. */
  freeze: boolean;
  /** Optional CSS selectors whose own text is live/age/clock data. */
  selectors: string[];
};

export type LiveTextInput = boolean | { freeze?: boolean; selectors?: string[] };

const SELECTOR = /^[A-Za-z0-9_.:#[\]="'*\s>+~-]{1,256}$/;
const MAX_SELECTORS = 32;

function liveTextDescriptors(value: object): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new LiveTextError('declaration could not be read safely');
  }
}

function assertLiveTextFields(fields: Array<string | symbol>): void {
  for (const field of fields) {
    if (field !== 'freeze' && field !== 'selectors') {
      throw new LiveTextError('only freeze and selectors are allowed');
    }
  }
}

function readBooleanDataField(descriptors: PropertyDescriptorMap, key: string, message: string): boolean | undefined {
  if (!Reflect.ownKeys(descriptors).includes(key)) return undefined;
  const descriptor = descriptors[key];
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'boolean') {
    throw new LiveTextError(message);
  }
  return descriptor.value;
}

function readLiveTextSelectors(descriptors: PropertyDescriptorMap): string[] {
  if (!Reflect.ownKeys(descriptors).includes('selectors')) return [];
  const descriptor = descriptors.selectors;
  if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) {
    throw new LiveTextError('selectors must be an array of CSS selectors');
  }
  if (descriptor.value.length > MAX_SELECTORS) {
    throw new LiveTextError('selectors must be an array of at most 32 CSS selectors');
  }
  const selectors: string[] = [];
  for (const item of descriptor.value) {
    if (typeof item !== 'string' || !SELECTOR.test(item.trim())) {
      throw new LiveTextError('each selector must be a 1–256 character CSS selector');
    }
    selectors.push(item.trim());
  }
  return selectors;
}

/** Validate and copy a consumer liveText declaration without echoing hostile values. */
export function validateLiveText(value: unknown): LiveTextDeclaration | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return { freeze: false, selectors: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LiveTextError('expected true or an object with optional freeze and selectors');
  }
  const descriptors = liveTextDescriptors(value);
  assertLiveTextFields(Reflect.ownKeys(descriptors));
  return {
    freeze: readBooleanDataField(descriptors, 'freeze', 'freeze must be a boolean') ?? false,
    selectors: readLiveTextSelectors(descriptors),
  };
}

export function requireLiveTextCapture(declaration: LiveTextDeclaration | undefined, captureText: boolean): void {
  if (!declaration) return;
  if (!captureText) {
    throw new LiveTextError(
      declaration.freeze
        ? 'freeze requires captureText: true so drifted ages cannot go unverified'
        : 'requires captureText: true so live/age/clock text can be classified',
    );
  }
}

/**
 * Relative-age and clock tokens. Compact (`102.1d`, `3m`), verbose (`2 minutes ago`),
 * clock faces (`14:32`), and a small closed set of relative words. Reset-safe:
 * each call builds a fresh regex so `lastIndex` cannot leak.
 */
const AGE_TOKEN_SOURCE =
  String.raw`\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|mins?|hrs?|secs?)(?:\s+ago)?` +
  String.raw`|\d+(?:\.\d+)?[smhdwy](?:\s+ago)?` +
  String.raw`|\d{1,2}:\d{2}(?::\d{2})?` +
  String.raw`|just now|yesterday|today|tomorrow`;

function ageTokenRegex(): RegExp {
  return new RegExp(`\\b(?:${AGE_TOKEN_SOURCE})\\b`, 'gi');
}

export function containsAgeClockText(text: string): boolean {
  return ageTokenRegex().test(text);
}

function maskAgeTokens(text: string): string {
  return text.replace(ageTokenRegex(), '\0AGE\0').replace(/\s+/g, ' ').trim();
}

/** True when the only difference between two strings is age/clock tokens. */
export function isAgeOnlyDrift(before: string, after: string): boolean {
  if (before === after) return false;
  if (!containsAgeClockText(before) && !containsAgeClockText(after)) return false;
  return maskAgeTokens(before) === maskAgeTokens(after);
}

export type LiveTextContentChange = {
  kind: 'text' | 'structure';
  path: string;
  cls?: string;
  before?: string;
  after?: string;
};

export function elementMatchesLiveSelector(path: string, cls: string, tag: string, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed.startsWith('.')) {
    const name = trimmed.slice(1).split(/[.#[:\s>+~[]/)[0] ?? '';
    return name.length > 0 && cls.split(/\s+/).includes(name);
  }
  if (/^[A-Za-z][\w-]*$/.test(trimmed)) return tag.toLowerCase() === trimmed.toLowerCase();
  const clsTokens = cls.split(/\s+/).filter(Boolean);
  return path.includes(trimmed) || clsTokens.some((token) => trimmed.includes(token));
}

export function isDeclaredLiveElement(
  path: string,
  cls: string,
  tag: string,
  declaration: LiveTextDeclaration | undefined,
): boolean {
  if (!declaration?.selectors.length) return false;
  return declaration.selectors.some((selector) => elementMatchesLiveSelector(path, cls, tag, selector));
}

/** A text change that is live/age/clock under the declaration or the age-token rule. */
export function isLiveTextChange(
  change: LiveTextContentChange,
  declaration: LiveTextDeclaration | undefined,
  tag = '',
): boolean {
  if (change.kind !== 'text') return false;
  const before = change.before ?? '';
  const after = change.after ?? '';
  if (before === after) return false;
  if (isDeclaredLiveElement(change.path, change.cls ?? '', tag, declaration)) return true;
  return isAgeOnlyDrift(before, after);
}

export type LiveTextFreezeViolation = {
  surface: string;
  path: string;
  before: string;
  after: string;
};

export type LiveTextAudit = {
  declared: boolean;
  freeze: boolean;
  selectors: string[];
  /** Element paths whose text change is live/age/clock. */
  livePaths: string[];
  violations: LiveTextFreezeViolation[];
};

export function emptyLiveTextAudit(): LiveTextAudit {
  return { declared: false, freeze: false, selectors: [], livePaths: [], violations: [] };
}

export function resolveLiveTextDeclaration(
  ...candidates: Array<{ metadata?: { liveText?: unknown } } | undefined>
): LiveTextDeclaration | undefined {
  for (const candidate of candidates) {
    const raw = candidate?.metadata?.liveText;
    if (raw === undefined) continue;
    return validateLiveText(raw);
  }
  return undefined;
}

export function auditLiveTextChanges(
  surface: string,
  changes: LiveTextContentChange[],
  declaration: LiveTextDeclaration | undefined,
  tags: Record<string, string> = {},
): LiveTextAudit {
  const livePaths: string[] = [];
  const violations: LiveTextFreezeViolation[] = [];
  for (const change of changes) {
    if (!isLiveTextChange(change, declaration, tags[change.path] ?? '')) continue;
    livePaths.push(change.path);
    if (declaration?.freeze) {
      violations.push({
        surface,
        path: change.path,
        before: change.before ?? '',
        after: change.after ?? '',
      });
    }
  }
  return {
    declared: declaration !== undefined,
    freeze: declaration?.freeze === true,
    selectors: declaration?.selectors ?? [],
    livePaths,
    violations,
  };
}

export function mergeLiveTextAudits(audits: LiveTextAudit[]): LiveTextAudit {
  if (audits.length === 0) return emptyLiveTextAudit();
  const livePaths = new Set<string>();
  const violations: LiveTextFreezeViolation[] = [];
  let declared = false;
  let freeze = false;
  const selectors = new Set<string>();
  for (const audit of audits) {
    declared = declared || audit.declared;
    freeze = freeze || audit.freeze;
    for (const selector of audit.selectors) selectors.add(selector);
    for (const path of audit.livePaths) livePaths.add(path);
    for (const violation of audit.violations) violations.push(violation);
  }
  return {
    declared,
    freeze,
    selectors: [...selectors],
    livePaths: [...livePaths],
    violations,
  };
}

/** True when `candidate` is `livePath` or an ancestor in StyleProof's `a > b` paths. */
export function isSelfOrAncestorOf(candidate: string, livePath: string): boolean {
  return livePath === candidate || livePath.startsWith(`${candidate} > `);
}

export function isLiveTextGeometryPath(path: string, livePaths: readonly string[]): boolean {
  return livePaths.some((livePath) => isSelfOrAncestorOf(path, livePath));
}

export function liveTextFreezeError(audit: LiveTextAudit): string {
  const sample = audit.violations
    .slice(0, 3)
    .map((item) => `\`${item.before}\` → \`${item.after}\` on ${item.surface}`)
    .join('; ');
  return (
    `styleproof: live/age text drifted after a freeze was declared — captured text is not pinned. ` +
    `Fixture timestamps so ages use the frozen clock, or declare liveText without freeze so ` +
    `age-only drift stays advisory.` +
    (sample ? ` Drift: ${sample}.` : '')
  );
}
