/**
 * Selective remap: given the files a change touched, which declared surfaces
 * could have rendered differently? An OPT-IN speed-up, never the default gate.
 *
 * SOUNDNESS: in the committed-map model a wrong "unaffected" is silent and fatal
 * (a stale base map matches, the diff is empty, the regression ships green), so
 * this OVER-APPROXIMATES. Every uncertainty resolves to the sentinel `'all'`:
 * a global style change, a vanilla (non-module) stylesheet, a computed
 * `import(x)` with no static prefix, or a changed file the graph cannot place.
 *
 * The module graph is an INPUT in the {@link ModuleEdge} shape (dependency-cruiser
 * maps directly); the caller owns graph production. Pure: I/O is injected via `readFile`.
 */

/** One resolved import edge: `from` imports `to`. Mirrors a dependency-cruiser
 *  `modules[].dependencies[]` entry (use `module.source` as `from`, dependency
 *  `resolved` as `to`). `dynamic` is informational; resolution already happened. */
export type ModuleEdge = { from: string; to: string; dynamic?: boolean };

export type AffectedSurfacesInput = {
  /** Repo-relative paths the change touched (as they appear in the graph). */
  changedFiles: Iterable<string>;
  /** Declared surfaces: capture key → the surface's entry module path. */
  surfaces: Record<string, string>;
  /** Resolved import edges for the source tree (node_modules edges are ignored). */
  graph: Iterable<ModuleEdge>;
  /** Every candidate source file path — the universe a context-module glob can
   *  resolve within. Typically the graph's node set. */
  files: Iterable<string>;
  /** Read a source file's text (for style classification and dynamic-import
   *  recovery). Throwing/returning nothing is treated as "unknown" → `'all'`. */
  readFile: (path: string) => string;
};

/** `'all'` means "re-capture everything" (some change could not be bounded). A
 *  `Set` of surface keys means exactly those surfaces can be affected; any not
 *  listed are provably unaffected and may reuse their committed base map. */
export type AffectedSurfaces = Set<string> | 'all';

// Selectors/at-rules whose scope escapes the importing file.
const GLOBAL_CSS =
  /(^|[{},(])\s*(:root|html|body|\*)(?=\s|[,.#:[\]{}()>+~])|@tailwind\b|@layer\s+base\b|@theme\b|@font-face\b/i;
// CSS-in-JS global APIs. Soundness depends on this list being complete for the
// libraries in use: an unlisted global API in a .tsx would be misread as scoped.
const CSSJS_GLOBAL = /\b(createGlobalStyle|injectGlobal|globalStyle|globalCss|createGlobalTheme)\b/;
// `:global(...)` escape hatch or cross-module composition pulls in outside scope.
const MODULE_ESCAPES = /:global\b|\bcompose[sd]?\b[^;]*\bfrom\b/;
// `@use`/`@forward`/`@import` pull another sheet into a CSS-module file; the JS
// import graph cannot bound them, so any occurrence fails closed.
const SASS_LOAD = /@(?:use|forward|import)\b/;

const isConfig = (f: string) =>
  /(?:^|\/)(?:tailwind|postcss|theme|tokens?|panda|uno)\.config\.[cm]?[jt]s$/.test(f) ||
  /(?:^|\/)theme\.[cm]?[jt]s$/.test(f);
const isStyleSheet = (f: string) => /\.(css|scss|sass|less|styl)$/.test(f);
const isCssModule = (f: string) => /\.module\.(css|scss|sass|less|styl)$/.test(f);
const isCode = (f: string) => /\.[cm]?[jt]sx?$/.test(f);

// A CSS Module escapes its hashed scope via `:global`, cross-module `composes … from`,
// genuinely global selectors, or any Sass/CSS load.
const moduleEscapes = (src: string) => MODULE_ESCAPES.test(src) || GLOBAL_CSS.test(src) || SASS_LOAD.test(src);

/** Per file kind: does this source's style scope stay bounded to its importers? No test → never. */
const SCOPED_WHEN: [matches: (file: string) => boolean, scoped?: (src: string) => boolean][] = [
  [isConfig], // design-system config cascades to every surface
  [isCode, (src) => !CSSJS_GLOBAL.test(src)], // .tsx: global CSS-in-JS or colocated scope
  [isCssModule, (src) => !moduleEscapes(src)],
  [isStyleSheet], // vanilla stylesheet: global class namespace
];

/**
 * `'scope'` (follow the import graph) only for provably-scoped changes — a CSS
 * Module without escapes, or colocated CSS-in-JS with no global API; everything
 * else, including anything unreadable or unrecognized, is `'all'`.
 */
export function classifyStyleChange(file: string, readFile: (p: string) => string): 'scope' | 'all' {
  const scoped = SCOPED_WHEN.find(([matches]) => matches(file))?.[1];
  if (!scoped) return 'all';
  let src: string;
  try {
    src = readFile(file);
  } catch {
    return 'all';
  }
  return src != null && scoped(src) ? 'scope' : 'all';
}

// `import(` with a non-string-literal argument, capturing the argument text.
const DYNAMIC_IMPORT = /import\(\s*([^)]+?)\s*\)/g;

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isSource = (p: string) => !p.includes('node_modules');

/**
 * One spelling for a repo-relative path (`./pages/Home.tsx` = `pages//Home.tsx`)
 * so a reverse-reachability hit cannot miss a differently-spelled surface entry.
 * Pure string math: no realpath, no resolution.
 */
export function canonicalPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Read a source file, mapping any throw/nullish result to `undefined`. */
function safeRead(readFile: (p: string) => string, path: string): string | undefined {
  try {
    return readFile(path) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Directory a computed `import()` argument is rooted at: null for a string literal, `'unbounded'` without a static `/` prefix. */
function contextDir(arg: string, fromDir: string): string | null | 'unbounded' {
  if (/^['"]/.test(arg)) return null; // plain string literal
  const prefix = arg.match(/^`([^$`]*)/)?.[1]; // static head of a template literal
  if (!prefix || !prefix.includes('/')) return 'unbounded'; // e.g. import(name)
  return normalizeDir(fromDir, prefix);
}

/** Recover computed `import()`s the resolver dropped as bundler context-module edges; `'unbounded'` when any has no static prefix. */
function recoverContextEdges(from: string, src: string, files: string[]): ModuleEdge[] | 'unbounded' {
  const edges: ModuleEdge[] = [];
  const fromDir = dirOf(from);
  for (const m of src.matchAll(DYNAMIC_IMPORT)) {
    const base = contextDir(m[1], fromDir);
    if (base === 'unbounded') return 'unbounded';
    if (base === null) continue;
    for (const f of files) {
      if ((base === '' || f.startsWith(`${base}/`)) && isCode(f)) edges.push({ from, to: f, dynamic: true });
    }
  }
  return edges;
}

/** Resolve a `../a/b/` style prefix against a source file's directory, without fs. */
const normalizeDir = (fromDir: string, prefix: string): string => canonicalPath(`${fromDir}/${prefix}`);

/** Reverse-import adjacency (`imported → importers`) plus recovered context edges; `'all'` when an unbounded dynamic import taints it. */
function buildReverseGraph(
  graph: Iterable<ModuleEdge>,
  files: string[],
  read: (p: string) => string | undefined,
): Map<string, Set<string>> | 'all' {
  const rev = new Map<string, Set<string>>();
  const link = (e: ModuleEdge) => rev.set(e.to, (rev.get(e.to) ?? new Set()).add(e.from));
  for (const e of graph) if (isSource(e.from) && isSource(e.to)) link(e);
  for (const f of files) {
    const src = isCode(f) ? read(f) : undefined;
    if (src === undefined) continue;
    const extra = recoverContextEdges(f, src, files);
    if (extra === 'unbounded') return 'all';
    extra.forEach(link);
  }
  return rev;
}

/**
 * The declared surfaces a change could have altered, or `'all'`. Any surface not
 * in the returned set is provably unaffected and may reuse its committed base map.
 */
export function affectedSurfaces(input: AffectedSurfacesInput): AffectedSurfaces {
  // Every path goes through one spelling; `readFile` is keyed on the caller's
  // ORIGINAL spellings, so resolve a canonical path back before reading.
  const files = [...input.files];
  const canonFiles = files.map((f) => canonicalPath(f));
  const originalByCanon = new Map<string, string>();
  for (const orig of [...files, ...input.changedFiles]) {
    const c = canonicalPath(orig);
    if (!originalByCanon.has(c)) originalByCanon.set(c, orig);
  }
  const changed = [...input.changedFiles].map(canonicalPath);
  const surfaces = Object.fromEntries(Object.entries(input.surfaces).map(([k, f]) => [k, canonicalPath(f)]));
  const graph = [...input.graph].map((e) => ({ ...e, from: canonicalPath(e.from), to: canonicalPath(e.to) }));
  const read = (canon: string): string | undefined => safeRead(input.readFile, originalByCanon.get(canon) ?? canon);

  // 1. A style change that escapes its importers forces a full re-capture.
  if (changed.some((f) => isStyleOrCode(f) && classifyCanon(f, read) === 'all')) return 'all';

  // 2. Reverse reachability (+ recovered context edges; unbounded dynamic → all).
  const rev = buildReverseGraph(graph, canonFiles, read);
  if (rev === 'all') return 'all';

  // 3. Map each changed file to the surfaces that transitively import it.
  const entryFiles = new Set(Object.values(surfaces));
  // An entry path in neither `files` nor any graph edge is unplaceable: reverse
  // reachability could never route a change to it, so fail closed.
  const placeable = new Set<string>([...canonFiles, ...graph.flatMap((e) => [e.from, e.to])]);
  if ([...entryFiles].some((f) => !placeable.has(f))) return 'all';

  const affectedFiles = new Set<string>();
  for (const f of changed) {
    const reach = reverseReach(f, rev);
    if (reach.size === 0 && !entryFiles.has(f)) return 'all';
    for (const src of [f, ...reach]) affectedFiles.add(src);
  }
  return new Set(
    Object.entries(surfaces)
      .filter(([, file]) => affectedFiles.has(file))
      .map(([key]) => key),
  );
}

/** A changed file whose kind participates in style scope (stylesheet, code, or config). */
const isStyleOrCode = (f: string) => isStyleSheet(f) || isCode(f) || isConfig(f);

/** {@link classifyStyleChange} against a reader that returns `undefined` for a missing
 *  file (rather than throwing), matching the reverse-graph reader shape. */
function classifyCanon(file: string, read: (p: string) => string | undefined): 'scope' | 'all' {
  return classifyStyleChange(file, (p) => {
    const src = read(p);
    if (src == null) throw new Error('unreadable');
    return src;
  });
}

function reverseReach(file: string, rev: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [file];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const importer of rev.get(cur) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        stack.push(importer);
      }
    }
  }
  return seen;
}

/**
 * Render an {@link affectedSurfaces} verdict as lines a pre-push hook or CI log
 * can print. `allSurfaces` names what is reused from base; `reason` optionally
 * explains an `'all'` verdict.
 */
export function explainAffectedSurfaces(
  result: AffectedSurfaces,
  allSurfaces: Iterable<string>,
  reason?: string,
): string {
  const all = [...allSurfaces].sort();
  if (result === 'all') {
    const why = reason ? ` — ${reason}` : '';
    return [
      `selective remap: OFF → re-capture all ${all.length} surface(s)${why}`,
      ...all.map((k) => `  ↻ ${k} (re-capture)`),
    ].join('\n');
  }
  const recapture = [...result].sort();
  const reused = all.filter((k) => !result.has(k));
  return [
    `selective remap: ON → re-capture ${recapture.length}, reuse ${reused.length} from base`,
    ...recapture.map((k) => `  ↻ ${k} (re-capture — a changed file reaches it)`),
    ...reused.map((k) => `  ✓ ${k} (reuse base map — no changed file reaches it)`),
  ].join('\n');
}
