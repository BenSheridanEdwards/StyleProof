/**
 * Selective remap: given the files a change touched, which declared surfaces
 * could have rendered differently?
 *
 * This is the sound core behind "capture only what a PR can affect, reuse the
 * committed base map for the rest" — an OPT-IN speed-up, never the default gate.
 * The default gate captures every surface and lets the map be the oracle; this
 * function only decides which surfaces a caller *may* skip, and it is built to
 * be wrong only in the safe direction.
 *
 * The hard constraint: in the committed-map model a wrong "unaffected" is silent
 * and fatal — a stale committed map matches the base, the diff is empty, and the
 * regression ships green. So this function OVER-APPROXIMATES. When it cannot
 * prove a surface is unaffected, it returns the sentinel `'all'`, meaning
 * "re-capture everything." Every uncertainty resolves to `'all'`:
 *
 *   - a global style change (a reset, `:root`/theme token, `@tailwind`, a
 *     `createGlobalStyle`, a design-system config) cascades everywhere → `'all'`;
 *   - a vanilla (non-module) stylesheet has a global class namespace the import
 *     graph cannot bound → `'all'`;
 *   - a computed dynamic `import(x)` with no static prefix could load anything
 *     → `'all'`; with a static prefix (`import(`../dir/${x}`)`) it is treated as
 *     a bundler context module — every file under that dir is a possible target;
 *   - a changed file the graph cannot place at all → `'all'`.
 *
 * The module graph is an INPUT, not a dependency: pass any tool's output in the
 * {@link ModuleEdge} shape (dependency-cruiser's `modules[].dependencies[]` maps
 * directly). StyleProof stays framework-agnostic and adds no dependency; the
 * caller owns graph production, which is where framework-specific resolution
 * lives.
 *
 * Pure and side-effect-free (I/O is injected via `readFile`) so it is fully
 * unit-testable and deterministic.
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

// A stylesheet whose scope escapes the file that imports it. Any of these means
// a change cascades beyond the import graph's reach.
const GLOBAL_CSS = /(^|\})\s*(:root|html|body|\*)[\s,{]|@tailwind\b|@layer\s+base\b|@theme\b|@font-face\b/;
// CSS-in-JS global APIs. NOTE: soundness depends on this list being complete for
// the libraries in use — an unlisted global API in a .tsx would be misread as a
// scoped (local) change. Extend deliberately; when unsure, the caller should
// treat the styling system as unsupported and skip selective remap.
const CSSJS_GLOBAL = /\b(createGlobalStyle|injectGlobal|globalStyle|globalCss|createGlobalTheme)\b/;
// `:global(...)` escape hatch or cross-module composition pulls in outside scope.
const MODULE_ESCAPES = /:global\b|\bcompose[sd]?\b[^;]*\bfrom\b/;
// Sass `@use`/`@forward`/`@import` pull another sheet's members into a CSS-module
// file. dependency-cruiser parses JS imports, not Sass loads, so the import graph
// can't bound them — fail closed on any occurrence. `@import` covers both the Sass
// partial load (`@import "vars"`, whose members — possibly global rules — merge in
// exactly like `@use`) and the plain-CSS pass-through form (`@import url(x.css)`,
// `@import "sheet.css"`): a CSS `@import` composes an external sheet whose selectors
// are NOT hashed into the module's per-file scope, so it escapes the module too.
// Either way the change is unbounded → 'all'. Only widen; never narrows a verdict.
const SASS_LOAD = /@(?:use|forward|import)\b/;

const isConfig = (f: string) =>
  /(?:^|\/)(?:tailwind|postcss|theme|tokens?|panda|uno)\.config\.[cm]?[jt]s$/.test(f) ||
  /(?:^|\/)theme\.[cm]?[jt]s$/.test(f);
const isStyleSheet = (f: string) => /\.(css|scss|sass|less|styl)$/.test(f);
const isCssModule = (f: string) => /\.module\.(css|scss|sass|less|styl)$/.test(f);
const isCode = (f: string) => /\.[cm]?[jt]sx?$/.test(f);

/**
 * Decide whether a single changed file's style scope is bounded to the files
 * that import it (`'scope'` → follow the import graph) or escapes them
 * (`'all'` → re-capture everything). Sound by construction: `'scope'` is
 * returned only for provably-scoped changes (a CSS Module without escapes, or
 * colocated CSS-in-JS with no global API); everything else, including anything
 * unrecognized, is `'all'`.
 */
export function classifyStyleChange(file: string, readFile: (p: string) => string): 'scope' | 'all' {
  if (isConfig(file)) return 'all'; // design-system config cascades to every surface
  let src: string;
  try {
    src = readFile(file);
  } catch {
    return 'all'; // cannot read → cannot prove local
  }
  if (src == null) return 'all';
  if (isCode(file)) return CSSJS_GLOBAL.test(src) ? 'all' : 'scope'; // .tsx: global CSS-in-JS or colocated scope
  if (isStyleSheet(file)) {
    if (isCssModule(file)) {
      // Hashed per-file scope — but `:global`, cross-module `composes … from`,
      // genuinely global selectors (`:root`, `html`, `@font-face`, …), and any
      // `@use`/`@forward`/`@import` load (Sass partial or plain-CSS sheet) escape it.
      return MODULE_ESCAPES.test(src) || GLOBAL_CSS.test(src) || SASS_LOAD.test(src) ? 'all' : 'scope';
    }
    return 'all'; // vanilla stylesheet: global class namespace, import graph can't bound it
  }
  return 'all'; // unknown file kind → fail closed
}

// `import(` with a non-string-literal argument, capturing the argument text.
const DYNAMIC_IMPORT = /import\(\s*([^)]+?)\s*\)/g;

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isSource = (p: string) => !p.includes('node_modules');

/**
 * Canonicalize a repo-relative path so the same file spells the same regardless
 * of source (a `surfaces` value, a `changedFiles` entry, or a graph edge). Two
 * tools disagree on `./pages/Home.tsx` vs `pages/Home.tsx` vs `pages//Home.tsx`;
 * without one spelling, a reverse-reachability hit can silently miss the surface
 * whose entry key was spelled differently, dropping it from the affected set —
 * an unsound skip. Byte-cheap and fs-free: strip a leading `./`, collapse `//`,
 * and drop `.`/`..` segments as pure string math (no realpath, no resolution). */
export function canonicalPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function link(rev: Map<string, Set<string>>, to: string, from: string): void {
  let s = rev.get(to);
  if (!s) rev.set(to, (s = new Set()));
  s.add(from);
}

/** Read a source file, mapping any throw/nullish result to `undefined`. */
function safeRead(readFile: (p: string) => string, path: string): string | undefined {
  try {
    return readFile(path) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one computed `import()` argument to the directory its bundler context
 * module is rooted at: `null` for a plain string literal (the resolver already
 * captured it), `'unbounded'` when there is no static directory prefix (target
 * could be any file), else the normalized directory.
 */
function contextDir(arg: string, fromDir: string): string | null | 'unbounded' {
  if (/^['"]/.test(arg)) return null; // plain string literal
  const prefix = arg.match(/^`([^$`]*)/)?.[1]; // static head of a template literal
  if (!prefix || !prefix.includes('/')) return 'unbounded'; // e.g. import(name)
  return normalizeDir(fromDir, prefix);
}

/**
 * Recover computed `import()`s the graph resolver dropped, as bundler context
 * modules. Returns extra edges to add, or `'unbounded'` if any dynamic import
 * has no static directory prefix (its target could be any file → the whole
 * reachability is untrustworthy → caller must return `'all'`).
 */
function recoverContextEdges(from: string, src: string, files: string[]): ModuleEdge[] | 'unbounded' {
  const edges: ModuleEdge[] = [];
  const fromDir = dirOf(from);
  for (const m of src.matchAll(DYNAMIC_IMPORT)) {
    const base = contextDir(m[1], fromDir);
    if (base === 'unbounded') return 'unbounded';
    if (base === null) continue;
    for (const f of files) if (dirOf(f) === base && isCode(f)) edges.push({ from, to: f, dynamic: true });
  }
  return edges;
}

// Resolve a `../a/b/` style prefix against a source file's directory, without fs.
function normalizeDir(fromDir: string, prefix: string): string {
  const parts = (fromDir ? fromDir.split('/') : []).concat(prefix.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/**
 * Build the reverse-import adjacency (`imported → importers`) from the graph plus
 * recovered context-module edges. `'all'` when an unbounded dynamic import makes
 * the whole reachability untrustworthy. Paths are already canonical; `read`
 * resolves a canonical path back to the caller's spelling before reading.
 */
function buildReverseGraph(
  graph: Iterable<ModuleEdge>,
  files: string[],
  read: (p: string) => string | undefined,
): Map<string, Set<string>> | 'all' {
  const rev = new Map<string, Set<string>>();
  for (const e of graph) if (isSource(e.from) && isSource(e.to)) link(rev, e.to, e.from);
  for (const f of files) {
    const src = isCode(f) ? read(f) : undefined;
    if (src === undefined) continue;
    const extra = recoverContextEdges(f, src, files);
    if (extra === 'unbounded') return 'all';
    for (const e of extra) link(rev, e.to, e.from);
  }
  return rev;
}

/**
 * Compute the set of declared surfaces a change could have altered, or `'all'`.
 * See the module doc for the soundness contract. Any not in the returned set are
 * provably unaffected and may reuse their committed base map.
 */
export function affectedSurfaces(input: AffectedSurfacesInput): AffectedSurfaces {
  // Canonicalize every path (surfaces values, changedFiles, graph from/to, files)
  // through one spelling up front, so a `./`-prefixed or `//`-collapsed path from
  // one source can't silently miss a match against another source's spelling.
  // `readFile` is keyed on the caller's ORIGINAL spellings, so wrap it to resolve
  // a canonical path back to the original it came from before reading.
  const changed = [...input.changedFiles].map((f) => canonicalPath(f));
  const files = [...input.files];
  const canonFiles = files.map((f) => canonicalPath(f));
  const originalByCanon = new Map<string, string>();
  files.forEach((orig, i) => originalByCanon.set(canonFiles[i], orig));
  [...input.changedFiles].forEach((orig) => {
    const c = canonicalPath(orig);
    if (!originalByCanon.has(c)) originalByCanon.set(c, orig);
  });
  const surfaces = Object.fromEntries(Object.entries(input.surfaces).map(([k, f]) => [k, canonicalPath(f)]));
  const graph = [...input.graph].map((e) => ({ ...e, from: canonicalPath(e.from), to: canonicalPath(e.to) }));
  const read = (canon: string): string | undefined => safeRead(input.readFile, originalByCanon.get(canon) ?? canon);

  // 1. A style change that escapes its importers forces a full re-capture.
  if (changed.some((f) => isStyleOrCode(f) && classifyCanon(f, read) === 'all')) return 'all';

  // 2. Reverse reachability (+ recovered context edges; unbounded dynamic → all).
  const rev = buildReverseGraph(graph, canonFiles, read);
  if (rev === 'all') return 'all';

  // 3. Map each changed file to the surfaces that transitively import it.
  const entryToKey = new Map(Object.entries(surfaces).map(([k, f]) => [f, k]));

  // A surface whose entry path appears in neither `files` nor any graph edge is
  // unplaceable: reverse reachability can never route a change to it, so a genuine
  // hit would be dropped silently. Same fail-closed rule as an unplaceable changed
  // file → 'all'.
  const placeable = new Set<string>(canonFiles);
  for (const e of graph) {
    placeable.add(e.from);
    placeable.add(e.to);
  }
  for (const f of Object.values(surfaces)) if (!placeable.has(f)) return 'all';

  const hit = new Set<string>();
  for (const f of changed) {
    const reach = reverseReach(f, rev);
    if (reach.size === 0 && !entryToKey.has(f)) return 'all';
    for (const src of [f, ...reach]) {
      const key = entryToKey.get(src);
      if (key) hit.add(key);
    }
  }
  return hit;
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
 * Render an {@link affectedSurfaces} verdict as human-readable lines a pre-push
 * hook (or CI log) can print, so a reviewer can sanity-check the skip list before
 * trusting it. Pure formatter — no I/O, no graph work.
 *
 * @param result       the value {@link affectedSurfaces} returned.
 * @param allSurfaces  every declared surface key (e.g. `Object.keys(surfaces)`),
 *                     so the helper can name what is *reused from base* — the ones
 *                     the verdict skips — not just what re-captures.
 * @param reason       optional one-line explanation for an `'all'` verdict (e.g.
 *                     the classifying file, from {@link classifyStyleChange}). The
 *                     library doesn't attach a reason to the sentinel, so pass it
 *                     if the caller knows why; omitted, the `'all'` line stands alone.
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
  const hit = new Set(recapture);
  const reused = all.filter((k) => !hit.has(k));
  return [
    `selective remap: ON → re-capture ${recapture.length}, reuse ${reused.length} from base`,
    ...recapture.map((k) => `  ↻ ${k} (re-capture — a changed file reaches it)`),
    ...reused.map((k) => `  ✓ ${k} (reuse base map — no changed file reaches it)`),
  ].join('\n');
}
