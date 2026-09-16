/**
 * Framework-neutral typed component manifest: modules, export names, serializable
 * variant props, provider modules, viewports, and exclusions-with-reason. Keys and
 * catalog URLs are deterministic and compatible with {@link componentCatalogSurfaces}.
 * No React runtime, no eval, no remote module loading, no prop inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  componentCatalogSurfaces,
  componentSlug,
  type ComponentCatalogSurfaceOptions,
  type DiscoveredComponent,
} from './components.js';
import type { Surface } from './runner.js';
import { toSlash } from './util.js';

export type ManifestJsonPrimitive = string | number | boolean | null;
export type ManifestJsonValue = ManifestJsonPrimitive | ManifestJsonValue[] | { [key: string]: ManifestJsonValue };

export type ComponentManifestVariant = {
  /** Capture-key / catalog segment suffix. Unique per component. */
  key: string;
  /** Serializable props only (JSON values). No functions or live service data. */
  props?: ManifestJsonValue;
  /** Optional committed provider/harness module path (repo-relative). */
  provider?: string;
  widths?: number[];
  height?: Surface['height'];
};

export type ComponentManifestComponent = {
  /** Stable component id for keying; derived from `module` when omitted. */
  id?: string;
  /** Component module path (repo-relative; never a remote URL). */
  module: string;
  /** Named export. Defaults to `default`. */
  export?: string;
  /** At least one explicit variant — StyleProof does not invent props. */
  variants: ComponentManifestVariant[];
};

/** A component file intentionally left out of the catalog, with a required reason. */
export type ComponentManifestExclusion = { path: string; reason: string };

export type ComponentManifest = {
  /** Schema version. Only `1` is accepted. */
  version: 1;
  /** Capture-key prefix. Defaults to `component`. */
  prefix?: string;
  /** Catalog URL base path (no trailing slash). Defaults to `/styleproof/components`. */
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

/** True when `value` is JSON-serializable (no functions, bigint, undefined, NaN, symbols, or cycles). */
export function isSerializableManifestValue(value: unknown): value is ManifestJsonValue {
  // Active-ancestor set: shared (acyclic) refs stay serializable while true cycles fail.
  return isSerializableManifestValueInner(value, new WeakSet<object>());
}

function isSerializableManifestValueInner(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  ancestors.add(value);
  try {
    return Object.values(value).every((item) => isSerializableManifestValueInner(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

/** Module-path rejections in order: [test, message]; `%s` is the normalized path. */
const MODULE_PATH_REJECTS: [test: (p: string) => boolean, message: string][] = [
  [(p) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p), 'must be a local module path, not a remote URL (%s)'],
  [(p) => p.includes('\0'), 'must not contain null bytes'],
  [(p) => path.isAbsolute(p) || /^[a-zA-Z]:\//.test(p), 'must be repo-relative, not absolute (%s)'],
  [(p) => p.split('/').some((part) => part === '..'), "must not contain '..' segments (%s)"],
];

function assertLocalModulePath(modulePath: string, label: string): string {
  const normalized = nonEmptyString(modulePath, label).replace(/\\/g, '/');
  const reject = MODULE_PATH_REJECTS.find(([test]) => test(normalized));
  if (reject) fail(`${label} ${reject[1].replace('%s', normalized)}`);
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

const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function assertOptionalWidths(value: unknown, label: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPositive)) {
    fail(`${label} must be a non-empty array of positive finite numbers`);
  }
  return value;
}

function assertOptionalHeight(value: unknown, label: string): number | undefined {
  if (value !== undefined && !isPositive(value)) fail(`${label} must be a positive finite number`);
  return value;
}

function componentIdFromModule(modulePath: string): string {
  const slash = modulePath.replace(/\\/g, '/');
  const componentsIdx = slash.lastIndexOf('/components/');
  const rel = componentsIdx >= 0 ? slash.slice(componentsIdx + '/components/'.length) : slash.replace(/^\.\//, '');
  const slug = componentSlug(rel);
  if (!slug) fail(`could not derive component id from module path ${modulePath}`);
  return slug;
}

/** `fn()` or `fail(message)` when it throws. */
function attempt<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch {
    fail(message);
  }
}

/** Resolve `rel` under `cwd`, require a real file, and reject paths that escape the root via `..` or symlink. */
function assertFileExists(cwd: string, rel: string, label: string): void {
  const realRoot = attempt(() => fs.realpathSync(cwd), `${label}: project root not found (${cwd})`);
  const realAbs = attempt(() => fs.realpathSync(path.resolve(cwd, rel)), `${label} not found: ${rel}`);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realAbs !== realRoot && !realAbs.startsWith(rootPrefix)) fail(`${label} escapes project root: ${rel}`);
  if (!attempt(() => fs.statSync(realAbs), `${label} not found: ${rel}`).isFile())
    fail(`${label} is not a file: ${rel}`);
}

/** Drop `undefined` entries so optional fields stay absent, not present-as-undefined. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseVariant(raw: unknown, index: number, componentLabel: string, cwd?: string): ComponentManifestVariant {
  const label = `${componentLabel}.variants[${index}]`;
  const v = plainObject(raw, label);
  const key = assertVariantKey(v.key, `${label}.key`);
  if (v.props !== undefined && !isSerializableManifestValue(v.props)) {
    fail(`${label}.props must be JSON-serializable (no functions, NaN, undefined, or class instances)`);
  }
  const provider =
    v.provider === undefined ? undefined : assertLocalModulePath(String(v.provider), `${label}.provider`);
  if (provider && cwd) assertFileExists(cwd, provider, `${label}.provider`);
  return compact({
    key,
    props: v.props as ManifestJsonValue | undefined,
    provider,
    widths: assertOptionalWidths(v.widths, `${label}.widths`),
    height: assertOptionalHeight(v.height, `${label}.height`),
  });
}

function parseComponent(raw: unknown, index: number, cwd?: string): ComponentManifestComponent {
  const label = `components[${index}]`;
  const c = plainObject(raw, label);
  const modulePath = assertLocalModulePath(String(c.module ?? ''), `${label}.module`);
  if (cwd) assertFileExists(cwd, modulePath, `${label}.module path`);
  const exportName = c.export === undefined ? 'default' : assertExportName(c.export, `${label}.export`);
  const id = c.id === undefined ? undefined : componentSlug(nonEmptyString(c.id, `${label}.id`));
  if (c.id !== undefined && !id) fail(`${label}.id must yield a non-empty slug`);
  if (!Array.isArray(c.variants) || c.variants.length === 0) fail(`${label}.variants must be a non-empty array`);
  const variants = c.variants.map((variant, i) => parseVariant(variant, i, label, cwd));
  return { ...(id ? { id } : {}), module: modulePath, export: exportName, variants };
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
  const prefix = componentSlug(nonEmptyString(value, 'prefix'));
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
  const decoded = attempt(() => decodeURIComponent(raw), `"catalogBasePath" must contain valid URL encoding`);
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
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

/** Every (component, variant) pair with its deterministic surface key. */
function variantKeys(components: ComponentManifestComponent[], prefix: string) {
  return components.flatMap((component) => {
    const componentId = component.id ?? componentIdFromModule(component.module);
    return component.variants.map((variant) => ({
      component,
      variant,
      key: componentManifestSurfaceKey({ prefix, componentId, variantKey: variant.key }),
    }));
  });
}

function assertUniqueSurfaceKeys(components: ComponentManifestComponent[], prefix: string): void {
  const seen = new Map<string, string>();
  for (const { component, variant, key } of variantKeys(components, prefix)) {
    const previous = seen.get(key);
    const where = `${component.module}#${component.export} variant ${variant.key}`;
    if (previous) fail(`duplicate surface key "${key}" from ${previous} and ${where}`);
    seen.set(key, where);
  }
}

/** Validate and normalize an unknown manifest document; throws {@link ComponentManifestError}. */
export function validateComponentManifest(
  input: unknown,
  options: ValidateComponentManifestOptions = {},
): ComponentManifest {
  const root = plainObject(input, 'manifest');
  if (root.version !== 1) fail(`"version" must be 1 (got ${JSON.stringify(root.version)})`);
  if (!Array.isArray(root.components)) fail(`"components" must be an array`);

  const prefix = parsePrefix(root.prefix);
  const components = root.components.map((c, i) => parseComponent(c, i, options.cwd));
  assertUniqueSurfaceKeys(components, prefix);
  return compact({
    version: 1 as const,
    prefix,
    catalogBasePath: parseCatalogBasePath(root.catalogBasePath),
    components,
    exclusions: parseExclusions(root.exclusions),
  });
}

export type ComponentManifestSurfaceKeyInput = {
  prefix?: string;
  componentId: string;
  variantKey: string;
};

/** Deterministic surface key: `<prefix>-<componentId>-<variantKey>` (slugified). */
export function componentManifestSurfaceKey(input: ComponentManifestSurfaceKeyInput): string {
  const prefix = componentSlug(input.prefix ?? DEFAULT_PREFIX);
  const componentId = componentSlug(input.componentId);
  const variantKey = componentSlug(input.variantKey);
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

/** Expand a validated manifest into {@link DiscoveredComponent} rows (one per variant), sorted by key. */
export function componentManifestToDiscovered(manifest: ComponentManifest): DiscoveredComponent[] {
  return variantKeys(manifest.components, manifest.prefix ?? DEFAULT_PREFIX)
    .map(({ component, key }) => ({ key, path: toSlash(component.module) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export type ComponentManifestCatalogSurfaceOptions = ComponentCatalogSurfaceOptions & {
  /** Override manifest catalogBasePath when building default URLs. */
  catalogBasePath?: string;
};

type Viewport = Pick<Surface, 'widths' | 'height'>;

/** Surface key → the per-variant viewport override, for variants that declare one. */
function variantViewportBySurfaceKey(manifest: ComponentManifest): Map<string, Viewport> {
  const byKey = new Map<string, Viewport>();
  for (const { variant, key } of variantKeys(manifest.components, manifest.prefix ?? DEFAULT_PREFIX)) {
    if (variant.widths !== undefined || variant.height !== undefined) {
      byKey.set(key, compact({ widths: variant.widths, height: variant.height }));
    }
  }
  return byKey;
}

/** Surfaces from a validated manifest (default URL `<catalogBasePath>/<surfaceKey>`); per-variant `widths`/`height` override catalog-level options. */
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
  return surfaces.map((surface) => ({ ...surface, ...variantViewport.get(surface.key) }));
}
