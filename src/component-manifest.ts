/**
 * Framework-neutral typed component manifest (#392 experiment, slice 1).
 *
 * Consumers declare component modules, export names, serializable variant props,
 * optional provider/harness modules, viewports, and exclusions-with-reason.
 * Keys and catalog URLs are deterministic and compatible with
 * {@link componentCatalogSurfaces} (`/styleproof/components/<key>` by default).
 *
 * No React runtime, no eval, no remote module loading, no prop inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  componentCatalogSurfaces,
  type ComponentCatalogSurfaceOptions,
  type DiscoveredComponent,
} from './components.js';
import type { Surface } from './runner.js';

export type ManifestJsonPrimitive = string | number | boolean | null;
export type ManifestJsonValue = ManifestJsonPrimitive | ManifestJsonValue[] | { [key: string]: ManifestJsonValue };

export type ComponentManifestVariant = {
  /** Capture-key / catalog segment suffix. Unique per component. */
  key: string;
  /** Serializable props only (JSON values). No functions or live service data. */
  props?: ManifestJsonValue;
  /** Optional committed provider/harness module path (repo-relative). */
  provider?: string;
  /** Viewport widths for this variant surface. */
  widths?: number[];
  /** Viewport height for this variant surface. */
  height?: Surface['height'];
};

export type ComponentManifestComponent = {
  /**
   * Stable component id for keying. When omitted, derived from `module` the same
   * way {@link discoverComponentFiles} slugs relative file paths.
   */
  id?: string;
  /** Component module path (repo-relative; never a remote URL). */
  module: string;
  /** Named export. Defaults to `default`. */
  export?: string;
  /** At least one explicit variant — StyleProof does not invent props. */
  variants: ComponentManifestVariant[];
};

export type ComponentManifestExclusion = {
  /** Repo-relative path of a component file intentionally left out of the catalog. */
  path: string;
  /** Human-readable reason (required; empty reasons are rejected). */
  reason: string;
};

export type ComponentManifest = {
  /** Schema version. Only `1` is accepted in this experiment. */
  version: 1;
  /** Capture-key prefix. Defaults to `component` (matches discoverComponentFiles). */
  prefix?: string;
  /**
   * Catalog URL base path (no trailing slash). Defaults to
   * `/styleproof/components` so routes plug into componentCatalogSurfaces.
   */
  catalogBasePath?: string;
  components: ComponentManifestComponent[];
  exclusions?: ComponentManifestExclusion[];
};

export type ValidateComponentManifestOptions = {
  /** When set, module and provider paths must exist as files under this root. */
  cwd?: string;
};

export class ComponentManifestError extends Error {}

const DEFAULT_PREFIX = 'component';
const DEFAULT_CATALOG_BASE = '/styleproof/components';
const EXPORT_NAME_RE = /^(?:default|[$A-Z_a-z][$0-9A-Z_a-z]*)$/;
const VARIANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function fail(message: string): never {
  throw new ComponentManifestError(`StyleProof component manifest: ${message}`);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

/**
 * True when `value` is JSON-serializable (no functions, bigint, undefined, NaN,
 * Infinity, symbols, or cyclic structures). Cycles return false instead of
 * overflowing the call stack. Repeated shared (acyclic) references are allowed,
 * matching `JSON.stringify`.
 */
export function isSerializableManifestValue(value: unknown): value is ManifestJsonValue {
  // Active-ancestor set only: objects leave the set after their subtree is
  // walked so diamond/shared refs stay serializable while true cycles fail.
  return isSerializableManifestValueInner(value, new WeakSet<object>());
}

function isSerializableManifestValueInner(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return false;
  if (typeof value === 'undefined') return false;
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isSerializableManifestValueInner(item, ancestors));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) =>
      isSerializableManifestValueInner(item, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

function toSlash(file: string): string {
  return file.split(path.sep).join('/');
}

/**
 * Slug a path or id the same way component file keys are built
 * (kebab-case, no extension, no leading/trailing hyphens).
 */
export function slugManifestSegment(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '')
    .replace(/\/index$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function assertLocalModulePath(modulePath: string, label: string): string {
  const normalized = nonEmptyString(modulePath, label).replace(/\\/g, '/');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    fail(`${label} must be a local module path, not a remote URL (${normalized})`);
  }
  if (normalized.includes('\0')) fail(`${label} must not contain null bytes`);
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    fail(`${label} must be repo-relative, not absolute (${normalized})`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    fail(`${label} must not contain '..' segments (${normalized})`);
  }
  return normalized;
}

function assertExportName(value: unknown, label: string): string {
  const name = nonEmptyString(value, label);
  if (!EXPORT_NAME_RE.test(name)) {
    fail(`${label} must be a valid JavaScript identifier or "default" (got ${JSON.stringify(name)})`);
  }
  return name;
}

function assertVariantKey(value: unknown, label: string): string {
  const key = nonEmptyString(value, label);
  if (!VARIANT_KEY_RE.test(key)) {
    fail(`${label} must match [A-Za-z0-9][A-Za-z0-9_-]* (got ${JSON.stringify(key)})`);
  }
  return key;
}

function assertOptionalWidths(value: unknown, label: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w <= 0)
  ) {
    fail(`${label} must be a non-empty array of positive finite numbers`);
  }
  return value as number[];
}

function assertOptionalHeight(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number`);
  }
  return value;
}

function componentIdFromModule(modulePath: string): string {
  const slash = modulePath.replace(/\\/g, '/');
  const componentsIdx = slash.lastIndexOf('/components/');
  const rel = componentsIdx >= 0 ? slash.slice(componentsIdx + '/components/'.length) : slash.replace(/^\.\//, '');
  const slug = slugManifestSegment(rel);
  if (!slug) fail(`could not derive component id from module path ${modulePath}`);
  return slug;
}

/** True when `candidate` is the same path as `root` or a path under it (after realpath). */
function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootNorm = path.resolve(root);
  const candidateNorm = path.resolve(candidate);
  if (candidateNorm === rootNorm) return true;
  const prefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
  return candidateNorm.startsWith(prefix);
}

/**
 * Resolve `rel` under `cwd`, require a real file, and reject paths that escape
 * the project root via `..` or symlink (realpath containment where feasible).
 */
function assertFileExists(cwd: string, rel: string, label: string): void {
  const abs = path.resolve(cwd, rel);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(cwd);
  } catch {
    fail(`${label}: project root not found (${cwd})`);
  }
  let realAbs: string;
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    fail(`${label} not found: ${rel}`);
  }
  if (!isPathInsideRoot(realRoot, realAbs)) {
    fail(`${label} escapes project root: ${rel}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realAbs);
  } catch {
    fail(`${label} not found: ${rel}`);
  }
  if (!stat.isFile()) fail(`${label} is not a file: ${rel}`);
}

function parseVariant(raw: unknown, index: number, componentLabel: string, cwd?: string): ComponentManifestVariant {
  const label = `${componentLabel}.variants[${index}]`;
  const v = plainObject(raw, label);
  const key = assertVariantKey(v.key, `${label}.key`);
  let props: ManifestJsonValue | undefined;
  if (v.props !== undefined) {
    if (!isSerializableManifestValue(v.props)) {
      fail(`${label}.props must be JSON-serializable (no functions, NaN, undefined, or class instances)`);
    }
    props = v.props;
  }
  let provider: string | undefined;
  if (v.provider !== undefined) {
    provider = assertLocalModulePath(String(v.provider), `${label}.provider`);
    if (cwd) assertFileExists(cwd, provider, `${label}.provider`);
  }
  const widths = assertOptionalWidths(v.widths, `${label}.widths`);
  const height = assertOptionalHeight(v.height, `${label}.height`);
  return {
    key,
    ...(props !== undefined ? { props } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(widths !== undefined ? { widths } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function parseComponent(raw: unknown, index: number, cwd?: string): ComponentManifestComponent {
  const label = `components[${index}]`;
  const c = plainObject(raw, label);
  const modulePath = assertLocalModulePath(String(c.module ?? ''), `${label}.module`);
  if (cwd) assertFileExists(cwd, modulePath, `${label}.module path`);
  const exportName = c.export === undefined ? 'default' : assertExportName(c.export, `${label}.export`);
  const id = c.id === undefined ? undefined : slugManifestSegment(nonEmptyString(c.id, `${label}.id`));
  if (c.id !== undefined && !id) fail(`${label}.id must yield a non-empty slug`);
  if (!Array.isArray(c.variants) || c.variants.length === 0) {
    fail(`${label}.variants must be a non-empty array`);
  }
  const variants = c.variants.map((variant, i) => parseVariant(variant, i, label, cwd));
  return {
    ...(id ? { id } : {}),
    module: modulePath,
    export: exportName,
    variants,
  };
}

function parseExclusion(raw: unknown, index: number): ComponentManifestExclusion {
  const label = `exclusions[${index}]`;
  const e = plainObject(raw, label);
  const exclusionPath = assertLocalModulePath(String(e.path ?? ''), `${label}.path`);
  const reason = nonEmptyString(e.reason, `${label}.reason`);
  return { path: exclusionPath, reason };
}

function parsePrefix(value: unknown): string {
  if (value === undefined) return DEFAULT_PREFIX;
  const prefix = slugManifestSegment(nonEmptyString(value, 'prefix'));
  if (!prefix) fail(`"prefix" must yield a non-empty slug`);
  return prefix;
}

function parseCatalogBasePath(value: unknown): string {
  if (value === undefined) return DEFAULT_CATALOG_BASE;
  const raw = nonEmptyString(value, 'catalogBasePath').replace(/\\/g, '/');
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    fail(`"catalogBasePath" must be an app-relative path starting with exactly one '/'`);
  }
  if (/[?#\0]/.test(raw)) fail(`"catalogBasePath" must not contain query, fragment, or NUL characters`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail(`"catalogBasePath" must contain valid URL encoding`);
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    fail(`"catalogBasePath" must not contain traversal segments`);
  }
  return stripTrailingSlashes(raw) || '/';
}

/** Linear trailing-slash trim. Avoids `/\/+$/` so CodeQL cannot treat catalog input as ReDoS. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function parseExclusions(value: unknown): ComponentManifestExclusion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`"exclusions" must be an array`);
  return value.map((e, i) => parseExclusion(e, i));
}

function assertUniqueSurfaceKeys(components: ComponentManifestComponent[], prefix: string): void {
  const seen = new Map<string, string>();
  for (const component of components) {
    const componentId = component.id ?? componentIdFromModule(component.module);
    for (const variant of component.variants) {
      const surfaceKey = componentManifestSurfaceKey({
        prefix,
        componentId,
        variantKey: variant.key,
      });
      const previous = seen.get(surfaceKey);
      const where = `${component.module}#${component.export} variant ${variant.key}`;
      if (previous) {
        fail(`duplicate surface key "${surfaceKey}" from ${previous} and ${where}`);
      }
      seen.set(surfaceKey, where);
    }
  }
}

/**
 * Validate and normalize an unknown component-manifest document.
 * Throws {@link ComponentManifestError} with actionable diagnostics.
 */
export function validateComponentManifest(
  input: unknown,
  options: ValidateComponentManifestOptions = {},
): ComponentManifest {
  const root = plainObject(input, 'manifest');
  if (root.version !== 1) fail(`"version" must be 1 (got ${JSON.stringify(root.version)})`);
  if (!Array.isArray(root.components)) fail(`"components" must be an array`);

  const prefix = parsePrefix(root.prefix);
  const catalogBasePath = parseCatalogBasePath(root.catalogBasePath);
  const components = root.components.map((c, i) => parseComponent(c, i, options.cwd));
  const exclusions = parseExclusions(root.exclusions);
  assertUniqueSurfaceKeys(components, prefix);

  return {
    version: 1,
    prefix,
    catalogBasePath,
    components,
    ...(exclusions ? { exclusions } : {}),
  };
}

export type ComponentManifestSurfaceKeyInput = {
  prefix?: string;
  componentId: string;
  variantKey: string;
};

/** Deterministic surface key: `<prefix>-<componentId>-<variantKey>` (slugified). */
export function componentManifestSurfaceKey(input: ComponentManifestSurfaceKeyInput): string {
  const prefix = slugManifestSegment(input.prefix ?? DEFAULT_PREFIX);
  const componentId = slugManifestSegment(input.componentId);
  const variantKey = slugManifestSegment(input.variantKey);
  if (!componentId) fail('component id must yield a non-empty slug');
  if (!variantKey) fail('variant key must yield a non-empty slug');
  return [prefix, componentId, variantKey].filter(Boolean).join('-');
}

export type ComponentManifestCatalogPathOptions = {
  catalogBasePath?: string;
};

/** Catalog URL path for a surface key (default base matches componentCatalogSurfaces). */
export function componentManifestCatalogPath(
  surfaceKey: string,
  options: ComponentManifestCatalogPathOptions = {},
): string {
  const key = nonEmptyString(surfaceKey, 'surfaceKey');
  if (/[/?#\\\0]/.test(key) || key === '.' || key === '..') {
    fail(`"surfaceKey" must be a single URL-safe path segment`);
  }
  const base = parseCatalogBasePath(options.catalogBasePath);
  return `${base === '/' ? '' : base}/${key}`;
}

/**
 * Expand a validated manifest into {@link DiscoveredComponent} rows (one per variant)
 * sorted by key — ready for {@link componentCatalogSurfaces}.
 */
export function componentManifestToDiscovered(manifest: ComponentManifest): DiscoveredComponent[] {
  const prefix = manifest.prefix ?? DEFAULT_PREFIX;
  const out: DiscoveredComponent[] = [];
  for (const component of manifest.components) {
    const componentId = component.id ?? componentIdFromModule(component.module);
    for (const variant of component.variants) {
      out.push({
        key: componentManifestSurfaceKey({ prefix, componentId, variantKey: variant.key }),
        path: toSlash(component.module),
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export type ComponentManifestCatalogSurfaceOptions = ComponentCatalogSurfaceOptions & {
  /** Override manifest catalogBasePath when building default URLs. */
  catalogBasePath?: string;
};

function variantViewportBySurfaceKey(manifest: ComponentManifest): Map<string, Pick<Surface, 'widths' | 'height'>> {
  const prefix = manifest.prefix ?? DEFAULT_PREFIX;
  const byKey = new Map<string, Pick<Surface, 'widths' | 'height'>>();
  for (const component of manifest.components) {
    const componentId = component.id ?? componentIdFromModule(component.module);
    for (const variant of component.variants) {
      const viewport = pickVariantViewport(variant);
      if (!viewport) continue;
      const key = componentManifestSurfaceKey({
        prefix,
        componentId,
        variantKey: variant.key,
      });
      byKey.set(key, viewport);
    }
  }
  return byKey;
}

function pickVariantViewport(variant: ComponentManifestVariant): Pick<Surface, 'widths' | 'height'> | undefined {
  if (variant.widths === undefined && variant.height === undefined) return undefined;
  return {
    ...(variant.widths !== undefined ? { widths: variant.widths } : {}),
    ...(variant.height !== undefined ? { height: variant.height } : {}),
  };
}

function applyVariantViewport(surface: Surface, override: Pick<Surface, 'widths' | 'height'> | undefined): Surface {
  if (!override) return surface;
  return {
    ...surface,
    ...(override.widths !== undefined ? { widths: override.widths } : {}),
    ...(override.height !== undefined ? { height: override.height } : {}),
  };
}

/**
 * Build StyleProof surfaces from a validated manifest using
 * {@link componentCatalogSurfaces}. Default URL:
 * `<catalogBasePath>/<surfaceKey>`.
 *
 * Per-variant `widths` / `height` from the manifest override catalog-level
 * viewport options for the matching surface (typed variant contract).
 */
export function componentManifestCatalogSurfaces(
  manifest: ComponentManifest,
  options: ComponentManifestCatalogSurfaceOptions = {},
): Surface[] {
  const discovered = componentManifestToDiscovered(manifest);
  const catalogBasePath = options.catalogBasePath ?? manifest.catalogBasePath ?? DEFAULT_CATALOG_BASE;
  const { catalogBasePath: _drop, url, ...rest } = options;
  void _drop;

  const variantViewport = variantViewportBySurfaceKey(manifest);
  const surfaces = componentCatalogSurfaces(discovered, {
    ...rest,
    url: url ?? ((component) => componentManifestCatalogPath(component.key, { catalogBasePath })),
  });

  if (variantViewport.size === 0) return surfaces;
  return surfaces.map((surface) => applyVariantViewport(surface, variantViewport.get(surface.key)));
}
