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
 *   - selector privacy policy (value-free structural selectors only)
 *   - press always targets an explicit selector (no ambient keyboard)
 *   - stable key derivation + duplicate detection
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
   * privacy policy (value-free structural selectors only).
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
   * Blank/whitespace-only labels are rejected.
   */
  label?: string;
  /**
   * Optional explicit stable state-key fragment. When omitted, derived from
   * action + declared label/selector/key via {@link stateRecipeKey}.
   */
  stateKey?: string;
};

/** Provenance returned after a recipe is successfully applied. */
export type AppliedStateRecipe = {
  /** Stable key for map/report identity (`hover-open-menu`, …). */
  stateKey: string;
  action: StateRecipeAction;
  /** Validated value-free selector (never attribute-equality / secret-bearing). */
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

/** Controls, C0/C1, bidi overrides, ZW* / BOM — never valid in a recipe selector. */
const SELECTOR_CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex -- intentional control/bidi reject class
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'state'
  );
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
        `state recipe must not include "${field}" (allowed fields: action, selector, key, label, stateKey)`,
      );
    }
  }
}

/**
 * Recipe selector privacy policy (auth-boundary principle, local copy — no private coupling):
 * - trim + nonempty
 * - length ≤ {@link MAX_RECIPE_SELECTOR_LENGTH}
 * - no controls / newlines / NUL / bidi
 * - no attribute-equality (`=`, `~=`, `|=`, `^=`, `$=`, `*=`) quoted or unquoted — values must not ride selectors
 * - no URL query (`?`) or credential (`user:pass@` / `//…@`) forms
 *
 * Allowed examples: `#id`, `.class`, `button.primary`, `[aria-expanded]`, `input[name]`, `nav > a`.
 * Rejected examples: `input[value=secret]`, `[data-token="…"]`, `a[href="/x?t=1"]`, newline/control, oversized.
 *
 * Errors name the **policy**, never echo the selector (secrets must not appear in messages).
 */
export function assertSafeRecipeSelector(value: unknown): string {
  if (typeof value !== 'string') {
    throw new StateRecipeError('state recipe selector rejected by privacy policy (must be a non-empty string)');
  }
  const selector = value.trim();
  if (!selector) {
    throw new StateRecipeError('state recipe selector rejected by privacy policy (must be a non-empty string)');
  }
  if (selector.length > MAX_RECIPE_SELECTOR_LENGTH) {
    throw new StateRecipeError(
      `state recipe selector rejected by privacy policy (exceeds ${MAX_RECIPE_SELECTOR_LENGTH} characters)`,
    );
  }
  if (SELECTOR_CONTROL_OR_BIDI.test(selector)) {
    throw new StateRecipeError(
      'state recipe selector rejected by privacy policy (controls, newlines, NUL, or bidi characters are not allowed)',
    );
  }
  // Attribute selectors with a value binding (=, ~=, |=, ^=, $=, *=), any quoting style.
  // Same principle as auth-boundary redactedSelector — equality can carry field values.
  if (/\[[^\]]*[~|^$*]?=[^\]]*\]/.test(selector)) {
    throw new StateRecipeError(
      'state recipe selector rejected by privacy policy (attribute-equality selectors are not allowed)',
    );
  }
  // Defense in depth: bare `=…` value patterns outside brackets.
  if (/[=]["'`][^"'`]*["'`]/.test(selector) || /=\s*[^\s"'`\]]+/.test(selector)) {
    throw new StateRecipeError(
      'state recipe selector rejected by privacy policy (attribute-equality selectors are not allowed)',
    );
  }
  // Query strings and credential-bearing URL shapes (fragments use # which is also CSS id — allow #id).
  if (selector.includes('?')) {
    throw new StateRecipeError(
      'state recipe selector rejected by privacy policy (query strings are not allowed in selectors)',
    );
  }
  if (/\/\/[^/\s]*@/.test(selector) || /(?:^|[\s>+~,])[^/\s]*:[^/\s]*@/.test(selector)) {
    throw new StateRecipeError(
      'state recipe selector rejected by privacy policy (URL credentials are not allowed in selectors)',
    );
  }
  return selector;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new StateRecipeError('"label" must be a non-empty string when provided');
  }
  if (!value.trim()) {
    throw new StateRecipeError('"label" must be a non-empty string when provided');
  }
  return value.trim();
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
      `state recipe press key must be one of ${ALLOWED_PRESS_KEYS.join(', ')} (got ${JSON.stringify(key)}; modifiers, chords, and free-text are not allowed)`,
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
  const stateKey = optionalNonEmptyString(r.stateKey, 'stateKey');
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
 * and independent of live DOM labels. Selector is only slugged after privacy
 * validation — never a secret-bearing attribute-equality form.
 */
export function stateRecipeKey(recipe: StateRecipe): string {
  if (recipe.stateKey) return slug(recipe.stateKey);
  const parts: string[] = [recipe.action];
  if (recipe.label?.trim()) {
    parts.push(slug(recipe.label));
  } else if (recipe.selector) {
    parts.push(slug(recipe.selector));
  }
  if (recipe.action === 'press' && recipe.key) {
    parts.push(slug(recipe.key));
  }
  return parts.join('-').replace(/-+/g, '-').slice(0, 80);
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
