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
 *   - schema + pure validation (including conservative press-key vocabulary)
 *   - hover / focus / press / click drivers
 *   - stable key derivation + duplicate detection
 *   - deterministic collection ordering
 *   - destructive-label safety (never apply an unsafe control)
 *   - post-action DOM settle via the same real-clock pattern as crawl
 *
 * Deferred (PR #3 / follow-ups): crawler wiring, config parsing, automatic
 * discovery, transient observation windows, live-region promotion, network/route
 * recipes, report rendering, and state-coverage reporting.
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
   * Target selector. Required for `hover`, `focus`, and `click`. Optional for
   * `press` (when set, the target is focused before the key is pressed — e.g.
   * open a focused combobox with ArrowDown).
   */
  selector?: string;
  /**
   * Keyboard key for `press`. Must be one of {@link ALLOWED_PRESS_KEYS}
   * (e.g. `Enter`, `Escape`, `ArrowDown`). Required when `action` is `press`.
   * Modifiers, chords (`Control+k`), and free-text values are rejected.
   */
  key?: AllowedPressKey | string;
  /**
   * Declared human label for stable keys and provenance. When omitted at apply
   * time, the driver may read the live accessible label for the destructive
   * guard and provenance only — live labels never rewrite stable keys.
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
  selector?: string;
  key?: string;
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

/** Fields that imply a later slice or an unsafe capability — rejected loudly. */
const FORBIDDEN_FIELDS = ['script', 'eval', 'route', 'url', 'network', 'dispatchEvent', 'code'] as const;

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

function rejectForbiddenFields(raw: Record<string, unknown>): void {
  for (const field of FORBIDDEN_FIELDS) {
    if (field in raw) {
      throw new StateRecipeError(
        `state recipe must not include "${field}" (unsupported; no arbitrary script/network recipes)`,
      );
    }
  }
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new StateRecipeError('"label" must be a string when provided');
  return value;
}

function requireSelector(action: StateRecipeAction, selector: string | undefined): void {
  if ((action === 'hover' || action === 'focus' || action === 'click') && !selector) {
    throw new StateRecipeError(`state recipe action "${action}" requires a selector`);
  }
}

function requirePressKey(action: StateRecipeAction, key: string | undefined): void {
  if (action !== 'press') return;
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
  rejectForbiddenFields(r);

  const selector = optionalNonEmptyString(r.selector, 'selector');
  const key = optionalNonEmptyString(r.key, 'key');
  const stateKey = optionalNonEmptyString(r.stateKey, 'stateKey');
  const label = optionalLabel(r.label);

  requireSelector(action, selector);
  requirePressKey(action, key);

  return {
    action,
    ...(selector ? { selector } : {}),
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
    .evaluate((el) => {
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
    });
}

/** Element count for settle polls (kept out of line-level clone with crawl). */
async function bodyElementCount(page: Page): Promise<number> {
  return page.evaluate(() => document.body.getElementsByTagName('*').length);
}

/**
 * Cheap post-interaction settle: poll until the DOM element count is stable.
 * Uses {@link realNow} so a frozen spec clock cannot hang the deadline.
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
    ...(recipe.selector ? { selector: recipe.selector } : {}),
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
 */
async function executeStateRecipe(page: Page, recipe: StateRecipe): Promise<void> {
  const target = recipe.selector ? page.locator(recipe.selector).first() : null;
  if (recipe.action === 'hover') {
    await target!.hover({ timeout: 10_000 });
  } else if (recipe.action === 'focus') {
    await target!.focus({ timeout: 10_000 });
  } else if (recipe.action === 'click') {
    await target!.click({ timeout: 10_000 });
  } else {
    if (target) await target.focus({ timeout: 10_000 });
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

  let liveLabel: string | undefined;
  if (recipe.selector) {
    liveLabel = await readElementLabel(page, recipe.selector);
    if (liveLabel && isUnsafeStateLabel(liveLabel)) {
      throw new StateRecipeError(
        `refusing unsafe state recipe target (${liveLabel}): label matched the built-in destructive-action guard`,
      );
    }
  }

  try {
    await executeStateRecipe(page, recipe);
  } catch (e) {
    if (e instanceof StateRecipeError) throw e;
    throw new StateRecipeError(
      `state recipe failed (${recipe.action} ${recipe.selector ?? recipe.key ?? ''}): ${
        e instanceof Error ? e.message : String(e)
      }`,
      { cause: e },
    );
  }

  // Declared label wins for provenance display; live label only fills gaps.
  // Stable keys never depend on live DOM labels (see {@link stateRecipeKey}).
  return applied(recipe, recipe.label ?? liveLabel);
}

/**
 * Build a `SurfaceVariant.go` / setup-style driver from a recipe so consumers
 * can drop typed recipes into existing capture surfaces without hand-rolling
 * Playwright calls.
 */
export function stateRecipeDriver(raw: unknown): (page: Page) => Promise<AppliedStateRecipe> {
  const recipe = validateStateRecipe(raw);
  return (page) => applyStateRecipe(page, recipe);
}
