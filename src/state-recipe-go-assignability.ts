/**
 * Compile-time fixture: `stateRecipeGo` is assignable to `SurfaceVariant.go`.
 * Included in the package build so a type regression fails `tsc` / `npm run build`.
 * Not a runtime API — side-effect-free type proof only.
 */
import type { SurfaceVariant } from './runner.js';
import { stateRecipeGo } from './state-recipes.js';

/** Real SurfaceVariant object using stateRecipeGo (not setup). */
export const stateRecipeSurfaceVariantFixture = {
  key: 'plan-card-hover',
  go: stateRecipeGo({ action: 'hover', selector: '#plan-card', label: 'Plan card' }),
} satisfies SurfaceVariant;

const _goSlot: NonNullable<SurfaceVariant['go']> = stateRecipeGo({
  action: 'click',
  selector: '#menu',
  label: 'Open menu',
});

// Prove setup remains a separate data/mock slot — recipes wire through `go`.
type SetupSlot = NonNullable<SurfaceVariant['setup']>;
const _setupCompatible: SetupSlot = stateRecipeGo({
  action: 'focus',
  selector: '#email',
  label: 'Email',
});

void _goSlot;
void _setupCompatible;
void stateRecipeSurfaceVariantFixture;
