/**
 * Compile-time fixture: `stateRecipeGo` is assignable to `SurfaceVariant.go`.
 * Included in the package build so a type regression fails `tsc` / `npm run build`.
 * Not a runtime API — side-effect-free type proof only (proves `go`, not setup).
 */
import type { SurfaceVariant } from './runner.js';
import { stateRecipeGo } from './state-recipes.js';

/** Real SurfaceVariant object using stateRecipeGo via the `go` slot. */
export const stateRecipeSurfaceVariantFixture = {
  key: 'plan-card-hover',
  go: stateRecipeGo({ action: 'hover', selector: '#plan-card', label: 'Plan card' }),
} satisfies SurfaceVariant;

const _goSlot: NonNullable<SurfaceVariant['go']> = stateRecipeGo({
  action: 'click',
  selector: '#menu',
  label: 'Open menu',
});

void _goSlot;
void stateRecipeSurfaceVariantFixture;
