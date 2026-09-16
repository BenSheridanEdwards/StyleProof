/**
 * Typed deterministic interaction state recipes: hover / focus / press / click drivers
 * and one-shot 400-599 route errors, with stable keys and the destructive-action guard.
 * A recipe collection is a set of INDEPENDENT state variants, never an action sequence.
 */
import type { Locator, Page } from '@playwright/test';
import { DANGER_SOURCE } from './danger.js';
import { realNow } from './spec-clock.js';
import {
  assertSafeRecipeLabel,
  assertSafeRecipeSelector,
  assertSafeRecipeStateKey,
  assertSafeRoutePattern,
  collapseHyphens,
  formatUnknownFieldName,
  MAX_RECIPE_STATE_KEY_LENGTH,
  policyReject,
  slugFragment,
  StateRecipeError,
} from './capture/recipe-policy.js';

export {
  assertSafeRecipeLabel,
  assertSafeRecipeSelector,
  assertSafeRecipeStateKey,
  MAX_RECIPE_LABEL_LENGTH,
  MAX_RECIPE_SELECTOR_LENGTH,
  MAX_RECIPE_STATE_KEY_LENGTH,
  StateRecipeError,
} from './capture/recipe-policy.js';

export type InteractionStateRecipeAction = 'hover' | 'focus' | 'press' | 'click';
export type StateRecipeAction = InteractionStateRecipeAction | 'route';

/** Conservative keyboard vocabulary for `press` recipes — exact Playwright key names, no modifiers or chords. */
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
const ACTIONS = new Set<string>(['hover', 'focus', 'press', 'click', 'route']);
/** Bounded continuous-visibility observation window for transient states. */
const MIN_RECIPE_OBSERVE_MS = 50;
const MAX_RECIPE_OBSERVE_MS = 5_000;
const RECIPE_OBSERVE_APPEAR_TIMEOUT_MS = 1_000;
const ACTION_TIMEOUT_MS = 5_000;

/** A single deterministic interaction that reaches a UI state. Plain data, JSON-safe. */
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
  /** Deterministic empty response status (400–599). */
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
  stateKey: string;
  action: StateRecipeAction;
  selector?: string;
  key?: AllowedPressKey;
  label?: string;
  observationMs?: number;
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

/** True when a control label matches the shared destructive-action guard. */
export function isUnsafeStateLabel(label: string): boolean {
  return new RegExp(DANGER_SOURCE, 'i').test(label);
}

/** True when `key` is in the conservative press vocabulary (exact match). */
export function isAllowedPressKey(key: string): key is AllowedPressKey {
  return ALLOWED_PRESS_KEY_SET.has(key);
}

const PRESS_KEY_ERROR = `state recipe press key must be one of ${ALLOWED_PRESS_KEYS.join(', ')} (modifiers, chords, and free-text are not allowed)`;

function parseAction(raw: Record<string, unknown>): StateRecipeAction {
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) {
    throw new StateRecipeError(
      `state recipe action must be one of ${[...ACTIONS].join(', ')} (got ${JSON.stringify(raw.action)})`,
    );
  }
  return raw.action as StateRecipeAction;
}

function rejectUnknownFields(raw: Record<string, unknown>): void {
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_RECIPE_FIELDS.has(field)) {
      throw new StateRecipeError(
        `state recipe must not include ${formatUnknownFieldName(field)} (allowed fields: action, selector, key, label, stateKey)`,
      );
    }
  }
}

const optionalLabel = (value: unknown): string | undefined =>
  value === undefined ? undefined : assertSafeRecipeLabel(value);
const optionalStateKey = (value: unknown): string | undefined =>
  value === undefined ? undefined : assertSafeRecipeStateKey(value);

function parsePressKey(action: StateRecipeAction, key: unknown): AllowedPressKey | undefined {
  if (key !== undefined && (typeof key !== 'string' || !key)) {
    throw new StateRecipeError('"key" must be a non-empty string when provided');
  }
  if (action !== 'press') {
    if (key !== undefined) {
      throw new StateRecipeError(`state recipe action "${action}" must not include "key" (only press uses key)`);
    }
    return undefined;
  }
  if (!key) throw new StateRecipeError('state recipe action "press" requires a key');
  if (!isAllowedPressKey(key as string)) throw new StateRecipeError(PRESS_KEY_ERROR);
  return key as AllowedPressKey;
}

function parseObservation(
  record: Record<string, unknown>,
  stateKey: string | undefined,
): { observeSelector?: string; observeMs?: number } {
  const hasSelector = record.observeSelector !== undefined;
  if (hasSelector !== (record.observeMs !== undefined)) {
    throw new StateRecipeError('state recipe observeSelector and observeMs must be provided together');
  }
  if (!hasSelector) return {};
  if (!stateKey) throw new StateRecipeError('state recipe transient observation requires an explicit stateKey');
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

function validateRouteRecipe(record: Record<string, unknown>): RouteStateRecipe {
  if (['selector', 'key', 'observeSelector', 'observeMs'].some((field) => record[field] !== undefined)) {
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
  const key = parsePressKey(action, record.key);
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

/** Pure shape validation; the destructive guard is applied by `classifyStateRecipe` / `applyStateRecipe`. */
export function validateStateRecipe(raw: unknown): StateRecipe {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StateRecipeError('state recipe must be a plain object');
  }
  const record = raw as Record<string, unknown>;
  const action = parseAction(record);
  rejectUnknownFields(record);
  return action === 'route' ? validateRouteRecipe(record) : validateInteractionRecipe(record, action);
}

function requireSlugFragment(value: string, field: 'selector' | 'label' | 'stateKey', maxLen = 48): string {
  const s = slugFragment(value, maxLen);
  if (!s) policyReject(field, 'must contain a slug-able alphanumeric fragment');
  return s;
}

/** Stable key for an already-validated recipe: explicit `stateKey`, else `action[-label|-selector][-key]`. */
function deriveValidatedStateRecipeKey(recipe: StateRecipe): string {
  if (recipe.stateKey !== undefined) {
    return requireSlugFragment(recipe.stateKey, 'stateKey', MAX_RECIPE_STATE_KEY_LENGTH).slice(0, 80);
  }
  const parts = [
    recipe.action,
    recipe.label ? requireSlugFragment(recipe.label, 'label') : requireSlugFragment(recipe.selector ?? '', 'selector'),
  ];
  if (recipe.action === 'press' && recipe.key !== undefined) {
    if (!isAllowedPressKey(recipe.key)) throw new StateRecipeError(PRESS_KEY_ERROR);
    parts.push(slugFragment(recipe.key) ?? 'key');
  }
  return collapseHyphens(parts.join('-'), 80);
}

/**
 * Validate a collection of independent state variants: every entry is validated,
 * duplicate derived keys are rejected, and the result is sorted by stable key.
 */
export function parseStateRecipes(raw: unknown): StateRecipe[] {
  if (!Array.isArray(raw)) throw new StateRecipeError('state recipes must be a JSON array');
  const keyed = raw.map((item, i): [string, StateRecipe] => {
    try {
      const recipe = validateStateRecipe(item);
      return [deriveValidatedStateRecipeKey(recipe), recipe];
    } catch (e) {
      if (e instanceof StateRecipeError) throw new StateRecipeError(`state recipe[${i}]: ${e.message}`);
      throw e;
    }
  });
  const seen = new Map<string, number>();
  keyed.forEach(([derived], i) => {
    const prev = seen.get(derived);
    if (prev !== undefined) {
      throw new StateRecipeError(
        `duplicate state recipe key "${derived}" (recipes[${prev}] and recipes[${i}]); state recipes are independent variants, not a sequence`,
      );
    }
    seen.set(derived, i);
  });
  return keyed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, recipe]) => recipe);
}

/**
 * Stable identity for a recipe (public API: validates first, so a hostile input throws
 * a policy-only error and never returns a secret-bearing key).
 */
export function stateRecipeKey(recipe: StateRecipe | unknown): string {
  return deriveValidatedStateRecipeKey(validateStateRecipe(recipe));
}

/** Classify safety without driving the page; unsafe labels become named skips. */
export function classifyStateRecipe(
  raw: unknown,
): { ok: true; recipe: StateRecipe } | { ok: false; skip: StateRecipeSkip } {
  const recipe = validateStateRecipe(raw);
  const label = recipe.label ?? recipe.stateKey;
  if (label !== undefined && isUnsafeStateLabel(label)) {
    return {
      ok: false,
      skip: { reason: 'unsafe-label', recipe, label, detail: 'label matched the built-in destructive-action guard' },
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
      { timeout: ACTION_TIMEOUT_MS },
    );
}

async function bodyElementCount(page: Page): Promise<number> {
  return page.evaluate(() => document.body.getElementsByTagName('*').length);
}

/** Cheap post-interaction settle: poll until the DOM element count is stable (real clock). */
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

/** Provenance only — the stable key always comes from declared recipe fields. */
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

const INTERACTIONS: Record<
  InteractionStateRecipeAction,
  (target: Locator, page: Page, recipe: InteractionStateRecipe) => Promise<void>
> = {
  hover: (target) => target.hover({ timeout: ACTION_TIMEOUT_MS }),
  focus: (target) => target.focus({ timeout: ACTION_TIMEOUT_MS }),
  click: (target) => target.click({ timeout: ACTION_TIMEOUT_MS }),
  // press focuses the explicit target first — never page.keyboard against ambient focus
  press: async (target, page, recipe) => {
    await target.focus({ timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.press(recipe.key!);
  },
};

/** Drive a validated interaction recipe; the live target label is checked against the destructive guard. */
async function driveInteraction(page: Page, recipe: InteractionStateRecipe): Promise<string> {
  const liveLabel = await readElementLabel(page, recipe.selector);
  if (liveLabel && isUnsafeStateLabel(liveLabel)) {
    throw new StateRecipeError(
      `refusing unsafe state recipe target (${liveLabel}): label matched the built-in destructive-action guard`,
    );
  }
  await INTERACTIONS[recipe.action](page.locator(recipe.selector).first(), page, recipe);
  await observeTransientState(page, recipe);
  await settleAfterRecipe(page);
  return liveLabel;
}

/**
 * Apply a recipe on a live page: shape errors, a declared or live label matching the
 * destructive guard, and driver failures all throw `StateRecipeError` naming only the
 * action and stable key (never the selector).
 */
export async function applyStateRecipe(page: Page, raw: unknown): Promise<AppliedStateRecipe> {
  const classified = classifyStateRecipe(raw);
  if (!classified.ok) {
    throw new StateRecipeError(`refusing unsafe state recipe (${classified.skip.label}): ${classified.skip.detail}`);
  }
  const recipe = classified.recipe;
  try {
    if (recipe.action === 'route') {
      const fulfill = { status: recipe.status, body: '', contentType: 'text/plain' };
      await page.route(recipe.urlPattern, (route) => route.fulfill(fulfill), { times: 1 });
      return applied(recipe);
    }
    const liveLabel = await driveInteraction(page, recipe);
    // Declared label wins for provenance display; the live label only fills gaps.
    return applied(recipe, recipe.label ?? liveLabel);
  } catch (e) {
    if (e instanceof StateRecipeError) throw e;
    throw new StateRecipeError(`state recipe failed (${recipe.action} key=${deriveValidatedStateRecipeKey(recipe)})`);
  }
}

/** A driver assignable to `SurfaceVariant.go`; applies the recipe and discards provenance. */
export function stateRecipeGo(raw: unknown): (page: Page) => Promise<void> {
  const recipe = validateStateRecipe(raw);
  return async (page: Page) => {
    await applyStateRecipe(page, recipe);
  };
}
