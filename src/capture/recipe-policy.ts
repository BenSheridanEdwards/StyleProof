// Privacy policy for state-recipe strings: selectors are CSS-only and value-free,
// labels/keys are bounded and credential-free, and errors name the POLICY, never the
// value. Every input is length-capped before the pattern checks run.

import { trimHyphens } from '../util.js';

export class StateRecipeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateRecipeError';
  }
}

/** Max accepted selector length — bounds keys/provenance and blocks paste-dump selectors. */
export const MAX_RECIPE_SELECTOR_LENGTH = 256;
/** Declared human labels — bounded against log injection. */
export const MAX_RECIPE_LABEL_LENGTH = 160;
/** Explicit stable state-key fragments before slugging. */
export const MAX_RECIPE_STATE_KEY_LENGTH = 80;

/** Controls, C0/C1, bidi overrides, ZW* / BOM — never valid in recipe strings. */
export const CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex -- intentional control/bidi reject class
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const WS = String.raw`[\t\n\v\f\r ]`;
const SECRET_KEYS =
  'password|passwd|pwd|token|secret|api_key|api-key|apikey|access_token|access-token|accesstoken|refresh_token|refresh-token|refreshtoken|authorization|auth';
const SECRET_QUERY = new RegExp(`[?&](?:${SECRET_KEYS})=`, 'i');
const SECRET_ASSIGNMENT = new RegExp(`(?:^|[^A-Za-z0-9_-])(?:${SECRET_KEYS})${WS}*[:=]`, 'i');
const DOUBLE_SLASH_USERINFO = new RegExp(String.raw`//[^/\t\n\v\f\r ]*@`);
const USER_PASS_AT = new RegExp(String.raw`(?:^|[\t\n\v\f\r >+~,])[^/\t\n\v\f\r >+~,]*:[^/\t\n\v\f\r >+~,]*@`);
const URL_SCHEME = /(?:^|[^A-Za-z0-9])(?:https:|http:|file:|data:|javascript:)/i;
const URL_FUNCTION = new RegExp(`(?:^|[^A-Za-z0-9])url${WS}*\\(`, 'i');
const SELECTOR_CHARS = new RegExp(String.raw`^[A-Za-z0-9#.\[\]\-_*>+~,:()|\t\n\v\f\r ]*$`);
const NTH_ARG = new RegExp(`^${WS}*[0-9]+${WS}*$`);
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;

/** Structural / presence-only pseudo-classes; the arg-taking ones accept simple numeric or selector-list args. */
const SAFE_PSEUDO_NAMES = new Set(
  'root empty focus focus-visible focus-within hover active visited link target enabled disabled checked indeterminate default optional required valid invalid user-invalid read-only read-write placeholder-shown autofill first-child last-child only-child first-of-type last-of-type only-of-type nth-child nth-last-child nth-of-type nth-last-of-type not is where'.split(
    ' ',
  ),
);

export function policyReject(field: 'selector' | 'label' | 'stateKey' | 'URL pattern', detail: string): never {
  throw new StateRecipeError(`state recipe ${field} rejected by privacy policy (${detail})`);
}

/**
 * Slug a fragment for stable keys: lowercase ASCII alphanumerics, runs of anything
 * else collapsed to one `-`, trimmed, bounded to `maxLen`. Null when nothing survives.
 */
export function slugFragment(value: string, maxLen = 48): string | null {
  if (maxLen <= 0) return null;
  // Non-ASCII is replaced BEFORE lowercasing so only ASCII letters ever survive.
  const out = trimHyphens(trimHyphens(value.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()).slice(0, maxLen));
  return out || null;
}

/** Collapse consecutive hyphens in already-slugged key parts and bound the result. */
export function collapseHyphens(value: string, maxLen: number): string {
  return trimHyphens(trimHyphens(value.replace(/-+/g, '-')).slice(0, maxLen));
}

/** Format unknown field names for errors — never echo hostile/secret-bearing keys. */
export function formatUnknownFieldName(field: string): string {
  return SAFE_FIELD_NAME.test(field) ? `"${field}"` : '(invalid field name)';
}

const isCredentialish = (value: string): boolean =>
  DOUBLE_SLASH_USERINFO.test(value) ||
  USER_PASS_AT.test(value) ||
  SECRET_QUERY.test(value) ||
  SECRET_ASSIGNMENT.test(value);

/** Presence-only `[name]` is fine; `=` inside a block, nesting, or unbalanced brackets fail closed. */
const hasUnsafeAttributeBrackets = (selector: string): boolean => /[[\]]/.test(selector.replace(/\[[^[\]=]*\]/g, ''));

function isSafePseudo(name: string, args: string | null): boolean {
  const n = name.toLowerCase();
  if (!SAFE_PSEUDO_NAMES.has(n)) return false;
  const isNth = n.startsWith('nth-');
  const takesArgs = isNth || n === 'not' || n === 'is' || n === 'where';
  if (args === null || !takesArgs) return args === null && !takesArgs;
  if (isNth) return NTH_ARG.test(args);
  return args.trim().length > 0 && !/[()"'`=]/.test(args);
}

const SELECTOR_SHAPE_RULES: Array<[test: (s: string) => boolean, detail: string]> = [
  [(s) => s.length > MAX_RECIPE_SELECTOR_LENGTH, `exceeds ${MAX_RECIPE_SELECTOR_LENGTH} characters`],
  [(s) => CONTROL_OR_BIDI.test(s), 'controls, newlines, NUL, or bidi characters are not allowed'],
  [(s) => /["'`]/.test(s), 'quotes and backticks are not allowed in selectors'],
  [(s) => s.includes('\\'), 'escape sequences are not allowed in selectors'],
  [(s) => s.includes('>>'), 'Playwright locator chaining is not allowed'],
  [hasUnsafeAttributeBrackets, 'attribute-equality selectors are not allowed'],
  // Engine prefixes (text=, xpath=, css=) all carry `=`; defend in depth.
  [(s) => s.includes('='), 'engine prefixes and attribute-equality selectors are not allowed'],
  [(s) => s.includes('?'), 'query strings are not allowed in selectors'],
  [(s) => DOUBLE_SLASH_USERINFO.test(s) || USER_PASS_AT.test(s), 'URL credentials are not allowed in selectors'],
  [(s) => URL_SCHEME.test(s), 'URL schemes are not allowed in selectors'],
  [(s) => URL_FUNCTION.test(s), 'value-carrying functions are not allowed in selectors'],
];

const PSEUDO_DETAIL = 'value-carrying or unsupported pseudo/functions are not allowed in selectors';

/** Read the balanced, non-nested `(...)` args after a pseudo name; `null` when there are none. */
function readPseudoArgs(selector: string, start: number): { args: string | null; end: number } {
  let j = start;
  while (j < selector.length && /[\t\n\v\f\r ]/.test(selector[j])) j++;
  if (selector[j] !== '(') return { args: null, end: start };
  const close = selector.indexOf(')', j + 1);
  const args = close === -1 ? '' : selector.slice(j + 1, close);
  if (close === -1 || args.includes('(')) policyReject('selector', PSEUDO_DETAIL);
  return { args, end: close + 1 };
}

/** `:ident` / `:ident(...)` scanner: only structural pseudos with simple args survive. */
function rejectUnsafePseudos(selector: string): void {
  const pseudo = /:([A-Za-z][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pseudo.exec(selector))) {
    const { args, end } = readPseudoArgs(selector, match.index + match[0].length);
    if (!isSafePseudo(match[1], args)) policyReject('selector', PSEUDO_DETAIL);
    pseudo.lastIndex = Math.max(end, pseudo.lastIndex);
  }
  if (!SELECTOR_CHARS.test(selector)) {
    policyReject('selector', 'selector contains characters outside the CSS-only allowlist');
  }
}

/**
 * Conservative CSS-only selector policy: bounded, no controls, quotes, escapes, `=`
 * (attribute equality / engine prefixes), `>>` chaining, value-carrying functions,
 * URL query or credential shapes; structural pseudos only. Prefers false rejection.
 */
export function assertSafeRecipeSelector(value: unknown): string {
  const selector = typeof value === 'string' ? value.trim() : '';
  if (!selector) policyReject('selector', 'must be a non-empty string');
  for (const [test, detail] of SELECTOR_SHAPE_RULES) if (test(selector)) policyReject('selector', detail);
  rejectUnsafePseudos(selector);
  return selector;
}

/** Bound + control-sanitize a label or stateKey; it must slug to a non-empty stable fragment. */
function assertSafeFragment(value: unknown, field: 'label' | 'stateKey', maxLen: number, slugMax: number): string {
  const fragment = typeof value === 'string' ? value.trim() : '';
  if (!fragment) policyReject(field, 'must be a non-empty string');
  if (fragment.length > maxLen) policyReject(field, `exceeds ${maxLen} characters`);
  if (CONTROL_OR_BIDI.test(fragment))
    policyReject(field, 'controls, newlines, NUL, or bidi characters are not allowed');
  if (isCredentialish(fragment)) policyReject(field, 'credential- or secret-like patterns are not allowed');
  if (!slugFragment(fragment, slugMax)) policyReject(field, 'must contain a slug-able alphanumeric fragment');
  return fragment;
}

export const assertSafeRecipeLabel = (value: unknown): string =>
  assertSafeFragment(value, 'label', MAX_RECIPE_LABEL_LENGTH, 48);

export const assertSafeRecipeStateKey = (value: unknown): string =>
  assertSafeFragment(value, 'stateKey', MAX_RECIPE_STATE_KEY_LENGTH, MAX_RECIPE_STATE_KEY_LENGTH);

/** A value-free Playwright URL glob: alphanumerics, underscore, hyphen, dot, star, slash, colon; at least one slash. */
export function assertSafeRoutePattern(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RECIPE_SELECTOR_LENGTH) {
    policyReject('URL pattern', `must be 1-${MAX_RECIPE_SELECTOR_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9_\-.*/:]*$/.test(raw) || !raw.includes('/'))
    policyReject('URL pattern', 'must be a value-free URL glob');
  return raw;
}
