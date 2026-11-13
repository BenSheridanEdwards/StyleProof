import { captureKeysIn } from '../capture.js';
import { safeKey, surfaceBase, surfaceWidth } from '../change-groups.js';
import type { ReportReach } from './reach.js';
import { encodeCapturedMeta, type CapturedMeta } from './section-meta.js';
import type { RenderCtx } from './shared.js';

/** "What was captured": what the head captures cover, as hidden data report.html renders. */

const RECIPE_ACTIONS = new Set(['hover', 'focus', 'press', 'click', 'route']);
const MAX_PAGES = 40;
const MAX_RECIPES = 40;
const MAX_RULES = 60;

/** The captured pages: each surface base with its widths and the forced states its maps hold. */
function capturedPages(ctx: RenderCtx, keys: string[]): CapturedMeta['pages'] {
  const pages = new Map<string, { widths: Set<number>; states: Set<string> }>();
  for (const key of keys) {
    const base = safeKey(surfaceBase(key)).slice(0, 120);
    const page = pages.get(base) ?? { widths: new Set(), states: new Set() };
    pages.set(base, page);
    page.widths.add(surfaceWidth(key));
    for (const state of ctx.load(ctx.afterDir, key).stateLayers ?? []) page.states.add(state);
  }
  return [...pages.entries()].slice(0, MAX_PAGES).map(([base, page]) => ({
    base,
    widths: [...page.widths].filter(Boolean).sort((a, b) => a - b),
    states: [...page.states],
  }));
}

/** State-recipe variants on head (hover, press, route…), by surface and state key. */
function capturedRecipes(ctx: RenderCtx, keys: string[]): CapturedMeta['recipes'] {
  const rows = new Map<string, CapturedMeta['recipes'][number]>();
  for (const key of keys) {
    const metadata = ctx.load(ctx.afterDir, key).metadata;
    const recipe = metadata?.stateRecipe;
    if (metadata?.variantKind !== 'state-recipe' || !recipe) continue;
    const row = {
      surface: safeKey(metadata.surfaceKey || surfaceBase(key)).slice(0, 120),
      state: safeKey(recipe.stateKey || metadata.variantKey || key).slice(0, 120),
      action: RECIPE_ACTIONS.has(recipe.action) ? recipe.action : 'unknown',
    };
    rows.set(`${row.surface}\0${row.state}\0${row.action}`, row);
  }
  return [...rows.values()]
    .sort((a, b) => a.surface.localeCompare(b.surface) || a.state.localeCompare(b.state))
    .slice(0, MAX_RECIPES);
}

/** The hidden comment report.html turns into its "What was captured" section. */
export function capturedComment(ctx: RenderCtx, reach: ReportReach | undefined): string {
  const keys = captureKeysIn(ctx.afterDir);
  const sections = ctx.sections?.ruleSections ?? new Map<string, string>();
  return encodeCapturedMeta({
    v: 1,
    pages: capturedPages(ctx, keys),
    recipes: capturedRecipes(ctx, keys),
    rules: (reach?.rules ?? []).slice(0, MAX_RULES).map((rule) => ({
      key: rule.key,
      sheet: rule.sheet ?? '',
      status: rule.status,
      ...(sections.has(rule.key) ? { section: sections.get(rule.key) } : {}),
    })),
  });
}
