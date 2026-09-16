/**
 * Static registry diagnostics for the typed component manifest. StyleProof never
 * loads component modules (no dynamic import, eval, or AST): the consumer hands
 * over a {@link ComponentStaticRegistry} built from its own static imports, and
 * the manifest is checked against it. Schema enforcement stays in the validator.
 */
import {
  ComponentManifestError,
  type ComponentManifest,
  type ComponentManifestComponent,
  type ComponentManifestVariant,
  validateComponentManifest,
} from './component-manifest.js';
import { toSlash } from './util.js';

export type StaticModuleExports = {
  /** Named exports, including `'default'` when the module exports a default. */
  exports: readonly string[];
};

/** Repo-relative module path -> exported names, built from the consumer's own static imports. */
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
 * Deterministic diagnostics for `input` against a static registry: `[]` only when
 * the manifest validates AND every declared export and provider is registered. An
 * invalid manifest reports its first validation failure (never a silent clean).
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
