// Live/age/clock text: relative ages and clocks that ignore the clock freeze still drift
// in captured text. A `liveText` declaration makes that drift advisory, or fail-closed
// when `freeze` is set. The certification differ stays exact; this only classifies.

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
  /** CSS selectors whose own text is live/age/clock data. */
  selectors: string[];
};

export type LiveTextInput = boolean | { freeze?: boolean; selectors?: string[] };

const SELECTOR = /^[A-Za-z0-9_.:#[\]="'*\s>+~-]{1,256}$/;
const MAX_SELECTORS = 32;

function readLiveTextSelectors(descriptors: PropertyDescriptorMap): string[] {
  if (!Reflect.ownKeys(descriptors).includes('selectors')) return [];
  const descriptor = descriptors.selectors;
  if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) {
    throw new LiveTextError('selectors must be an array of CSS selectors');
  }
  if (descriptor.value.length > MAX_SELECTORS) {
    throw new LiveTextError('selectors must be an array of at most 32 CSS selectors');
  }
  return descriptor.value.map((item: unknown) => {
    if (typeof item !== 'string' || !SELECTOR.test(item.trim())) {
      throw new LiveTextError('each selector must be a 1–256 character CSS selector');
    }
    return item.trim();
  });
}

/** Validate and copy a consumer liveText declaration without echoing hostile values. */
export function validateLiveText(value: unknown): LiveTextDeclaration | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return { freeze: false, selectors: [] };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LiveTextError('expected true or an object with optional freeze and selectors');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new LiveTextError('declaration could not be read safely');
  }
  for (const field of Reflect.ownKeys(descriptors)) {
    if (field !== 'freeze' && field !== 'selectors') throw new LiveTextError('only freeze and selectors are allowed');
  }
  const freeze = descriptors.freeze;
  if (freeze && (!('value' in freeze) || typeof freeze.value !== 'boolean')) {
    throw new LiveTextError('freeze must be a boolean');
  }
  return { freeze: freeze?.value ?? false, selectors: readLiveTextSelectors(descriptors) };
}

export function requireLiveTextCapture(declaration: LiveTextDeclaration | undefined, captureText: boolean): void {
  if (!declaration || captureText) return;
  throw new LiveTextError(
    declaration.freeze
      ? 'freeze requires captureText: true so drifted ages cannot go unverified'
      : 'requires captureText: true so live/age/clock text can be classified',
  );
}

// Relative-age and clock tokens: compact (`102.1d`), verbose (`2 minutes ago`), clock faces
// (`14:32`), and a small closed set of relative words. A fresh regex per call (no lastIndex leak).
const AGE_TOKEN_SOURCE =
  String.raw`\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|mins?|hrs?|secs?)(?:\s+ago)?` +
  String.raw`|\d+(?:\.\d+)?[smhdwy](?:\s+ago)?` +
  String.raw`|\d{1,2}:\d{2}(?::\d{2})?` +
  String.raw`|just now|yesterday|today|tomorrow`;

const ageTokenRegex = (): RegExp => new RegExp(`\\b(?:${AGE_TOKEN_SOURCE})\\b`, 'gi');

export function containsAgeClockText(text: string): boolean {
  return ageTokenRegex().test(text);
}

const maskAgeTokens = (text: string): string => text.replace(ageTokenRegex(), '\0AGE\0').replace(/\s+/g, ' ').trim();

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

function elementMatchesLiveSelector(path: string, cls: string, tag: string, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed.startsWith('.')) {
    const name = trimmed.slice(1).split(/[.#[:\s>+~[]/)[0] ?? '';
    return name.length > 0 && cls.split(/\s+/).includes(name);
  }
  if (/^[A-Za-z][\w-]*$/.test(trimmed)) return tag.toLowerCase() === trimmed.toLowerCase();
  const clsTokens = cls.split(/\s+/).filter(Boolean);
  return path.includes(trimmed) || clsTokens.some((token) => trimmed.includes(token));
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
  const declared = declaration?.selectors.some((selector) =>
    elementMatchesLiveSelector(change.path, change.cls ?? '', tag, selector),
  );
  return declared || isAgeOnlyDrift(before, after);
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
  const raw = candidates.find((candidate) => candidate?.metadata?.liveText !== undefined)?.metadata?.liveText;
  return raw === undefined ? undefined : validateLiveText(raw);
}

export function auditLiveTextChanges(
  surface: string,
  changes: LiveTextContentChange[],
  declaration: LiveTextDeclaration | undefined,
  tags: Record<string, string> = {},
): LiveTextAudit {
  const live = changes.filter((change) => isLiveTextChange(change, declaration, tags[change.path] ?? ''));
  return {
    declared: declaration !== undefined,
    freeze: declaration?.freeze === true,
    selectors: declaration?.selectors ?? [],
    livePaths: live.map((change) => change.path),
    violations: declaration?.freeze
      ? live.map((change) => ({ surface, path: change.path, before: change.before ?? '', after: change.after ?? '' }))
      : [],
  };
}

export function mergeLiveTextAudits(audits: LiveTextAudit[]): LiveTextAudit {
  if (audits.length === 0) return emptyLiveTextAudit();
  return {
    declared: audits.some((audit) => audit.declared),
    freeze: audits.some((audit) => audit.freeze),
    selectors: [...new Set(audits.flatMap((audit) => audit.selectors))],
    livePaths: [...new Set(audits.flatMap((audit) => audit.livePaths))],
    violations: audits.flatMap((audit) => audit.violations),
  };
}

/** True when `path` is a live path or an ancestor of one in StyleProof's `a > b` paths. */
export function isLiveTextGeometryPath(path: string, livePaths: readonly string[]): boolean {
  return livePaths.some((livePath) => livePath === path || livePath.startsWith(`${path} > `));
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
