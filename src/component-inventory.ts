import type { ComponentManifest } from './component-manifest.js';
import type { DiscoveredComponent } from './components.js';

export type DeclaredComponentInventoryEntry = {
  path: string;
  export: string;
  variants: string[];
};

export type ExcludedComponentInventoryEntry = {
  path: string;
  reason: string;
};

export type ComponentManifestInventory = {
  declared: DeclaredComponentInventoryEntry[];
  excludedWithReason: ExcludedComponentInventoryEntry[];
  uncovered: string[];
};

export class ComponentInventoryError extends Error {}

function toSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function uniqueDiscoveredPaths(discovered: DiscoveredComponent[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const component of discovered) {
    const componentPath = toSlash(component.path);
    if (seen.has(componentPath)) {
      throw new ComponentInventoryError(
        `StyleProof component inventory: duplicate discovered component path ${componentPath}`,
      );
    }
    seen.add(componentPath);
    paths.push(componentPath);
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/**
 * Classify discovered component files against an already validated manifest.
 * Every discovered path is exactly one of declared, excluded-with-reason, or
 * uncovered. Overlap and duplicate discovered paths fail closed.
 */
export function componentManifestInventory(
  manifest: ComponentManifest,
  discovered: DiscoveredComponent[],
): ComponentManifestInventory {
  const declared = manifest.components
    .map((component) => ({
      path: toSlash(component.module),
      export: component.export ?? 'default',
      variants: component.variants.map((variant) => variant.key).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.export.localeCompare(b.export));
  const excludedWithReason = (manifest.exclusions ?? [])
    .map((entry) => ({ path: toSlash(entry.path), reason: entry.reason }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const declaredPaths = new Set(declared.map((entry) => entry.path));
  const excludedPaths = new Set<string>();
  for (const entry of excludedWithReason) {
    if (declaredPaths.has(entry.path)) {
      throw new ComponentInventoryError(
        `StyleProof component inventory: ${entry.path} cannot be both declared and excluded-with-reason`,
      );
    }
    if (excludedPaths.has(entry.path)) {
      throw new ComponentInventoryError(`StyleProof component inventory: duplicate exclusion path ${entry.path}`);
    }
    excludedPaths.add(entry.path);
  }

  const uncovered = uniqueDiscoveredPaths(discovered).filter(
    (componentPath) => !declaredPaths.has(componentPath) && !excludedPaths.has(componentPath),
  );
  return { declared, excludedWithReason, uncovered };
}
