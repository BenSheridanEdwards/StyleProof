import { validateProductStateIdentity } from '../capture.js';
import type { CaptureMetadata } from '../capture/types.js';
import {
  applyStateRecipe,
  classifyStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  StateRecipeError,
  type StateRecipe,
} from '../state-recipes.js';
import { assertSafeCaptureKey } from '../surface-keys.js';
import type { ExpandedSurface, Surface, SurfaceVariant } from './types.js';

function mergeIgnore(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = [...new Set(groups.flatMap((g) => g ?? []))];
  return merged.length ? merged : undefined;
}

/** The parent fields every expansion inherits (a variant may override some). */
function inherited(surface: Surface, variant?: SurfaceVariant): Omit<ExpandedSurface, 'key' | 'go'> {
  const v: Partial<SurfaceVariant> = variant ?? {};
  return {
    ignore: variant ? mergeIgnore(surface.ignore, variant.ignore) : surface.ignore,
    widths: v.widths ?? surface.widths,
    height: v.height ?? surface.height,
    popups: surface.popups,
    maxForcedStateElements:
      v.maxForcedStateElements === undefined ? surface.maxForcedStateElements : v.maxForcedStateElements,
    maxForcedStateScanWork:
      v.maxForcedStateScanWork === undefined ? surface.maxForcedStateScanWork : v.maxForcedStateScanWork,
  };
}

function expandOne(
  surface: Surface,
  variant: SurfaceVariant,
  variantKind: CaptureMetadata['variantKind'],
): ExpandedSurface {
  const productState = validateProductStateIdentity(
    variant.productState === undefined ? surface.productState : variant.productState,
  );
  return {
    ...inherited(surface, variant),
    key: `${surface.key}-${variant.key}`,
    go: async (page) => {
      await variant.setup?.(page);
      await surface.go(page);
      await variant.go?.(page);
    },
    metadata: {
      surfaceKey: surface.key,
      variantKey: variant.key,
      variantKind,
      ...(productState ? { productState } : {}),
    },
  };
}

/** Validate + sort recipes and fail closed on declared unsafe labels before any test registers. */
function resolveSurfaceStateRecipes(raw: unknown): StateRecipe[] {
  const recipes = parseStateRecipes(raw);
  for (const recipe of recipes) {
    const classified = classifyStateRecipe(recipe);
    if (!classified.ok) {
      throw new StateRecipeError(`refusing unsafe state recipe (${classified.skip.label}): ${classified.skip.detail}`);
    }
  }
  return recipes;
}

function expandStateRecipe(surface: Surface, recipe: StateRecipe): ExpandedSurface {
  const stateKey = stateRecipeKey(recipe);
  const productState = validateProductStateIdentity(surface.productState);
  const isRoute = recipe.action === 'route';
  return {
    ...inherited(surface),
    key: `${surface.key}-${stateKey}`,
    // Route recipes install their network outcome BEFORE the parent navigates; interaction
    // recipes start from the parent baseline.
    go: async (page) => {
      if (isRoute) {
        await applyStateRecipe(page, recipe);
        // Park the pointer so route-state setup cannot inherit a sticky hover from navigation.
        await page.mouse.move(-1, -1);
      }
      await surface.go(page);
      if (!isRoute) await applyStateRecipe(page, recipe);
    },
    ...(!isRoute && recipe.observeSelector
      ? { requiredVisibleState: { selector: recipe.observeSelector, stateKey } }
      : {}),
    metadata: {
      surfaceKey: surface.key,
      variantKey: stateKey,
      variantKind: 'state-recipe',
      stateRecipe: {
        stateKey,
        action: recipe.action,
        ...(isRoute ? { status: recipe.status } : { selector: recipe.selector }),
        ...(recipe.key ? { key: recipe.key } : {}),
        ...(recipe.observeMs !== undefined ? { observationMs: recipe.observeMs } : {}),
      },
      ...(productState ? { productState } : {}),
    },
  };
}

/** Expand a surface into its captures: base (unless liveStates replace it), variants, live states, recipes. */
export function expandSurfaceVariants(surface: Surface): ExpandedSurface[] {
  const { variants = [], liveStates = [], stateRecipes, productState: rawProductState, ...base } = surface;
  const recipes = stateRecipes === undefined ? [] : resolveSurfaceStateRecipes(stateRecipes);
  const productState = validateProductStateIdentity(rawProductState);
  const baseSurface: ExpandedSurface = {
    ...base,
    metadata: { surfaceKey: surface.key, ...(productState ? { productState } : {}) },
  };
  // liveStates drop the bare base (fuzzy live UI); variants and recipes still expand.
  return [
    ...(liveStates.length ? [] : [baseSurface]),
    ...variants.map((variant) => expandOne(surface, variant, 'variant')),
    ...liveStates.map((state) => expandOne(surface, state, 'live-state')),
    ...recipes.map((recipe) => expandStateRecipe(surface, recipe)),
  ];
}

type ExpandedKeyed = { key: string; metadata?: CaptureMetadata };

function expandedOrigin(s: ExpandedKeyed): string {
  const surfaceKey = s.metadata?.surfaceKey ?? s.key;
  const variantKey = s.metadata?.variantKey;
  if (!variantKey) return `surface '${surfaceKey}'`;
  const kind =
    s.metadata?.variantKind === 'state-recipe' || s.metadata?.variantKind === 'live-state'
      ? s.metadata.variantKind
      : 'variant';
  return `surface '${surfaceKey}' ${kind} '${variantKey}'`;
}

/**
 * Fail LOUDLY on two expanded surfaces sharing a capture key: the `-` join is ambiguous
 * (`a` + `b-c` vs `a-b` + `c`) and the key names the map file, so a collision would
 * silently overwrite a capture. Names both origins without echoing recipe selectors.
 */
export function assertUniqueExpandedKeys(surfaces: ExpandedKeyed[]): void {
  const byKey = new Map<string, ExpandedKeyed>();
  for (const s of surfaces) {
    assertSafeCaptureKey(s.key);
    const prior = byKey.get(s.key);
    if (prior) {
      throw new Error(
        `styleproof: capture key '${s.key}' is produced by two surfaces — ` +
          `${expandedOrigin(prior)} collides with ${expandedOrigin(s)}. ` +
          `Keys must expand uniquely (they name the map files and report entries); ` +
          `rename one surface, variant, live state, or state recipe.`,
      );
    }
    byKey.set(s.key, s);
  }
}
