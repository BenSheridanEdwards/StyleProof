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
 *   - stable key derivation + duplicate detection (public `stateRecipeKey` re-validates)
 *   - deterministic collection ordering
 *   - destructive-label safety (never apply an unsafe control)
 *   - post-action DOM settle via the same real-clock pattern as crawl
 *   - `stateRecipeGo` adapter assignable to `SurfaceVariant.go`
 *
 * Deferred (PR #3 / follow-ups): crawler wiring, config parsing, automatic
 * discovery, transient observation windows, live-region promotion, network/route
 * recipes, report rendering, and state-coverage reporting. Bare Escape without a
 * target selector is deferred rather than ambient-unsafe.
 */
import type { Page } from '@playwright/test';
import { DANGER_SOURCE } from './danger.js';
import { realNow } from './spec-clock.js';

/** Interaction actions supported in this contract slice. */
export type StateRecipeAction = 'hover' | 'focus' | 'press' | 'click';

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
const ALLOWED_RECIPE_FIELDS = new Set(['action', 'selector', 'key', 'label', 'stateKey']);

/**
 * Max accepted selector length. Keeps provenance/keys bounded and blocks
 * paste-dump / data-URI style selectors without echoing content in errors.
 */
export const MAX_RECIPE_SELECTOR_LENGTH = 256;

/** Declared human labels (provenance / keys) — bounded against log injection. */
export const MAX_RECIPE_LABEL_LENGTH = 160;

/** Explicit stable state-key fragments before slugging. */
export const MAX_RECIPE_STATE_KEY_LENGTH = 80;

/** Unknown closed-world field names: echo only short safe identifiers. */
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;

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

const NTH_PSEUDO_ARG = /^\s*\d+\s*$/;
const SIMPLE_SELECTOR_LIST_ARG = /^\s*[^()"'`=]+\s*$/;

/**
 * A single deterministic interaction that reaches a UI state.
 *
 * Shape mirrors {@link import('./crawl-surfaces.js').SetupStep}: plain data,
 * no functions, so recipes can live in JSON fixtures and stay serializable.
 *
 * Recipes in a collection are independent variants of state, not steps in a
 * sequence — see {@link parseStateRecipes}.
 */
export type StateRecipe = {
  action: StateRecipeAction;
  /**
   * Target selector. Required for every action, including `press` (focus target
   * then key — never ambient keyboard input). Must pass the recipe selector
   * privacy policy (CSS-only value-free structural selectors).
   */
  selector: string;
  /**
   * Keyboard key for `press`. Must be one of {@link ALLOWED_PRESS_KEYS}
   * (e.g. `Enter`, `Escape`, `ArrowDown`). Required when `action` is `press`.
   * Modifiers, chords (`Control+k`), and free-text values are rejected.
   */
  key?: AllowedPressKey;
  /**
   * Declared human label for stable keys and provenance. When omitted at apply
   * time, the driver may read the live accessible label for the destructive
   * guard and provenance only — live labels never rewrite stable keys.
   * Blank/whitespace-only labels are rejected. Bounded and control-sanitized.
   */
  label?: string;
  /**
   * Optional explicit stable state-key fragment. When omitted, derived from
   * action + declared label/selector/key via {@link stateRecipeKey}.
   * Bounded, control-sanitized, and must slug to a non-empty fragment.
   */
  stateKey?: string;
};

/** Provenance returned after a recipe is successfully applied. */
export type AppliedStateRecipe = {
  /** Stable key for map/report identity (`hover-open-menu`, …). */
  stateKey: string;
  action: StateRecipeAction;
  /** Validated value-free CSS selector (never attribute-equality / secret-bearing). */
  selector: string;
  key?: AllowedPressKey;
  label?: string;
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

const ACTIONS = new Set<string>(['hover', 'focus', 'press', 'click']);

/** Controls, C0/C1, bidi overrides, ZW* / BOM — never valid in recipe strings. */
const CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex -- intentional control/bidi reject class
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** URL / credential-ish shapes in declared label/stateKey (no secret echo). */
const CREDENTIALISH =
  /(?:\/\/[^/\s]*@)|(?:^|[\s>+~,])[^/\s]*:[^/\s]*@|(?:[?&](?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth)=)|(?:(?:^|[^A-Za-z0-9_-])(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=])/i;

/**
 * Slug a fragment for stable keys. Returns null when the value collapses to empty
 * (all punctuation / non-ascii) — callers must reject rather than emit collision-prone `state`.
 */
function slugFragment(value: string, maxLen = 48): string | null {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return s || null;
}

/** Format unknown field names for errors — never echo hostile/secret-bearing keys. */
function formatUnknownFieldName(field: string): string {
  if (SAFE_FIELD_NAME.test(field)) return `"${field}"`;
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
  if (n.startsWith('nth-')) return NTH_PSEUDO_ARG.test(args);
  if (n === 'not' || n === 'is' || n === 'where') return SIMPLE_SELECTOR_LIST_ARG.test(args);
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
  if (/["'`]/.test(selector)) {
    selectorPolicyReject('quotes and backticks are not allowed in selectors');
  }
  // CSS escapes can smuggle value-like payloads; reject entirely.
  if (selector.includes('\\')) {
    selectorPolicyReject('escape sequences are not allowed in selectors');
  }
}

function rejectSelectorValueCarriers(selector: string): void {
  // Attribute selectors with a value binding (=, ~=, |=, ^=, $=, *=).
  if (/\[[^\]]*[~|^$*]?=[^\]]*\]/.test(selector)) {
    selectorPolicyReject('attribute-equality selectors are not allowed');
  }
  // Playwright engine prefixes and bare name=value (text=secret, xpath=//div, css=button, …).
  if (/(?:^|[\s,|])[a-zA-Z][\w-]*\s*=/.test(selector) || /^[a-zA-Z][\w-]*\s*=/.test(selector)) {
    selectorPolicyReject('engine prefixes and attribute-equality selectors are not allowed');
  }
  // Defense in depth: any remaining equals (value binding outside brackets).
  if (selector.includes('=')) {
    selectorPolicyReject('attribute-equality selectors are not allowed');
  }
  // Query strings and credential-bearing URL shapes (#id is CSS — allow bare #).
  if (selector.includes('?')) {
    selectorPolicyReject('query strings are not allowed in selectors');
  }
  if (/\/\/[^/\s]*@/.test(selector) || /(?:^|[\s>+~,])[^/\s]*:[^/\s]*@/.test(selector)) {
    selectorPolicyReject('URL credentials are not allowed in selectors');
  }
  if (/\b(?:https?|file|data|javascript):/i.test(selector)) {
    selectorPolicyReject('URL schemes are not allowed in selectors');
  }
  if (/\burl\s*\(/i.test(selector)) {
    selectorPolicyReject('value-carrying functions are not allowed in selectors');
  }
}

function rejectUnsafePseudos(selector: string): void {
  // Single-pass :ident / :ident(...) — avoid bare-name backtracking into nth-* tokens.
  const pseudo = /:([a-zA-Z][\w-]*)(?:\s*\(([^)]*)\))?/g;
  let m: RegExpExecArray | null;
  while ((m = pseudo.exec(selector)) !== null) {
    const args = m[2] !== undefined ? m[2] : null;
    if (!isSafePseudo(m[1]!, args)) {
      selectorPolicyReject('value-carrying or unsupported pseudo/functions are not allowed in selectors');
    }
  }
  // Character allowlist: conservative CSS selector grammar without value carriers.
  if (!/^[a-zA-Z0-9#.[\]\-_*>+~,\s:()|]+$/.test(selector)) {
    selectorPolicyReject('selector contains characters outside the CSS-only allowlist');
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
 * - no value-carrying functions (`:text(...)`, `:has-text(...)`, `url(...)`, …)
 * - structural pseudos only (`:first-child`, `:nth-child(2)`, simple `:not(...)`, …)
 * - no URL query (`?`) or credential forms
 *
 * Allowed: `#id`, `.class`, `button.primary`, `[aria-expanded]`, `input[name]`, `nav > a`,
 * `li:first-child`, `li:nth-child(2)`.
 * Rejected: `input[value=secret]`, `:text("x")`, `text=secret`, `xpath=//a`, quotes, escapes.
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
 * Bound + control-sanitize declared labels. Never echo the value in errors.
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
  if (CREDENTIALISH.test(label)) {
    labelPolicyReject('credential- or secret-like patterns are not allowed');
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
  if (CREDENTIALISH.test(stateKey)) {
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

/**
 * Pure shape validation. Does **not** apply the destructive guard — use
 * {@link classifyStateRecipe} / {@link applyStateRecipe} for that so discovery
 * lists can still carry skipped unsafe candidates.
 */
export function validateStateRecipe(raw: unknown): StateRecipe {
  const r = plainObject(raw, 'state recipe');
  const action = parseAction(r);
  rejectUnknownFields(r);

  const selector = assertSafeRecipeSelector(r.selector);
  const keyRaw = optionalNonEmptyString(r.key, 'key');
  requirePressKey(action, keyRaw);
  const key = keyRaw !== undefined && isAllowedPressKey(keyRaw) ? keyRaw : undefined;
  const stateKey = optionalStateKey(r.stateKey);
  const label = optionalLabel(r.label);

  return {
    action,
    selector,
    ...(key ? { key } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(stateKey ? { stateKey } : {}),
  };
}

/**
 * Validate a collection of **independent state variants** (not an ordered
 * action sequence). Each recipe is a standalone path to a UI state from a
 * known baseline; collection order is not choreography.
 *
 * - Validates every entry via {@link validateStateRecipe}
 * - Rejects duplicate derived stable keys ({@link stateRecipeKey})
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
    const derived = stateRecipeKey(recipes[i]!);
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
    const ka = stateRecipeKey(a);
    const kb = stateRecipeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Stable identity for a recipe. Explicit `stateKey` wins; otherwise
 * `action[-declared-label|-selector][-press-key]`. Deterministic across runs
 * and independent of live DOM labels.
 *
 * **Entry validation (public API):** re-checks selector / label / stateKey with
 * the privacy policy before deriving. Direct JS/cast calls with secret-bearing
 * selectors throw a policy-only error (no secret in message/stack) and never
 * return a secret-bearing key. Fragments that slug to empty are rejected
 * rather than collapsing to a generic `state` collision key.
 */
function requireSlugFragment(value: string, reject: (detail: string) => never, maxLen = 48): string {
  const s = slugFragment(value, maxLen);
  if (!s) reject('must contain a slug-able alphanumeric fragment');
  return s;
}

function derivedStateRecipeKey(
  action: StateRecipeAction,
  selector: string,
  label: string | undefined,
  key?: AllowedPressKey,
): string {
  const parts: string[] = [action];
  if (label) {
    parts.push(requireSlugFragment(label, labelPolicyReject));
  } else {
    parts.push(requireSlugFragment(selector, selectorPolicyReject));
  }
  if (action === 'press' && key !== undefined) {
    if (!isAllowedPressKey(key)) {
      throw new StateRecipeError(
        `state recipe press key must be one of ${ALLOWED_PRESS_KEYS.join(', ')} (modifiers, chords, and free-text are not allowed)`,
      );
    }
    parts.push(slugFragment(key) ?? 'key');
  }
  return parts.join('-').replace(/-+/g, '-').slice(0, 80);
}

export function stateRecipeKey(recipe: StateRecipe): string {
  if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe)) {
    throw new StateRecipeError('state recipe key rejected by privacy policy (must be a plain object)');
  }
  const r = recipe as StateRecipe;
  // Always re-validate at the public boundary — typed StateRecipe is not a trust boundary.
  const selector = assertSafeRecipeSelector(r.selector);
  const label = r.label !== undefined ? assertSafeRecipeLabel(r.label) : undefined;
  const explicit = r.stateKey !== undefined ? assertSafeRecipeStateKey(r.stateKey) : undefined;

  if (explicit) {
    return requireSlugFragment(explicit, stateKeyPolicyReject, MAX_RECIPE_STATE_KEY_LENGTH).slice(0, 80);
  }

  if (typeof r.action !== 'string' || !ACTIONS.has(r.action)) {
    throw new StateRecipeError(
      `state recipe action must be one of ${[...ACTIONS].join(', ')} (got ${typeof r.action === 'string' ? 'invalid action' : typeof r.action})`,
    );
  }
  return derivedStateRecipeKey(r.action as StateRecipeAction, selector, label, r.key);
}

/**
 * Classify safety without driving the page. Unsafe labels become named skips
 * so discovery can report them instead of silently dropping them.
 */
export function classifyStateRecipe(
  raw: unknown,
): { ok: true; recipe: StateRecipe } | { ok: false; skip: StateRecipeSkip } {
  const recipe = validateStateRecipe(raw);
  if (recipe.label !== undefined && isUnsafeStateLabel(recipe.label)) {
    return {
      ok: false,
      skip: {
        reason: 'unsafe-label',
        recipe,
        label: recipe.label,
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
    stateKey: stateRecipeKey(recipe),
    action: recipe.action,
    selector: recipe.selector,
    ...(recipe.key ? { key: recipe.key } : {}),
    ...(resolvedLabel !== undefined ? { label: resolvedLabel } : {}),
  };
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
  await settleAfterRecipe(page);
}

export async function applyStateRecipe(page: Page, raw: unknown): Promise<AppliedStateRecipe> {
  const classified = classifyStateRecipe(raw);
  if (!classified.ok) {
    throw new StateRecipeError(`refusing unsafe state recipe (${classified.skip.label}): ${classified.skip.detail}`);
  }
  const recipe = classified.recipe;
  const fail = () => new StateRecipeError(`state recipe failed (${recipe.action} key=${stateRecipeKey(recipe)})`);

  let liveLabel: string | undefined;
  try {
    liveLabel = await readElementLabel(page, recipe.selector);
    if (liveLabel && isUnsafeStateLabel(liveLabel)) {
      throw new StateRecipeError(
        `refusing unsafe state recipe target (${liveLabel}): label matched the built-in destructive-action guard`,
      );
    }
    await executeStateRecipe(page, recipe);
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
