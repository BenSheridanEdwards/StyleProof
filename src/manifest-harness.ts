/**
 * Static registry diagnostics for the typed component manifest (#392 S2).
 *
 * StyleProof never loads component modules itself — no dynamic `import()`, no
 * eval, no AST. The CONSUMER's dev entry already imports every component and
 * provider statically; that set of imports is the only honest picture of what
 * the app can render. Consumers hand StyleProof that picture as a
 * {@link ComponentStaticRegistry}: module path (repo-relative, `/` separators,
 * exactly as the manifest declares it) -> the module's exported names.
 *
 * `collectManifestDiagnostics` walks a manifest against that registry and
 * returns deterministic, framework-neutral diagnostics:
 *   - `missing-export`   a declared component export (or its whole module) is
 *                        not in the static registry;
 *   - `missing-provider` a declared variant provider module is not in the
 *                        static registry;
 *   - `invalid-props`    variant props fail {@link validateComponentManifest}
 *                        serializability;
 *   - `duplicate-keys`   two variants collide on one surface key;
 *   - `invalid-manifest` any other schema failure (fail closed: a manifest
 *                        that cannot be validated is never silently clean).
 *
 * The same module must also satisfy {@link validateComponentManifest} for the
 * manifest to be loadable at all; diagnostics are advisory reporting, schema
 * enforcement stays in the validator.
 */
import {
  ComponentManifestError,
  type ComponentManifest,
  type ComponentManifestComponent,
  type ComponentManifestVariant,
  validateComponentManifest,
} from './component-manifest.js';

export type StaticModuleExports = {
  /** Named exports, including `'default'` when the module exports a default. */
  exports: readonly string[];
};

/**
 * Static consumer registry: repo-relative module path -> exported names.
 * Built from the consumer's own static imports; never populated by loading
 * modules from the manifest (no dynamic import / eval / AST).
 */
export type ComponentStaticRegistry = Record<string, StaticModuleExports>;

export type ManifestDiagnosticKind =
  'missing-export' | 'missing-provider' | 'invalid-props' | 'duplicate-keys' | 'invalid-manifest';

export type ManifestDiagnostic = {
  kind: ManifestDiagnosticKind;
  /** Human-readable problem description. */
  message: string;
  /** Where the problem lives (e.g. `components[0]`, `components[1].variants[0].props`). */
  where?: string;
};

export type CollectManifestDiagnosticsOptions = {
  /** Same semantics as {@link validateComponentManifest}: root for file-existence checks. */
  cwd?: string;
};

function toSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function registryEntry(registry: ComponentStaticRegistry, modulePath: string): StaticModuleExports | undefined {
  const key = toSlash(modulePath);
  if (!Object.prototype.hasOwnProperty.call(registry, key)) return undefined;
  const entry = registry[key];
  if (!entry || !Array.isArray(entry.exports)) return undefined;
  return entry;
}

function componentDiagnostics(
  component: ComponentManifestComponent,
  index: number,
  registry: ComponentStaticRegistry,
  out: ManifestDiagnostic[],
): void {
  const where = `components[${index}]`;
  const exportName = component.export ?? 'default';
  const entry = registryEntry(registry, component.module);
  if (!entry) {
    out.push({
      kind: 'missing-export',
      where,
      message: `module "${component.module}" is not in the static registry — import it from the consumer dev entry before declaring it in the manifest`,
    });
  } else if (!entry.exports.includes(exportName)) {
    out.push({
      kind: 'missing-export',
      where,
      message: `module "${component.module}" does not export "${exportName}" (registered exports: ${entry.exports.join(', ')})`,
    });
  }
  for (const [variantIndex, variant] of component.variants.entries()) {
    variantDiagnostics(component, variant, index, variantIndex, registry, out);
  }
}

function variantDiagnostics(
  component: ComponentManifestComponent,
  variant: ComponentManifestVariant,
  componentIndex: number,
  variantIndex: number,
  registry: ComponentStaticRegistry,
  out: ManifestDiagnostic[],
): void {
  if (variant.provider === undefined) return;
  const where = `components[${componentIndex}].variants[${variantIndex}]`;
  const providerEntry = registryEntry(registry, variant.provider);
  if (!providerEntry || !providerEntry.exports.includes('default')) {
    out.push({
      kind: 'missing-provider',
      where,
      message: `provider module "${variant.provider}" (for ${component.module} variant "${variant.key}") is not in the static registry with a default export — import its default export from the consumer dev entry before declaring it in the manifest`,
    });
  }
}

function validationDiagnostics(error: ComponentManifestError): ManifestDiagnostic {
  // `fail()` prefixes messages with "StyleProof component manifest: " — match
  // the discriminators anywhere in the message, not at the start.
  const duplicate = /duplicate surface key "([^"]+)"/.exec(error.message);
  if (duplicate) {
    return {
      kind: 'duplicate-keys',
      where: duplicate[1],
      message: error.message,
    };
  }
  const invalidProps = /(\S+)\s+must be JSON-serializable/.exec(error.message);
  if (invalidProps) {
    return {
      kind: 'invalid-props',
      where: invalidProps[1],
      message: error.message,
    };
  }
  return { kind: 'invalid-manifest', message: error.message };
}

/**
 * Collect deterministic diagnostics for `input` against a static registry.
 *
 * Returns `[]` only when the manifest validates AND every declared export and
 * provider is present in the registry. When the manifest itself is invalid,
 * the first validation failure is reported (fail closed: never a silent
 * clean). Other diagnostics follow manifest order (components, then per
 * component: export, then variants).
 */
export function collectManifestDiagnostics(
  input: unknown,
  registry: ComponentStaticRegistry,
  options: CollectManifestDiagnosticsOptions = {},
): ManifestDiagnostic[] {
  let manifest: ComponentManifest;
  try {
    manifest = validateComponentManifest(input, options);
  } catch (error) {
    if (error instanceof ComponentManifestError) return [validationDiagnostics(error)];
    throw error;
  }
  const out: ManifestDiagnostic[] = [];
  for (const [index, component] of manifest.components.entries()) {
    componentDiagnostics(component, index, registry, out);
  }
  return out;
}
