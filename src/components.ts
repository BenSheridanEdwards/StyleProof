import fs from 'node:fs';
import path from 'node:path';
import type { Surface } from './runner.js';

export type DiscoveredComponent = {
  /** Stable surface key, e.g. `component-dashboard-pr-card`. */
  key: string;
  /** Path relative to `cwd`, using `/` separators. */
  path: string;
};

export type DiscoverComponentFilesOptions = {
  /** Project root. Defaults to the current working directory. */
  cwd?: string;
  /** Component roots to scan, relative to `cwd` unless absolute. */
  roots: string[];
  /** Capture-key prefix. Defaults to `component`. */
  prefix?: string;
  /** File extensions to include. Defaults to common JS + framework component files. */
  extensions?: string[];
  /** Extra regexes matched against the cwd-relative path. */
  ignore?: RegExp[];
};

export type ComponentCatalogSurfaceOptions = {
  /** Map a discovered component to the app-owned catalog URL that renders it. */
  url?: (component: DiscoveredComponent) => string;
  /** Viewport widths to apply to every generated component surface. */
  widths?: number[];
  /** Viewport height to apply to every generated component surface. */
  height?: Surface['height'];
  /** Selectors ignored on every generated component surface. */
  ignore?: string[];
};

const DEFAULT_EXTENSIONS = ['.jsx', '.tsx', '.vue', '.svelte', '.astro'];
const DEFAULT_IGNORE = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)(test|tests|fixtures|mocks)(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(dist|build|coverage|\.next|\.nuxt|\.svelte-kit)(\/|$)/,
  /(^|\/)index\.[^/]+$/,
  /\.(?:test|spec|stories|story)\.[^/]+$/,
  /\.d\.ts$/,
];

function toSlash(file: string): string {
  return file.split(path.sep).join('/');
}

function componentKey(root: string, file: string, prefix: string): string {
  const rel = toSlash(path.relative(root, file))
    .replace(/\.[^.]+$/, '')
    .replace(/\/index$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return [prefix, rel].filter(Boolean).join('-');
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function assertComponentRoot(root: string, rootInput: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`StyleProof component root not found: ${rootInput}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`StyleProof component root is not a directory: ${rootInput}`);
  }
}

/**
 * Discover component files so apps can make StyleProof coverage explicit:
 * map these keys to a Storybook/Ladle/custom catalog route, then pass the keys
 * to `expected`. StyleProof inventories files; the app still owns rendering
 * because props, providers, data, portals, and framework bootstraps are app-specific.
 */
export function discoverComponentFiles(options: DiscoverComponentFilesOptions): DiscoveredComponent[] {
  const cwd = options.cwd ?? process.cwd();
  const prefix = options.prefix ?? 'component';
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const components: DiscoveredComponent[] = [];

  for (const rootInput of options.roots) {
    const root = path.resolve(cwd, rootInput);
    assertComponentRoot(root, rootInput);
    const walk = (dir: string): void => {
      for (const entry of readDir(dir)) {
        const file = path.join(dir, entry.name);
        const rel = toSlash(path.relative(cwd, file));
        if (ignore.some((pattern) => pattern.test(rel))) continue;
        if (entry.isDirectory()) {
          walk(file);
        } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
          components.push({ key: componentKey(root, file, prefix), path: rel });
        }
      }
    };
    walk(root);
  }

  const seen = new Map<string, string>();
  for (const component of components) {
    const previous = seen.get(component.key);
    if (previous) {
      throw new Error(`StyleProof component key collision: ${component.key} from ${previous} and ${component.path}`);
    }
    seen.set(component.key, component.path);
  }
  return components.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Turn discovered components into StyleProof surfaces for an app-owned catalog
 * route. Default URL: `/styleproof/components/<component.key>`.
 */
export function componentCatalogSurfaces(
  components: DiscoveredComponent[],
  options: ComponentCatalogSurfaceOptions = {},
): Surface[] {
  return components.map((component) => ({
    key: component.key,
    go: async (page) => {
      await page.goto(options.url?.(component) ?? `/styleproof/components/${component.key}`);
    },
    ...(options.widths ? { widths: options.widths } : {}),
    ...(options.height ? { height: options.height } : {}),
    ...(options.ignore ? { ignore: options.ignore } : {}),
  }));
}
