/**
 * Typed deterministic interaction state recipes (issue #391, production contract).
 *
 * StyleProof already captures forced :hover/:focus/:active via CDP and discovers
 * click/select/form variants. This module is the consumer-facing contract for
 * *real* interaction states — hover, focus, press, and click — driven through
 * Playwright with stable keys and the shared destructive-action guard.
 *
 * A recipe **collection** is a set of **independent state variants**, not an
 * ordered action sequence. Each recipe is meant to be applied in isolation from
 * a known baseline (e.g. after navigation/settle); array order never encodes
 * multi-step choreography. `parseStateRecipes` enforces unique stable keys and
 * returns a deterministic key-sorted collection for that reason.
 *
 * First production slice (#391 PR #2):
 *   - closed-world schema + pure validation (including conservative press-key vocabulary)
 *   - hover / focus / press / click drivers
 *   - CSS-only selector privacy policy (value-free structural selectors only)
 *   - press always targets an explicit selector (no ambient keyboard)
 *   - stable key derivation + duplicate detection (public `stateRecipeKey` = validate + internal derive)
 *   - deterministic collection ordering
 *   - destructive-label safety (never apply an unsafe control)
 *   - post-action DOM settle via the same real-clock pattern as crawl
 *   - `stateRecipeGo` adapter assignable to `SurfaceVariant.go`
 *
 * Surface expansion wiring (this package PR #3 / #391 capture slice):
 *   - `Surface.stateRecipes` / crawl `stateRecipes` expand via `parseStateRecipes`
 *   - independent captures `<surface.key>-<stateKey>` after parent `go` + apply
 *   - `CaptureMetadata.variantKind: 'state-recipe'` + report-only provenance
 *
 * Still deferred: automatic discovery, config-file recipe parsing, transient
 * observation windows, live-region promotion, network/route recipes, report
 * state-coverage UI, and bare Escape without a target selector (ambient-unsafe).
 */
import type { Page } from '@playwright/test';
import { DANGER_SOURCE } from './danger.js';
import { realNow } from './spec-clock.js';

/** Interaction actions supported in this contract slice. */
export type InteractionStateRecipeAction = 'hover' | 'focus' | 'press' | 'click';
export type StateRecipeAction = InteractionStateRecipeAction | 'route';

/**
 * Conservative keyboard vocabulary for `press` recipes — disclosure and
 * navigation only. Exact Playwright key names; no modifiers, chords, or free text.
 */
export const ALLOWED_PRESS_KEYS = [
  'Enter',
  'Escape',
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
] as const;

export type AllowedPressKey = (typeof ALLOWED_PRESS_KEYS)[number];

const ALLOWED_PRESS_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_PRESS_KEYS);

/** Closed-world recipe fields — anything else is rejected. */
const ALLOWED_RECIPE_FIELDS = new Set([
  'action',
  'selector',
  'key',
  'label',
  'stateKey',
  'observeSelector',
  'observeMs',
  'urlPattern',
  'status',
]);

/**
 * Max accepted selector length. Keeps provenance/keys bounded and blocks
 * paste-dump / data-URI style selectors without echoing content in errors.
 */
export const MAX_RECIPE_SELECTOR_LENGTH = 256;

/** Declared human labels (provenance / keys) — bounded against log injection. */
export const MAX_RECIPE_LABEL_LENGTH = 160;

/** Explicit stable state-key fragments before slugging. */
export const MAX_RECIPE_STATE_KEY_LENGTH = 80;

/** Bounded continuous-visibility observation window for transient states. */
export const MIN_RECIPE_OBSERVE_MS = 50;
export const MAX_RECIPE_OBSERVE_MS = 5_000;

/**
 * Safe CSS structural / presence-only pseudo-classes (optional simple numeric args).
 * Value-carrying Playwright/CSS functions (`:text`, `:has-text`, `url`, …) are rejected.
 */
const SAFE_PSEUDO_NAMES = new Set([
  'root',
  'empty',
  'focus',
  'focus-visible',
  'focus-within',
  'hover',
  'active',
  'visited',
  'link',
  'target',
  'enabled',
  'disabled',
  'checked',
  'indeterminate',
  'default',
  'optional',
  'required',
  'valid',
  'invalid',
  'user-invalid',
  'read-only',
  'read-write',
  'placeholder-shown',
  'autofill',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'not',
  'is',
  'where',
]);

/**
 * A single deterministic interaction that reaches a UI state.
 *
 * Shape mirrors {@link import('./crawl-surfaces.js').SetupStep}: plain data,
 * no functions, so recipes can live in JSON fixtures and stay serializable.
 *
 * Recipes in a collection are independent variants of state, not steps in a
 * sequence — see {@link parseStateRecipes}.
 */
export type InteractionStateRecipe = {
  action: InteractionStateRecipeAction;
  /** Value-free structural target selector. */
  selector: string;
  key?: AllowedPressKey;
  label?: string;
  stateKey?: string;
  observeSelector?: string;
  observeMs?: number;
  urlPattern?: never;
  status?: never;
};

/** Deterministic network-error setup installed before the parent surface navigates. */
export type RouteStateRecipe = {
  action: 'route';
  stateKey: string;
  /** Value-free Playwright URL glob. Runtime-only: never persisted. */
  urlPattern: string;
  /** Deterministic empty response status. Error outcomes only. */
  status: number;
  label?: string;
  selector?: never;
  key?: never;
  observeSelector?: never;
  observeMs?: never;
};

export type StateRecipe = InteractionStateRecipe | RouteStateRecipe;

/** Provenance returned after a recipe is successfully applied. */
export type AppliedStateRecipe = {
  /** Stable key for map/report identity (`hover-open-menu`, …). */
  stateKey: string;
  action: StateRecipeAction;
  /** Validated interaction selector; absent for route setup recipes. */
  selector?: string;
  key?: AllowedPressKey;
  label?: string;
  /** Bounded transient visibility window proven before settle. */
  observationMs?: number;
  /** Deterministic network error status; URL pattern is never persisted. */
  status?: number;
};

export type StateRecipeSkipReason = 'unsafe-label';

/** A recipe that must not be driven (destructive-action guard). */
export type StateRecipeSkip = {
  reason: StateRecipeSkipReason;
  recipe: StateRecipe;
  label: string;
  detail: string;
};

export class StateRecipeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateRecipeError';
  }
}

const ACTIONS = new Set<string>(['hover', 'focus', 'press', 'click', 'route']);

/** Controls, C0/C1, bidi overrides, ZW* / BOM — never valid in recipe strings. */
const CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex -- intentional control/bidi reject class
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Slug a fragment for stable keys. Returns null when the value collapses to empty
 * (all punctuation / non-ascii) — callers must reject rather than emit collision-prone `state`.
 *
 * One-pass ASCII scan (no regex): lowercases A–Z, maps runs of non-alphanumerics to a
 * single `-`, trims leading/trailing separators, and bounds output to `maxLen`.
 */
// fallow-ignore-next-line complexity
function slugFragment(value: string, maxLen = 48): string | null {
  if (maxLen <= 0) return null;
  let out = '';
  let pendingSep = false;
  for (let i = 0; i < value.length; i++) {
    let c = value.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32; // A-Z → a-z
    const isAlnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (isAlnum) {
      if (pendingSep && out.length > 0) {
        if (out.length >= maxLen) break;
        out += '-';
      }
      pendingSep = false;
      if (out.length >= maxLen) break;
      out += String.fromCharCode(c);
    } else if (out.length > 0) {
      pendingSep = true;
    }
  }
  return out || null;
}

function isAsciiWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isAsciiAlphaNum(c: number): boolean {
  return isAsciiAlpha(c) || isAsciiDigit(c);
}

function isIdentContinue(c: number): boolean {
  return isAsciiAlphaNum(c) || c === 0x5f /* _ */ || c === 0x2d; /* - */
}

/** Fixed-length field-name allowlist (closed-world error formatting only). */
function isSafeFieldName(field: string): boolean {
  if (field.length === 0 || field.length > 40) return false;
  const c0 = field.charCodeAt(0);
  if (!(isAsciiAlpha(c0) || c0 === 0x5f)) return false;
  for (let i = 1; i < field.length; i++) {
    const c = field.charCodeAt(i);
    if (!(isAsciiAlphaNum(c) || c === 0x5f || c === 0x2d)) return false;
  }
  return true;
}

/** `nth-*` args: optional ASCII ws + one or more digits + optional ASCII ws. */
function isNthPseudoArg(args: string): boolean {
  let i = 0;
  const n = args.length;
  while (i < n && isAsciiWs(args.charCodeAt(i))) i++;
  if (i >= n || !isAsciiDigit(args.charCodeAt(i))) return false;
  while (i < n && isAsciiDigit(args.charCodeAt(i))) i++;
  while (i < n && isAsciiWs(args.charCodeAt(i))) i++;
  return i === n;
}

/**
 * `:not` / `:is` / `:where` args: trim non-empty, no `()"'`=` anywhere.
 * Linear character scan (no quantifier backtracking).
 */
function isSimpleSelectorListArg(args: string): boolean {
  let start = 0;
  let end = args.length;
  while (start < end && isAsciiWs(args.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(args.charCodeAt(end - 1))) end--;
  if (start >= end) return false;
  for (let i = 0; i < args.length; i++) {
    const c = args.charCodeAt(i);
    // ( ) " ' ` =
    if (c === 0x28 || c === 0x29 || c === 0x22 || c === 0x27 || c === 0x60 || c === 0x3d) {
      return false;
    }
  }
  return true;
}

/** Collapse consecutive ASCII hyphens in already-slugged key parts (linear). */
function collapseHyphens(value: string, maxLen: number): string {
  let out = '';
  let prevHyphen = false;
  for (let i = 0; i < value.length && out.length < maxLen; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x2d) {
      if (prevHyphen || out.length === 0) continue;
      out += '-';
      prevHyphen = true;
    } else {
      out += value.charAt(i);
      prevHyphen = false;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out;
}

/**
 * `//user@host` credential shape — linear scan after each `//`.
 * Stops the userinfo segment at `/` or ASCII whitespace.
 */
function hasDoubleSlashUserInfo(value: string): boolean {
  let from = 0;
  while (from < value.length) {
    const idx = value.indexOf('//', from);
    if (idx === -1) return false;
    let j = idx + 2;
    let sawAt = false;
    while (j < value.length) {
      const c = value.charCodeAt(j);
      if (c === 0x2f || isAsciiWs(c)) break;
      if (c === 0x40) sawAt = true;
      j++;
    }
    if (sawAt) return true;
    from = idx + 2;
  }
  return false;
}

/**
 * `user:pass@` after start or combinator/ws (`>` `+` `~` `,`).
 * Linear backward segment scan at each `@`.
 */
// fallow-ignore-next-line complexity
function hasUserPassAt(value: string): boolean {
  let from = 0;
  while (from < value.length) {
    const at = value.indexOf('@', from);
    if (at === -1) return false;
    // Walk left over [^/\s>+~,]; require a `:` in that segment before `@`.
    let j = at - 1;
    let sawColon = false;
    while (j >= 0) {
      const c = value.charCodeAt(j);
      if (c === 0x2f || isAsciiWs(c) || c === 0x3e || c === 0x2b || c === 0x7e || c === 0x2c) break;
      if (c === 0x3a) sawColon = true;
      j--;
    }
    const atStartOrSep =
      j < 0 ||
      isAsciiWs(value.charCodeAt(j)) ||
      value.charCodeAt(j) === 0x3e ||
      value.charCodeAt(j) === 0x2b ||
      value.charCodeAt(j) === 0x7e ||
      value.charCodeAt(j) === 0x2c;
    if (sawColon && atStartOrSep) return true;
    from = at + 1;
  }
  return false;
}

/** Lowercase copy for bounded token scans (selectors/labels are length-capped). */
function asciiLowercase(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : value.charAt(i);
  }
  return out;
}

const QUERY_SECRET_KEYS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'api_key',
  'api-key',
  'apikey',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'authorization',
  'auth',
] as const;

const BODY_SECRET_KEYS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'api_key',
  'api-key',
  'apikey',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'authorization',
] as const;

function keyCharBoundary(c: number | undefined): boolean {
  if (c === undefined) return true;
  return !(isAsciiAlphaNum(c) || c === 0x5f || c === 0x2d);
}

/** `?key=` / `&key=` secret query shapes (exact key tokens, linear). */
function hasSecretQueryAssignment(lower: string): boolean {
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    if (c !== 0x3f && c !== 0x26) continue; // ? or &
    for (const key of QUERY_SECRET_KEYS) {
      if (i + 1 + key.length >= lower.length) continue;
      if (!lower.startsWith(key, i + 1)) continue;
      const after = lower.charCodeAt(i + 1 + key.length);
      if (after === 0x3d) return true; // =
    }
  }
  return false;
}

/** `password=` / `token:` style assignments at token boundaries (linear). */
// fallow-ignore-next-line complexity
function hasSecretKeyedAssignment(lower: string): boolean {
  for (const key of BODY_SECRET_KEYS) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(key, from);
      if (idx === -1) break;
      const before = idx === 0 ? undefined : lower.charCodeAt(idx - 1);
      if (!keyCharBoundary(before)) {
        from = idx + key.length;
        continue;
      }
      let j = idx + key.length;
      while (j < lower.length && isAsciiWs(lower.charCodeAt(j))) j++;
      if (j < lower.length) {
        const sep = lower.charCodeAt(j);
        if (sep === 0x3a || sep === 0x3d) return true; // : or =
      }
      from = idx + key.length;
    }
  }
  return false;
}

/**
 * Credential / secret-like shapes in labels and stateKeys (and selector URL checks).
 * Pure indexOf + character scans — no ambiguous quantifiers.
 */
function isCredentialish(value: string): boolean {
  if (hasDoubleSlashUserInfo(value) || hasUserPassAt(value)) return true;
  const lower = asciiLowercase(value);
  return hasSecretQueryAssignment(lower) || hasSecretKeyedAssignment(lower);
}

/** `http:` / `https:` / `file:` / `data:` / `javascript:` at a non-ident boundary. */
function hasUrlScheme(selector: string): boolean {
  const lower = asciiLowercase(selector);
  const schemes = ['https:', 'http:', 'file:', 'data:', 'javascript:'] as const;
  for (const scheme of schemes) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(scheme, from);
      if (idx === -1) break;
      const before = idx === 0 ? undefined : lower.charCodeAt(idx - 1);
      if (before === undefined || !isAsciiAlphaNum(before)) return true;
      from = idx + scheme.length;
    }
  }
  return false;
}

/** `url(` with optional ASCII whitespace before `(` — linear. */
function hasUrlFunction(selector: string): boolean {
  const lower = asciiLowercase(selector);
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf('url', from);
    if (idx === -1) return false;
    const before = idx === 0 ? undefined : lower.charCodeAt(idx - 1);
    if (before !== undefined && isAsciiAlphaNum(before)) {
      from = idx + 3;
      continue;
    }
    let j = idx + 3;
    while (j < lower.length && isAsciiWs(lower.charCodeAt(j))) j++;
    if (j < lower.length && lower.charCodeAt(j) === 0x28) return true;
    from = idx + 3;
  }
  return false;
}

/**
 * Single-pass bracket scan:
 * - presence-only `[name]` / `[aria-expanded]` OK
 * - any `=` inside a bracket block → attribute-equality
 * - nested `[` or unbalanced `]` / unclosed `[` → fail-closed reject
 */
// fallow-ignore-next-line complexity
function scanAttributeBrackets(selector: string): 'ok' | 'equality' | 'malformed' {
  let i = 0;
  const n = selector.length;
  while (i < n) {
    if (selector.charCodeAt(i) !== 0x5b) {
      // stray `]` outside a block
      if (selector.charCodeAt(i) === 0x5d) return 'malformed';
      i++;
      continue;
    }
    // Enter `[` block
    i++;
    let sawEq = false;
    let closed = false;
    while (i < n) {
      const c = selector.charCodeAt(i);
      if (c === 0x5b) return 'malformed'; // nested [
      if (c === 0x5d) {
        closed = true;
        i++;
        break;
      }
      if (c === 0x3d) sawEq = true;
      i++;
    }
    if (!closed) return 'malformed';
    if (sawEq) return 'equality';
  }
  return 'ok';
}

/** Conservative CSS selector character allowlist (linear). */
function isAllowedSelectorChar(c: number): boolean {
  // a-z A-Z 0-9 # . [ ] - _ * > + ~ , \s : ( ) |
  if (isAsciiAlphaNum(c)) return true;
  if (isAsciiWs(c)) return true;
  switch (c) {
    case 0x23: // #
    case 0x2e: // .
    case 0x5b: // [
    case 0x5d: // ]
    case 0x2d: // -
    case 0x5f: // _
    case 0x2a: // *
    case 0x3e: // >
    case 0x2b: // +
    case 0x7e: // ~
    case 0x2c: // ,
    case 0x3a: // :
    case 0x28: // (
    case 0x29: // )
    case 0x7c: // |
      return true;
    default:
      return false;
  }
}

/** Format unknown field names for errors — never echo hostile/secret-bearing keys. */
function formatUnknownFieldName(field: string): string {
  if (isSafeFieldName(field)) return `"${field}"`;
  return '(invalid field name)';
}

/** True when a control label matches the shared destructive-action guard. */
export function isUnsafeStateLabel(label: string): boolean {
  return new RegExp(DANGER_SOURCE, 'i').test(label);
}

function plainObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StateRecipeError(`${what} must be a plain object`);
  }
  return raw as Record<string, unknown>;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new StateRecipeError(`"${field}" must be a non-empty string when provided`);
  }
  return value;
}

/**
 * True when `key` is in the conservative press vocabulary (exact match).
 * Rejects modifiers/chords (`Control+Enter`), free text, and casing variants.
 */
export function isAllowedPressKey(key: string): key is AllowedPressKey {
  return ALLOWED_PRESS_KEY_SET.has(key);
}

function parseAction(raw: Record<string, unknown>): StateRecipeAction {
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) {
    throw new StateRecipeError(
      `state recipe action must be one of ${[...ACTIONS].join(', ')} (got ${JSON.stringify(raw.action)})`,
    );
  }
  return raw.action as StateRecipeAction;
}

/** Closed world: only action, selector, key, label, stateKey. */
function rejectUnknownFields(raw: Record<string, unknown>): void {
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_RECIPE_FIELDS.has(field)) {
      throw new StateRecipeError(
        `state recipe must not include ${formatUnknownFieldName(field)} (allowed fields: action, selector, key, label, stateKey)`,
      );
    }
  }
}

function selectorPolicyReject(detail: string): never {
  throw new StateRecipeError(`state recipe selector rejected by privacy policy (${detail})`);
}

function labelPolicyReject(detail: string): never {
  throw new StateRecipeError(`state recipe label rejected by privacy policy (${detail})`);
}

function stateKeyPolicyReject(detail: string): never {
  throw new StateRecipeError(`state recipe stateKey rejected by privacy policy (${detail})`);
}

function isSafePseudo(name: string, args: string | null): boolean {
  const n = name.toLowerCase();
  if (!SAFE_PSEUDO_NAMES.has(n)) return false;
  if (args === null) {
    return !n.startsWith('nth-') && n !== 'not' && n !== 'is' && n !== 'where';
  }
  if (n.startsWith('nth-')) return isNthPseudoArg(args);
  if (n === 'not' || n === 'is' || n === 'where') return isSimpleSelectorListArg(args);
  // Named pseudos above that take no args must not have args.
  return false;
}

function rejectSelectorShape(selector: string): void {
  if (selector.length > MAX_RECIPE_SELECTOR_LENGTH) {
    selectorPolicyReject(`exceeds ${MAX_RECIPE_SELECTOR_LENGTH} characters`);
  }
  if (CONTROL_OR_BIDI.test(selector)) {
    selectorPolicyReject('controls, newlines, NUL, or bidi characters are not allowed');
  }
  // Quotes/backticks always carry or delimit values — CSS-only structural policy forbids them.
  if (selector.includes('"') || selector.includes("'") || selector.includes('`')) {
    selectorPolicyReject('quotes and backticks are not allowed in selectors');
  }
  // CSS escapes can smuggle value-like payloads; reject entirely.
  if (selector.includes('\\')) {
    selectorPolicyReject('escape sequences are not allowed in selectors');
  }
  // Playwright locator chaining (`>>` / `internal:…`) is not CSS. A single `>`
  // child combinator remains allowed; includes('>>') catches optional surrounding spaces.
  if (selector.includes('>>')) {
    selectorPolicyReject('Playwright locator chaining is not allowed');
  }
}

function rejectSelectorValueCarriers(selector: string): void {
  // Attribute selectors: presence-only OK; any `=` inside brackets rejected.
  // Nested/unbalanced brackets fail closed.
  const brackets = scanAttributeBrackets(selector);
  if (brackets === 'equality' || brackets === 'malformed') {
    selectorPolicyReject('attribute-equality selectors are not allowed');
  }
  // Playwright engine prefixes and bare name=value (text=secret, xpath=//div, css=button, …)
  // all contain `=`; defend in depth with a plain includes check (no regex).
  if (selector.includes('=')) {
    selectorPolicyReject('engine prefixes and attribute-equality selectors are not allowed');
  }
  // Query strings and credential-bearing URL shapes (#id is CSS — allow bare #).
  if (selector.includes('?')) {
    selectorPolicyReject('query strings are not allowed in selectors');
  }
  if (hasDoubleSlashUserInfo(selector) || hasUserPassAt(selector)) {
    selectorPolicyReject('URL credentials are not allowed in selectors');
  }
  if (hasUrlScheme(selector)) {
    selectorPolicyReject('URL schemes are not allowed in selectors');
  }
  if (hasUrlFunction(selector)) {
    selectorPolicyReject('value-carrying functions are not allowed in selectors');
  }
}

// fallow-ignore-next-line complexity
function rejectUnsafePseudos(selector: string): void {
  // Manual scanner: `:ident` / `:ident(...)` with balanced non-nested parentheses.
  // Nested or unbalanced `()` fail closed. Namespaces/colons stay conservative
  // (only ASCII ident after `:` is considered a pseudo).
  let i = 0;
  const n = selector.length;
  while (i < n) {
    if (selector.charCodeAt(i) !== 0x3a /* : */) {
      i++;
      continue;
    }
    i++; // consume ':'
    if (i >= n || !isAsciiAlpha(selector.charCodeAt(i))) {
      // Not `:ident` (e.g. trailing `:`, `::`, or `:123`) — continue from here.
      continue;
    }
    const nameStart = i;
    i++;
    while (i < n && isIdentContinue(selector.charCodeAt(i))) i++;
    const name = selector.slice(nameStart, i);

    // Optional ASCII ws then `(...)`
    let j = i;
    while (j < n && isAsciiWs(selector.charCodeAt(j))) j++;
    let args: string | null = null;
    if (j < n && selector.charCodeAt(j) === 0x28 /* ( */) {
      j++; // consume '('
      const argStart = j;
      let depth = 1;
      let nested = false;
      while (j < n && depth > 0) {
        const c = selector.charCodeAt(j);
        if (c === 0x28) {
          depth++;
          nested = true;
        } else if (c === 0x29) {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth !== 0 || nested) {
        selectorPolicyReject('value-carrying or unsupported pseudo/functions are not allowed in selectors');
      }
      args = selector.slice(argStart, j);
      j++; // consume ')'
      i = j;
    }

    if (!isSafePseudo(name, args)) {
      selectorPolicyReject('value-carrying or unsupported pseudo/functions are not allowed in selectors');
    }
  }
  // Character allowlist: conservative CSS selector grammar without value carriers.
  for (let k = 0; k < n; k++) {
    if (!isAllowedSelectorChar(selector.charCodeAt(k))) {
      selectorPolicyReject('selector contains characters outside the CSS-only allowlist');
    }
  }
}

/**
 * Conservative CSS-only recipe selector privacy policy:
 * - trim + nonempty, length ≤ {@link MAX_RECIPE_SELECTOR_LENGTH}
 * - no controls / newlines / NUL / bidi / ZW / BOM
 * - no quotes or backticks (block value payloads and engine string forms)
 * - no backslash escapes (no smuggled payloads)
 * - no attribute-equality (`=`, `~=`, `|=`, `^=`, `$=`, `*=`) — presence-only `[attr]` OK
 * - no Playwright engine prefixes (`text=`, `xpath=`, `css=`, `id=`, `role=`, …)
 * - no Playwright locator chaining (`>>` / `button >> …`) — single CSS `>` OK
 * - no value-carrying functions (`:text(...)`, `:has-text(...)`, `url(...)`, …)
 * - structural pseudos only (`:first-child`, `:nth-child(2)`, simple `:not(...)`, …)
 * - no URL query (`?`) or credential forms
 *
 * Allowed: `#id`, `.class`, `button.primary`, `[aria-expanded]`, `input[name]`, `nav > a`,
 * `li:first-child`, `li:nth-child(2)`.
 * Rejected: `input[value=secret]`, `:text("x")`, `text=secret`, `xpath=//a`, `>> secret`,
 * `button >> secret`, quotes, escapes.
 *
 * Errors name the **policy**, never echo the selector (secrets must not appear in messages).
 * Prefer false rejection over privacy leak.
 */
export function assertSafeRecipeSelector(value: unknown): string {
  if (typeof value !== 'string') {
    selectorPolicyReject('must be a non-empty string');
  }
  const selector = value.trim();
  if (!selector) {
    selectorPolicyReject('must be a non-empty string');
  }
  rejectSelectorShape(selector);
  rejectSelectorValueCarriers(selector);
  rejectUnsafePseudos(selector);
  return selector;
}

/**
 * Bound + control-sanitize declared labels. Must produce a non-empty safe slug
 * fragment (emoji / CJK / punctuation-only labels are rejected). Never echo the
 * value in errors.
 */
export function assertSafeRecipeLabel(value: unknown): string {
  if (typeof value !== 'string') {
    labelPolicyReject('must be a non-empty string');
  }
  const label = value.trim();
  if (!label) {
    labelPolicyReject('must be a non-empty string');
  }
  if (label.length > MAX_RECIPE_LABEL_LENGTH) {
    labelPolicyReject(`exceeds ${MAX_RECIPE_LABEL_LENGTH} characters`);
  }
  if (CONTROL_OR_BIDI.test(label)) {
    labelPolicyReject('controls, newlines, NUL, or bidi characters are not allowed');
  }
  if (isCredentialish(label)) {
    labelPolicyReject('credential- or secret-like patterns are not allowed');
  }
  // Pure validation: labels that cannot contribute a stable key fragment fail
  // before browser I/O (classify / go / apply preflight).
  if (!slugFragment(label)) {
    labelPolicyReject('must contain a slug-able alphanumeric fragment');
  }
  return label;
}

/**
 * Bound + control-sanitize explicit stateKey fragments. Must slug to a non-empty
 * stable key (reject all-punctuation/Unicode that would collapse to generic `state`).
 */
export function assertSafeRecipeStateKey(value: unknown): string {
  if (typeof value !== 'string') {
    stateKeyPolicyReject('must be a non-empty string');
  }
  const stateKey = value.trim();
  if (!stateKey) {
    stateKeyPolicyReject('must be a non-empty string');
  }
  if (stateKey.length > MAX_RECIPE_STATE_KEY_LENGTH) {
    stateKeyPolicyReject(`exceeds ${MAX_RECIPE_STATE_KEY_LENGTH} characters`);
  }
  if (CONTROL_OR_BIDI.test(stateKey)) {
    stateKeyPolicyReject('controls, newlines, NUL, or bidi characters are not allowed');
  }
  if (isCredentialish(stateKey)) {
    stateKeyPolicyReject('credential- or secret-like patterns are not allowed');
  }
  if (!slugFragment(stateKey, MAX_RECIPE_STATE_KEY_LENGTH)) {
    stateKeyPolicyReject('must contain a slug-able alphanumeric fragment');
  }
  return stateKey;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return assertSafeRecipeLabel(value);
}

function optionalStateKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return assertSafeRecipeStateKey(value);
}

function requirePressKey(action: StateRecipeAction, key: string | undefined): void {
  if (action !== 'press') {
    if (key !== undefined) {
      throw new StateRecipeError(`state recipe action "${action}" must not include "key" (only press uses key)`);
    }
    return;
  }
  if (!key) {
    throw new StateRecipeError('state recipe action "press" requires a key');
  }
  if (!isAllowedPressKey(key)) {
    throw new StateRecipeError(
      `state recipe press key must be one of ${ALLOWED_PRESS_KEYS.join(', ')} (modifiers, chords, and free-text are not allowed)`,
    );
  }
}

function parseObservation(
  record: Record<string, unknown>,
  stateKey: string | undefined,
): { observeSelector?: string; observeMs?: number } {
  const hasSelector = record.observeSelector !== undefined;
  const hasMs = record.observeMs !== undefined;
  if (hasSelector !== hasMs) {
    throw new StateRecipeError('state recipe observeSelector and observeMs must be provided together');
  }
  if (!hasSelector) return {};
  if (!stateKey) {
    throw new StateRecipeError('state recipe transient observation requires an explicit stateKey');
  }
  const observeSelector = assertSafeRecipeSelector(record.observeSelector);
  const observeMs = record.observeMs;
  if (
    typeof observeMs !== 'number' ||
    !Number.isInteger(observeMs) ||
    observeMs < MIN_RECIPE_OBSERVE_MS ||
    observeMs > MAX_RECIPE_OBSERVE_MS
  ) {
    throw new StateRecipeError(
      `state recipe observeMs must be an integer from ${MIN_RECIPE_OBSERVE_MS} to ${MAX_RECIPE_OBSERVE_MS} milliseconds`,
    );
  }
  return { observeSelector, observeMs };
}

function routePatternPolicyReject(detail: string): never {
  throw new StateRecipeError(`state recipe URL pattern rejected by privacy policy (${detail})`);
}

function assertSafeRoutePattern(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RECIPE_SELECTOR_LENGTH) {
    routePatternPolicyReject(`must be 1-${MAX_RECIPE_SELECTOR_LENGTH} characters`);
  }
  let hasSlash = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const char = raw[i]!;
    if (char === '/') hasSlash = true;
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!alnum && !'_-.*/:'.includes(char)) routePatternPolicyReject('must be a value-free URL glob');
  }
  if (!hasSlash || CONTROL_OR_BIDI.test(raw)) routePatternPolicyReject('must be a value-free URL glob');
  return raw;
}

function validateRouteRecipe(record: Record<string, unknown>): RouteStateRecipe {
  if (
    record.selector !== undefined ||
    record.key !== undefined ||
    record.observeSelector !== undefined ||
    record.observeMs !== undefined
  ) {
    throw new StateRecipeError('state recipe route must not include interaction fields');
  }
  const stateKey = optionalStateKey(record.stateKey);
  if (!stateKey) throw new StateRecipeError('state recipe route requires an explicit stateKey');
  const label = optionalLabel(record.label);
  const urlPattern = assertSafeRoutePattern(record.urlPattern);
  const status = record.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    throw new StateRecipeError('state recipe route status must be an integer from 400 to 599');
  }
  return { action: 'route', stateKey, urlPattern, status, ...(label !== undefined ? { label } : {}) };
}

function validateInteractionRecipe(
  record: Record<string, unknown>,
  action: InteractionStateRecipeAction,
): InteractionStateRecipe {
  if (record.urlPattern !== undefined || record.status !== undefined) {
    throw new StateRecipeError('state recipe interaction recipe must not include route fields');
  }
  const selector = assertSafeRecipeSelector(record.selector);
  const keyRaw = optionalNonEmptyString(record.key, 'key');
  requirePressKey(action, keyRaw);
  const key = keyRaw !== undefined && isAllowedPressKey(keyRaw) ? keyRaw : undefined;
  const stateKey = optionalStateKey(record.stateKey);
  const label = optionalLabel(record.label);
  const observation = parseObservation(record, stateKey);
  return {
    action,
    selector,
    ...(key ? { key } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(stateKey ? { stateKey } : {}),
    ...observation,
  };
}

/**
 * Pure shape validation. Does **not** apply the destructive guard — use
 * {@link classifyStateRecipe} / {@link applyStateRecipe} for that so discovery
 * lists can still carry skipped unsafe candidates.
 */
export function validateStateRecipe(raw: unknown): StateRecipe {
  const record = plainObject(raw, 'state recipe');
  const action = parseAction(record);
  rejectUnknownFields(record);
  return action === 'route'
    ? validateRouteRecipe(record)
    : validateInteractionRecipe(record, action as InteractionStateRecipeAction);
}

/**
 * Internal stable-key derivation for an already-validated {@link StateRecipe}.
 * No re-validation and no recursion into {@link stateRecipeKey} /
 * {@link validateStateRecipe} — callers that already hold a validated recipe
 * (e.g. {@link parseStateRecipes}) use this to avoid double work and drift.
 */
function requireSlugFragment(value: string, reject: (detail: string) => never, maxLen = 48): string {
  const s = slugFragment(value, maxLen);
  if (!s) reject('must contain a slug-able alphanumeric fragment');
  return s;
}

function deriveValidatedStateRecipeKey(recipe: StateRecipe): string {
  if (recipe.action === 'route') {
    return requireSlugFragment(recipe.stateKey, stateKeyPolicyReject, MAX_RECIPE_STATE_KEY_LENGTH).slice(0, 80);
  }
  if (recipe.stateKey !== undefined) {
    return requireSlugFragment(recipe.stateKey, stateKeyPolicyReject, MAX_RECIPE_STATE_KEY_LENGTH).slice(0, 80);
  }
  const parts: string[] = [recipe.action];
  if (recipe.label) {
    parts.push(requireSlugFragment(recipe.label, labelPolicyReject));
  } else {
    parts.push(requireSlugFragment(recipe.selector, selectorPolicyReject));
  }
  if (recipe.action === 'press' && recipe.key !== undefined) {
    // Validated recipes already constrain key; keep a hard guard for internal safety.
    if (!isAllowedPressKey(recipe.key)) {
      throw new StateRecipeError(
        `state recipe press key must be one of ${ALLOWED_PRESS_KEYS.join(', ')} (modifiers, chords, and free-text are not allowed)`,
      );
    }
    parts.push(slugFragment(recipe.key) ?? 'key');
  }
  return collapseHyphens(parts.join('-'), 80);
}

/**
 * Validate a collection of **independent state variants** (not an ordered
 * action sequence). Each recipe is a standalone path to a UI state from a
 * known baseline; collection order is not choreography.
 *
 * - Validates every entry via {@link validateStateRecipe}
 * - Rejects duplicate derived stable keys (internal derive after one validate)
 * - Returns recipes sorted by stable key for deterministic collection ordering
 */
export function parseStateRecipes(raw: unknown): StateRecipe[] {
  if (!Array.isArray(raw)) throw new StateRecipeError('state recipes must be a JSON array');
  const recipes = raw.map((item, i) => {
    try {
      return validateStateRecipe(item);
    } catch (e) {
      if (e instanceof StateRecipeError) {
        throw new StateRecipeError(`state recipe[${i}]: ${e.message}`);
      }
      throw e;
    }
  });

  const seen = new Map<string, number>();
  for (let i = 0; i < recipes.length; i++) {
    const derived = deriveValidatedStateRecipeKey(recipes[i]!);
    const prev = seen.get(derived);
    if (prev !== undefined) {
      throw new StateRecipeError(
        `duplicate state recipe key "${derived}" (recipes[${prev}] and recipes[${i}]); state recipes are independent variants, not a sequence`,
      );
    }
    seen.set(derived, i);
  }

  // Deterministic collection order by stable key (input order is not semantic).
  return [...recipes].sort((a, b) => {
    const ka = deriveValidatedStateRecipeKey(a);
    const kb = deriveValidatedStateRecipeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Stable identity for a recipe. Explicit `stateKey` wins; otherwise
 * `action[-declared-label|-selector][-press-key]`. Deterministic across runs
 * and independent of live DOM labels.
 *
 * **Entry validation (public API):** runs full {@link validateStateRecipe}
 * (closed world, selector/label/stateKey privacy, press-key rules) then derives
 * via the shared internal helper. Direct JS/cast calls with secret-bearing
 * selectors, unknown fields, or invalid keys throw policy-only errors (no
 * secret in message/stack) and never return a secret-bearing key. Fragments
 * that slug to empty are rejected rather than collapsing to a generic `state`
 * collision key.
 *
 * Accepts `unknown` at runtime; TypeScript callers may still pass a
 * {@link StateRecipe}.
 */
export function stateRecipeKey(recipe: StateRecipe | unknown): string {
  return deriveValidatedStateRecipeKey(validateStateRecipe(recipe));
}

/**
 * Classify safety without driving the page. Unsafe labels become named skips
 * so discovery can report them instead of silently dropping them.
 */
export function classifyStateRecipe(
  raw: unknown,
): { ok: true; recipe: StateRecipe } | { ok: false; skip: StateRecipeSkip } {
  const recipe = validateStateRecipe(raw);
  const declaredSafetyLabel = recipe.label ?? recipe.stateKey;
  if (declaredSafetyLabel !== undefined && isUnsafeStateLabel(declaredSafetyLabel)) {
    return {
      ok: false,
      skip: {
        reason: 'unsafe-label',
        recipe,
        label: declaredSafetyLabel,
        detail: 'label matched the built-in destructive-action guard',
      },
    };
  }
  return { ok: true, recipe };
}

/** Read the same label shape the variant/surface crawlers use (incl. title). */
async function readElementLabel(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (el) => {
        const own = (
          el.getAttribute('aria-label') ||
          el.getAttribute('name') ||
          el.textContent ||
          el.getAttribute('title') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        return own || el.tagName.toLowerCase();
      },
      undefined,
      { timeout: 5_000 },
    );
}

/** Element count for settle polls (kept out of line-level clone with crawl). */
async function bodyElementCount(page: Page): Promise<number> {
  return page.evaluate(() => document.body.getElementsByTagName('*').length);
}

/**
 * Cheap post-interaction settle: poll until the DOM element count is stable.
 * Uses {@link realNow} so a frozen spec clock cannot hang the deadline.
 * Equivalent real-clock DOM settle implementation to crawl (not a shared import).
 */
async function settleAfterRecipe(page: Page, maxMs = 1200): Promise<void> {
  const deadline = realNow() + maxMs;
  let previous = await bodyElementCount(page);
  while (realNow() < deadline) {
    await page.waitForTimeout(90);
    const next = await bodyElementCount(page);
    if (next === previous) return;
    previous = next;
  }
}

/** Provenance only — stable key always comes from declared recipe fields. */
function applied(recipe: StateRecipe, label?: string): AppliedStateRecipe {
  const resolvedLabel = label ?? recipe.label;
  return {
    stateKey: deriveValidatedStateRecipeKey(recipe),
    action: recipe.action,
    ...(recipe.action === 'route' ? { status: recipe.status } : { selector: recipe.selector }),
    ...(recipe.key ? { key: recipe.key } : {}),
    ...(resolvedLabel !== undefined ? { label: resolvedLabel } : {}),
    ...(recipe.observeMs !== undefined ? { observationMs: recipe.observeMs } : {}),
  };
}

const RECIPE_OBSERVE_APPEAR_TIMEOUT_MS = 1_000;

function observationFailure(recipe: StateRecipe, phase: 'appearance' | 'continuous-visibility'): StateRecipeError {
  return new StateRecipeError(
    `state recipe ${deriveValidatedStateRecipeKey(recipe)} observation phase ${phase} failed`,
  );
}

async function observeTransientState(page: Page, recipe: StateRecipe): Promise<void> {
  if (recipe.observeSelector === undefined || recipe.observeMs === undefined) return;
  const observed = page.locator(recipe.observeSelector).first();
  try {
    await observed.waitFor({ state: 'visible', timeout: RECIPE_OBSERVE_APPEAR_TIMEOUT_MS });
  } catch {
    throw observationFailure(recipe, 'appearance');
  }
  const deadline = realNow() + recipe.observeMs;
  while (realNow() < deadline) {
    await page.waitForTimeout(Math.min(25, Math.max(1, deadline - realNow())));
    if (!(await observed.isVisible())) throw observationFailure(recipe, 'continuous-visibility');
  }
}

/**
 * Drive a validated interaction recipe on a live page.
 *
 * - Shape errors and unsupported fields → {@link StateRecipeError}
 * - Declared or live label matching {@link DANGER_SOURCE} → {@link StateRecipeError}
 *   (use {@link classifyStateRecipe} first when you want a soft skip instead)
 * - Never runs arbitrary script/eval
 * - `press` always focuses the explicit selector first (no ambient keyboard)
 */
async function executeStateRecipe(page: Page, recipe: StateRecipe): Promise<void> {
  if (recipe.action === 'route') {
    await page.route(
      recipe.urlPattern,
      async (route) => {
        await route.fulfill({ status: recipe.status, body: '', contentType: 'text/plain' });
      },
      { times: 1 },
    );
    return;
  }
  const target = page.locator(recipe.selector).first();
  if (recipe.action === 'hover') {
    await target.hover({ timeout: 5_000 });
  } else if (recipe.action === 'focus') {
    await target.focus({ timeout: 5_000 });
  } else if (recipe.action === 'click') {
    await target.click({ timeout: 5_000 });
  } else {
    // press: require focused target — never page.keyboard against ambient focus
    await target.focus({ timeout: 5_000 });
    await page.keyboard.press(recipe.key!);
  }
}

export async function applyStateRecipe(page: Page, raw: unknown): Promise<AppliedStateRecipe> {
  const classified = classifyStateRecipe(raw);
  if (!classified.ok) {
    throw new StateRecipeError(`refusing unsafe state recipe (${classified.skip.label}): ${classified.skip.detail}`);
  }
  const recipe = classified.recipe;
  const fail = () =>
    new StateRecipeError(`state recipe failed (${recipe.action} key=${deriveValidatedStateRecipeKey(recipe)})`);

  if (recipe.action === 'route') {
    try {
      await executeStateRecipe(page, recipe);
      return applied(recipe);
    } catch {
      throw fail();
    }
  }

  let liveLabel: string | undefined;
  try {
    liveLabel = await readElementLabel(page, recipe.selector);
    if (liveLabel && isUnsafeStateLabel(liveLabel)) {
      throw new StateRecipeError(
        `refusing unsafe state recipe target (${liveLabel}): label matched the built-in destructive-action guard`,
      );
    }
    await executeStateRecipe(page, recipe);
    await observeTransientState(page, recipe);
    await settleAfterRecipe(page);
  } catch (e) {
    if (e instanceof StateRecipeError) throw e;
    // Privacy: name action + stable key only. Do not echo selector or nested
    // Playwright locator text (which re-embeds the selector).
    throw fail();
  }

  // Declared label wins for provenance display; live label only fills gaps.
  // Stable keys never depend on live DOM labels (see {@link stateRecipeKey}).
  return applied(recipe, recipe.label ?? liveLabel);
}

/**
 * Build a driver assignable to {@link import('./runner.js').SurfaceVariant.go}
 * (and similarly shaped slots that take `(page) => Promise<void>`).
 * Applies the recipe and discards provenance — use {@link applyStateRecipe}
 * when you need the returned {@link AppliedStateRecipe}.
 */
export function stateRecipeGo(raw: unknown): (page: Page) => Promise<void> {
  const recipe = validateStateRecipe(raw);
  return async (page: Page) => {
    await applyStateRecipe(page, recipe);
  };
}
